/**
 * P1-3 migration（20261011000001_lock_actual_cost_with_invoices.sql）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）に実際の migration を適用して確かめる。
 *   本番・Preview の DB には接続しない。この migration は本番に未適用（人間の承認後に適用する）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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

// ── SQL Editor 用の適用・ロールバックスクリプト（docs/db/p1-3-sql-editor-*.sql） ──

describe('SQL Editor 用スクリプト（1 トランザクションでの適用と migration 履歴）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const APPLY = readFileSync(path.join(DOCS, 'p1-3-sql-editor-apply.sql'), 'utf8')
  const ROLLBACK = readFileSync(path.join(DOCS, 'p1-3-sql-editor-rollback.sql'), 'utf8')
  // Supabase CLI の履歴テーブルの代用。P1-2 は SQL Editor で履歴つきで適用済み（本番と同じ前提）
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261010000002', 'atomic_cost_ledger_invoice_writes');`
  const APPLIED = [{ history_rows: '1', triggers: '1', functions: '1' }]
  const NONE = [{ history_rows: '0', triggers: '0', functions: '0' }]

  let dbSeq = 0
  /** P1-3 未適用の DB（SQL Editor で適用する前の本番に相当） */
  async function freshDb(opts: { history?: string | null; withP1_2?: boolean } = {}) {
    const name = `p13_editor_${++dbSeq}`
    await server.createDatabase(name)
    const c = await server.connect(name)
    await setupBase(c)
    if (opts.withP1_2 !== false) await c.query(readMigration(MIGRATION_P1_2))
    if (opts.history !== null) await c.query(opts.history ?? HISTORY_SQL)
    return c
  }
  async function history(c: Client) {
    const { rows } = await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261011000001'")
    return rows
  }
  async function objects(c: Client) {
    const { rows } = await c.query(`
      SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal) AS triggers,
             (SELECT count(*)::int FROM pg_proc WHERE proname = 'cost_ledger_items_lock_actual_cost') AS functions`)
    return rows[0] as { triggers: number; functions: number }
  }
  /** 全文を 1 回のクエリ（simple query protocol・複数文）で送る */
  async function runScript(c: Client, sql: string) {
    const res = await c.query(sql)
    const results = Array.isArray(res) ? res : [res]
    return results[results.length - 1].rows
  }
  /** 失敗したら、SQL Editor で案内しているとおり ROLLBACK だけを送る */
  async function runScriptExpectingError(c: Client, sql: string) {
    const e = await pgError(c.query(sql))
    await c.query('ROLLBACK')
    return e
  }
  /** 請求書 1 件（10,000 円）がある項目。actual_cost は合計どおり */
  async function seedItem(c: Client) {
    const company = randomUUID()
    await c.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'X'])
    const { rows: [p] } = await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [company])
    const { rows: [item] } = await c.query(
      "INSERT INTO cost_ledger_items (project_id, company_id, name, actual_cost) VALUES ($1, $2, 'x', 10000) RETURNING id", [p.id, company])
    await c.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 10000)', [item.id, p.id])
    return item.id as string
  }

  it('適用スクリプトの migration 本体は migration ファイルと完全に一致する（ずれ防止）', () => {
    const start = APPLY.indexOf('-- >>> MIGRATION BODY\n')
    const end = APPLY.lastIndexOf('-- <<< MIGRATION BODY')
    expect(start).toBeGreaterThan(0)
    expect(APPLY.slice(start + '-- >>> MIGRATION BODY\n'.length, end)).toBe(readMigration(MIGRATION_P1_3))
    // migration ファイル自体はトランザクション制御を持たない（CLI の実行方法と衝突させない）
    expect(readMigration(MIGRATION_P1_3)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    // 適用・ロールバックとも 1 トランザクション（BEGIN と COMMIT が 1 回ずつ）
    for (const sql of [APPLY, ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('成功時: 関数・トリガー・履歴がそろって確定し、トリガーが効く。トランザクションは閉じている', async () => {
    const c = await freshDb()
    const item = await seedItem(c)
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261011000001', name: 'lock_actual_cost_with_invoices' }])
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)
    // 権限: アプリのロールはトリガー関数を直接実行できない
    const { rows: [priv] } = await c.query(`
      SELECT has_function_privilege('anon', 'public.cost_ledger_items_lock_actual_cost()', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.cost_ledger_items_lock_actual_cost()', 'EXECUTE') AS auth`)
    expect(priv).toEqual({ anon: false, auth: false })
    expect((await pgError(c.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [item]))).code).toBe('CL423')
    await c.end()
  })

  it('二度目の実行はガードで止まり、何も変わらない（二重登録しない）', async () => {
    const c = await freshDb()
    await runScript(c, APPLY)
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-3 apply aborted: version 20261011000001 is already recorded')
    expect(await history(c)).toHaveLength(1)
    expect(await objects(c)).toEqual({ triggers: 1, functions: 1 })
    await c.end()
  })

  it('P1-2 の履歴が無ければ何もせずに止まる', async () => {
    const c = await freshDb({
      history: `CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text);`,
    })
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-3 apply aborted: version 20261010000002 (P1-2) is not recorded')
    expect(await objects(c)).toEqual({ triggers: 0, functions: 0 })
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('途中失敗（migration の事前条件: RPC が無い）: 関数もトリガーも履歴も残らない', async () => {
    const c = await freshDb({ withP1_2: false }) // 履歴だけあって実体が無い
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-3 precondition failed: apply 20261010000002 first')
    expect(await objects(c)).toEqual({ triggers: 0, functions: 0 })
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('最後の履歴登録で失敗しても、作成済みの関数・トリガーごと取り消される', async () => {
    // 履歴テーブルに想定外の必須列がある場合を再現（INSERT が最後の段階で失敗する）
    const c = await freshDb({
      history: `CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, required_extra text);
        INSERT INTO supabase_migrations.schema_migrations (version, required_extra) VALUES ('20261010000002', 'x');
        ALTER TABLE supabase_migrations.schema_migrations ALTER COLUMN required_extra SET NOT NULL;`,
    })
    const other = await server.connect(c.database!)
    const pending = c.query(APPLY).then(() => 'ok', (err: { code: string }) => err.code)
    expect(await pending).toBe('23502') // not_null_violation
    expect(await objects(other)).toEqual({ triggers: 0, functions: 0 })
    // エラーの後も実行を続けて COMMIT まで届いた場合: 失敗したトランザクションの COMMIT は ROLLBACK になる
    const commit = await c.query('COMMIT')
    expect(commit.command).toBe('ROLLBACK')
    expect(await objects(c)).toEqual({ triggers: 0, functions: 0 })
    expect((await c.query("SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations WHERE version = '20261011000001'")).rows[0].n).toBe(0)
    await other.end()
    await c.end()
  })

  it('関数・トリガーはあるのに履歴が無い状態では置き換えずに止まる', async () => {
    const c = await freshDb()
    await c.query(readMigration(MIGRATION_P1_3)) // 履歴を残さずに実体だけ作られた状態
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-3 apply aborted: cost_ledger_items_lock_actual_cost already exists (history is missing)')
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('cost_ledger_items のロックが取れなければ 5 秒で諦め、何も残らない', async () => {
    const c = await freshDb()
    const holder = await server.connect(c.database!)
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.cost_ledger_items IN ROW EXCLUSIVE MODE') // 書き込み中のトランザクション
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.code).toBe('55P03')
    await holder.query('ROLLBACK')
    await holder.end()
    expect(await objects(c)).toEqual({ triggers: 0, functions: 0 })
    expect(await history(c)).toHaveLength(0)
    expect(await runScript(c, APPLY)).toEqual(APPLIED) // 時間をおいて再実行できる
    await c.end()
  }, 30_000)

  it('履歴テーブルに name 列が無くても version だけで登録する。履歴テーブルが無ければ止まる', async () => {
    const c = await freshDb({
      history: `CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
        INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261010000002');`,
    })
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()

    const d = await freshDb({ history: null })
    const e = await runScriptExpectingError(d, APPLY)
    expect(e.message).toBe('P1-3 apply aborted: supabase_migrations.schema_migrations not found')
    expect(await objects(d)).toEqual({ triggers: 0, functions: 0 })
    await d.end()
  })

  it('ロールバックスクリプト: トリガー・関数・履歴を一緒に消し、データ・RLS・P1-2 は残る。二度目は止まる', async () => {
    const c = await freshDb()
    const item = await seedItem(c)
    await runScript(c, APPLY)
    const before = await policies(c)

    expect(await runScript(c, ROLLBACK)).toEqual(NONE)
    expect(await objects(c)).toEqual({ triggers: 0, functions: 0 })
    expect(await policies(c)).toEqual(before)
    const { rows: [after] } = await c.query(`
      SELECT (SELECT count(*)::int FROM cost_ledger_invoices) AS invoices,
             (SELECT actual_cost::text FROM cost_ledger_items WHERE id = $1) AS actual,
             (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%') AS rpcs,
             (SELECT count(*)::int FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') AS p12_history`, [item])
    expect(after).toEqual({ invoices: 1, actual: '10000', rpcs: 3, p12_history: 1 })
    // トリガーが無くなったので直接変更は DB では止まらない（アプリ側の確認だけに戻る）
    expect((await c.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [item])).rowCount).toBe(1)

    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('P1-3 rollback aborted: nothing to roll back (no history row, no trigger, no function)')
    // ロールバック後は適用スクリプトをもう一度実行できる
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })
})
