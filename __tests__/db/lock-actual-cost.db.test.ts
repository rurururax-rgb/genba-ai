/**
 * P1-3 migration（20261011000001_lock_actual_cost_with_invoices.sql）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）に実際の migration を適用して確かめる。
 *   本番・Preview の DB には接続しない。この migration は本番に未適用（人間の承認後に適用する）。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_INVOICES_SQL, MIGRATION_COST_LEDGER_ITEMS, MIGRATION_P1_1, MIGRATION_P1_2, MIGRATION_P1_3,
  SUPABASE_STUB_SQL, readMigration, startLocalPostgres, type LocalPostgres,
} from './helpers/local-postgres'

let server: LocalPostgres
let admin: Client
let userA: Client
let userA2: Client
let pidA: number
let pidA2: number

const COMPANY_A = randomUUID()
const USER_A = randomUUID()
let PROJECT_A: string

/** migration 適用前からある項目（請求書があるのに actual_cost が合計とずれている既存データ） */
let LEGACY_ITEM: string

async function setupBase(c: Client) {
  await c.query(SUPABASE_STUB_SQL)
  await c.query(readMigration(MIGRATION_COST_LEDGER_ITEMS))
  await c.query(BASE_INVOICES_SQL)
  await c.query(readMigration(MIGRATION_P1_1))
}

async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)
  return rows
}

async function newItem(actualCost: string | null = null): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO cost_ledger_items (project_id, company_id, name, actual_cost)
     VALUES ($1, $2, 'テスト項目', $3) RETURNING id`,
    [PROJECT_A, COMPANY_A, actualCost],
  )
  return rows[0].id
}

async function actualCost(itemId: string): Promise<string | null> {
  const { rows } = await admin.query('SELECT actual_cost::text AS v FROM cost_ledger_items WHERE id = $1', [itemId])
  return rows[0].v
}

async function invoiceTotal(itemId: string): Promise<{ count: number; total: string | null }> {
  const { rows } = await admin.query(
    'SELECT count(*)::int AS count, sum(amount)::text AS total FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [itemId])
  return rows[0]
}

async function begin(c: Client, userId: string | null, role = 'authenticated') {
  await c.query('BEGIN')
  await c.query(`SET LOCAL ROLE ${role}`)
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
}

async function asUser<T>(c: Client, fn: () => Promise<T>, role = 'authenticated'): Promise<T> {
  await begin(c, USER_A, role)
  try {
    const r = await fn()
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code: string; message: string }
    return { code: err.code, message: err.message }
  }
  throw new Error('expected an error')
}

/** PostgREST の PATCH /cost_ledger_items?id=eq.… と同じ直接 UPDATE（RLS が効く） */
async function directUpdate(c: Client, itemId: string, set: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(set)
  const sql = `UPDATE public.cost_ledger_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`
  const r = await c.query(sql, [itemId, ...keys.map(k => set[k])])
  return r.rowCount ?? 0
}

async function rpcInsert(c: Client, itemId: string, amount: string | number) {
  const { rows } = await c.query(
    'SELECT public.cost_ledger_invoice_insert(p_item_id => $1, p_amount => $2::numeric) AS r', [itemId, String(amount)])
  return rows[0].r as { invoice: { id: string }; actual_cost: number | null; invoice_count: number }
}

async function backendPid(c: Client): Promise<number> {
  const { rows } = await c.query('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}

async function waitUntilBlocked(pid: number, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { rows } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])
    if (rows.length > 0) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`backend ${pid} did not block on a lock`)
}

let policiesBefore: unknown[]
let legacyBefore: string | null

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('p13')
  admin = await server.connect('p13')
  await setupBase(admin)
  await admin.query(readMigration(MIGRATION_P1_2))

  await admin.query('INSERT INTO auth.users (id) VALUES ($1)', [USER_A])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [COMPANY_A, 'A社'])
  await admin.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)', [COMPANY_A, USER_A])
  const { rows } = await admin.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [COMPANY_A])
  PROJECT_A = rows[0].id

  // 既存の不整合データ: 請求書 30,000 円があるのに actual_cost は見積原価の 100,000 円のまま
  LEGACY_ITEM = await newItem('100000')
  await admin.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 30000)', [LEGACY_ITEM, PROJECT_A])

  policiesBefore = await policies(admin)
  legacyBefore = await actualCost(LEGACY_ITEM)
  await admin.query(readMigration(MIGRATION_P1_3))

  userA = await server.connect('p13')
  userA2 = await server.connect('p13')
  // ロック待ちの接続では次のクエリが送れないので、PID は先に取っておく
  pidA = await backendPid(userA)
  pidA2 = await backendPid(userA2)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

describe('migration の適用', () => {
  it('RPC（20261010000002）が無い DB では何も作らずに止まる', async () => {
    await server.createDatabase('p13_pre')
    const c = await server.connect('p13_pre')
    await setupBase(c)
    const e = await pgError(c.query(readMigration(MIGRATION_P1_3)))
    expect(e.message).toContain('apply 20261010000002 first')
    const { rows } = await c.query("SELECT to_regprocedure('public.cost_ledger_items_lock_actual_cost()') AS f")
    expect(rows[0].f).toBeNull()
  })

  it('RLS ポリシーと既存データを変更しない（不整合な既存データもそのまま）', async () => {
    expect(await policies(admin)).toEqual(policiesBefore)
    expect(await actualCost(LEGACY_ITEM)).toBe(legacyBefore)
    expect(legacyBefore).toBe('100000')
  })

  it('2回適用してもエラーにならない（トリガーは1つだけ）', async () => {
    await admin.query(readMigration(MIGRATION_P1_3))
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal")
    expect(rows[0].n).toBe(1)
  })

  it('トリガー関数は SECURITY DEFINER・search_path 固定で、どのロールからも直接実行できない', async () => {
    const { rows: [f] } = await admin.query(`
      SELECT p.prosecdef, p.proconfig FROM pg_proc p
      WHERE p.oid = 'public.cost_ledger_items_lock_actual_cost()'::regprocedure`)
    expect(f.prosecdef).toBe(true)
    expect(f.proconfig).toEqual(['search_path=""'])
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await admin.query(
        "SELECT has_function_privilege($1, 'public.cost_ledger_items_lock_actual_cost()', 'EXECUTE') AS ok", [role])
      expect(rows[0].ok).toBe(false)
    }
  })
})

describe('請求書が0件の項目（直接入力を維持）', () => {
  it('actual_cost を直接変更・空にできる', async () => {
    const item = await newItem('50000')
    expect(await asUser(userA, () => directUpdate(userA, item, { actual_cost: '42000' }))).toBe(1)
    expect(await actualCost(item)).toBe('42000')
    expect(await asUser(userA, () => directUpdate(userA, item, { actual_cost: null }))).toBe(1)
    expect(await actualCost(item)).toBeNull()
  })
})

describe('請求書がある項目（直接変更を拒否）', () => {
  it('合計と異なる値・NULL への直接 UPDATE は CL423 で拒否され、値は変わらない', async () => {
    const item = await newItem('100000')
    await asUser(userA, () => rpcInsert(userA, item, 30000))
    for (const v of ['99999', '0', null]) {
      const e = await pgError(asUser(userA, () => directUpdate(userA, item, { actual_cost: v })))
      expect(e).toMatchObject({ code: 'CL423', message: 'actual_cost_locked' })
    }
    // 他の列と一緒に送っても、UPDATE 全体が取り消される
    const e = await pgError(asUser(userA, () => directUpdate(userA, item, { name: '変更', actual_cost: '1' })))
    expect(e.code).toBe('CL423')
    const { rows } = await admin.query('SELECT name FROM cost_ledger_items WHERE id = $1', [item])
    expect(rows[0].name).toBe('テスト項目')
    expect(await actualCost(item)).toBe('30000')
  })

  it('service_role（RLS を回避するロール）からの直接 UPDATE も拒否される', async () => {
    const item = await newItem()
    await asUser(userA, () => rpcInsert(userA, item, 12000))
    const e = await pgError(asUser(userA, () => directUpdate(userA, item, { actual_cost: '1' }), 'service_role'))
    expect(e.code).toBe('CL423')
    expect(await actualCost(item)).toBe('12000')
  })

  it('合計と同じ値（表記違いを含む）への UPDATE は通る', async () => {
    const item = await newItem()
    await asUser(userA, () => rpcInsert(userA, item, '0.1'))
    await asUser(userA, () => rpcInsert(userA, item, '0.2'))
    expect(await asUser(userA, () => directUpdate(userA, item, { actual_cost: '0.30' }))).toBe(1)
  })

  it('actual_cost 以外の列だけの UPDATE は、既存の不整合データでも通る', async () => {
    expect(await asUser(userA, () => directUpdate(userA, LEGACY_ITEM, { name: '名前変更', budget_cost: '80000', note: 'メモ' }))).toBe(1)
    // actual_cost を同じ値のまま SET しても（変化なし）トリガーは動かない
    expect(await asUser(userA, () => directUpdate(userA, LEGACY_ITEM, { actual_cost: '100000' }))).toBe(1)
    expect(await actualCost(LEGACY_ITEM)).toBe('100000')
    // 不整合な値を別の不整合な値へは変えられない
    const e = await pgError(asUser(userA, () => directUpdate(userA, LEGACY_ITEM, { actual_cost: '90000' })))
    expect(e.code).toBe('CL423')
  })
})

describe('RPC はトリガーがあっても動く', () => {
  it('登録・編集・削除で actual_cost が合計に更新され、最後の1件を削除すると直接入力に戻る', async () => {
    const item = await newItem('70000')
    const a = await asUser(userA, () => rpcInsert(userA, item, 20000))
    const b = await asUser(userA, () => rpcInsert(userA, item, 5000))
    expect(b.actual_cost).toBe(25000)

    await asUser(userA, () => userA.query('SELECT public.cost_ledger_invoice_update($1, $2::jsonb)', [a.invoice.id, '{"amount": 21000}']))
    expect(await actualCost(item)).toBe('26000')

    await asUser(userA, () => userA.query('SELECT public.cost_ledger_invoice_delete($1)', [a.invoice.id]))
    expect(await actualCost(item)).toBe('5000')
    await asUser(userA, () => userA.query('SELECT public.cost_ledger_invoice_delete($1)', [b.invoice.id]))
    expect(await actualCost(item)).toBeNull()

    expect(await asUser(userA, () => directUpdate(userA, item, { actual_cost: '64000' }))).toBe(1)
    expect(await actualCost(item)).toBe('64000')
  })

  it('既存の不整合データも、RPC で請求書を操作すると合計に揃う', async () => {
    await asUser(userA, () => rpcInsert(userA, LEGACY_ITEM, 1000))
    expect(await actualCost(LEGACY_ITEM)).toBe('31000')
  })
})

describe('同時操作', () => {
  it('RPC が登録中（未コミット）に直接 UPDATE → ロック待ち → コミット後に CL423 で拒否', async () => {
    const item = await newItem('40000') // 請求書0件。直接 UPDATE の時点のアプリ確認では「変更可」に見える状態
    await begin(userA2, USER_A)
    await rpcInsert(userA2, item, 15000)

    await begin(userA, USER_A)
    const pending = pgError(directUpdate(userA, item, { actual_cost: '99999' }))
    await waitUntilBlocked(pidA)
    await userA2.query('COMMIT')

    const e = await pending
    await userA.query('ROLLBACK')
    expect(e.code).toBe('CL423')
    expect(await actualCost(item)).toBe('15000')
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '15000' })
  })

  it('直接 UPDATE（請求書0件・未コミット）中に RPC 登録 → RPC はロック待ち → 最終的に合計へ揃う', async () => {
    const item = await newItem('40000')
    await begin(userA, USER_A)
    expect(await directUpdate(userA, item, { actual_cost: '38000' })).toBe(1)

    await begin(userA2, USER_A)
    const pending = rpcInsert(userA2, item, 15000)
    await waitUntilBlocked(pidA2)
    await userA.query('COMMIT')
    const r = await pending
    await userA2.query('COMMIT')

    expect(r.actual_cost).toBe(15000)
    expect(await actualCost(item)).toBe('15000')
  })
})

describe('この migration で防げないもの（残るリスクの記録）', () => {
  it('cost_ledger_invoices への直接 INSERT（RPC を通らない）は actual_cost を再集計しない', async () => {
    const item = await newItem()
    await asUser(userA, () => rpcInsert(userA, item, 10000))
    await asUser(userA, () => userA.query(
      'INSERT INTO public.cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 5000)', [item, PROJECT_A]))
    // 内訳合計は 15,000 円になるが actual_cost は 10,000 円のまま（ずれる）
    expect(await invoiceTotal(item)).toEqual({ count: 2, total: '15000' })
    expect(await actualCost(item)).toBe('10000')
    // ただし、この状態から任意の値への直接変更はできない（合計への修正だけ可能）
    expect((await pgError(asUser(userA, () => directUpdate(userA, item, { actual_cost: '1' })))).code).toBe('CL423')
    expect(await asUser(userA, () => directUpdate(userA, item, { actual_cost: '15000' }))).toBe(1)
  })
})
