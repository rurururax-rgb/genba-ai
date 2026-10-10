/**
 * P1-4 migration（20261012000001_restrict_cost_ledger_invoice_writes.sql）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）に P1-1 → P1-2 → P1-3 → P1-4 を適用し、
 *   実際のロール（anon / authenticated / service_role）に SET ROLE して権限・RLS・関数の動作を確かめる。
 *   本番・Preview の DB には接続しない。この migration は本番に未適用（人間の承認後に適用する）。
 *
 * 関数の所有者はテストでは superuser（RLS も権限も素通りする最悪の条件）。
 * それでも他社のデータに届かないことを確かめる＝関数内の明示的な所属確認だけで分離できていることの確認になる。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_INVOICES_SQL, MIGRATION_COST_LEDGER_ITEMS, MIGRATION_P1_1, MIGRATION_P1_2, MIGRATION_P1_3, MIGRATION_P1_4,
  SUPABASE_STUB_SQL, readMigration, startLocalPostgres, type LocalPostgres,
} from './helpers/local-postgres'

let server: LocalPostgres
let admin: Client // superuser（データの準備と確認だけ。関数の呼び出し・直接の書き込みは必ず権限を落とす）
let userA: Client
let userA2: Client
let userB: Client
let pidA2: number
const pool: Client[] = []

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const USER_NO_COMPANY = randomUUID()
const USER_REMOVED = randomUUID()
let PROJECT_A: string
let PROJECT_A_DELETED: string
let PROJECT_B: string

/** P1-4 適用前からある請求書（既存データ。適用で変わらないこと） */
let LEGACY_ITEM: string

const sha = (n: number) => n.toString(16).padStart(64, '0')

async function setupBase(c: Client) {
  await c.query(SUPABASE_STUB_SQL)
  await c.query(readMigration(MIGRATION_COST_LEDGER_ITEMS))
  await c.query(BASE_INVOICES_SQL)
  await c.query(readMigration(MIGRATION_P1_1))
  await c.query(readMigration(MIGRATION_P1_2))
}

async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)
  return rows
}

/** 請求書テーブルの権限（ロール名・権限の組を並べたもの。ロールバックで元に戻ったかの比較用） */
async function invoiceAcl(c: Client) {
  const { rows } = await c.query(`
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
    FROM pg_class t, aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
    WHERE t.oid = 'public.cost_ledger_invoices'::regclass
    ORDER BY 1, 2`)
  return rows
}

async function newItem(opts: { project?: string; company?: string; actualCost?: string | null } = {}): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO cost_ledger_items (project_id, company_id, name, actual_cost)
     VALUES ($1, $2, 'テスト項目', $3) RETURNING id`,
    [opts.project ?? PROJECT_A, opts.company ?? COMPANY_A, opts.actualCost ?? null],
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

/** actual_cost が請求書の合計と一致する（0件なら NULL） */
async function expectConsistent(itemId: string) {
  const { rows } = await admin.query(`
    SELECT i.actual_cost IS NOT DISTINCT FROM (SELECT sum(v.amount) FROM cost_ledger_invoices v WHERE v.cost_ledger_item_id = i.id) AS ok
    FROM cost_ledger_items i WHERE i.id = $1`, [itemId])
  expect(rows[0].ok).toBe(true)
}

async function invoiceRow(id: string) {
  const { rows } = await admin.query('SELECT amount::text, note, cost_ledger_item_id FROM cost_ledger_invoices WHERE id = $1', [id])
  return rows[0] ?? null
}

async function begin(c: Client, userId: string | null, role = 'authenticated') {
  await c.query('BEGIN')
  await c.query(`SET LOCAL ROLE ${role}`)
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
}

/** 1 リクエスト = 1 トランザクション（PostgREST と同じ）。失敗したら ROLLBACK して例外を投げ直す */
async function as<T>(c: Client, userId: string | null, fn: () => Promise<T>, role = 'authenticated'): Promise<T> {
  await begin(c, userId, role)
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

type Call = () => Promise<unknown>

type RpcResult = {
  invoice: Record<string, unknown> & { id: string }
  item_id: string
  actual_cost: number | null
  invoice_count: number
}

async function rpcInsert(c: Client, itemId: string, amount: string | number, extra: {
  source?: string; sha?: string | null; key?: string | null; vendor?: string | null; note?: string | null
} = {}): Promise<RpcResult> {
  const { rows } = await c.query(
    `SELECT public.cost_ledger_invoice_insert(
       p_item_id => $1, p_amount => $2::numeric, p_note => $3, p_source => $4,
       p_vendor_name => $5, p_document_sha256 => $6, p_idempotency_key => $7::uuid) AS r`,
    [itemId, String(amount), extra.note ?? null, extra.source ?? 'manual', extra.vendor ?? null, extra.sha ?? null, extra.key ?? null])
  return rows[0].r
}

async function rpcUpdate(c: Client, invoiceId: string, patch: Record<string, unknown>): Promise<RpcResult> {
  const { rows } = await c.query('SELECT public.cost_ledger_invoice_update($1, $2::jsonb) AS r', [invoiceId, JSON.stringify(patch)])
  return rows[0].r
}

async function rpcDelete(c: Client, invoiceId: string) {
  const { rows } = await c.query('SELECT public.cost_ledger_invoice_delete($1) AS r', [invoiceId])
  return rows[0].r as { deleted_id: string; item_id: string; actual_cost: number | null; invoice_count: number }
}

/** 自社の項目に RPC で請求書を 1 件登録して、その id を返す */
async function seedInvoice(itemId: string, amount: number, c: Client = userA, user = USER_A): Promise<string> {
  return (await as(c, user, () => rpcInsert(c, itemId, amount))).invoice.id
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
let legacyBefore: unknown[]

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('p14')
  admin = await server.connect('p14')
  await setupBase(admin)
  await admin.query(readMigration(MIGRATION_P1_3))

  for (const u of [USER_A, USER_B, USER_NO_COMPANY, USER_REMOVED]) {
    await admin.query('INSERT INTO auth.users (id) VALUES ($1)', [u])
  }
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($3, $4), ($1, $5)',
    [COMPANY_A, USER_A, COMPANY_B, USER_B, USER_REMOVED])
  const p = async (company: string, deleted = false) => (await admin.query(
    'INSERT INTO projects (company_id, deleted_at) VALUES ($1, $2) RETURNING id', [company, deleted ? new Date() : null])).rows[0].id
  PROJECT_A = await p(COMPANY_A)
  PROJECT_A_DELETED = await p(COMPANY_A, true)
  PROJECT_B = await p(COMPANY_B)

  // 適用前からある請求書（P1-3 適用後の状態: actual_cost は合計どおり）
  LEGACY_ITEM = await newItem({ actualCost: '30000' })
  await admin.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 30000)', [LEGACY_ITEM, PROJECT_A])

  policiesBefore = await policies(admin)
  legacyBefore = (await admin.query('SELECT * FROM cost_ledger_invoices ORDER BY id')).rows
  await admin.query(readMigration(MIGRATION_P1_4))

  userA = await server.connect('p14')
  userA2 = await server.connect('p14')
  userB = await server.connect('p14')
  pidA2 = await backendPid(userA2)
  for (let i = 0; i < 8; i++) pool.push(await server.connect('p14'))
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

// ── migration の適用 ──────────────────────────────────────────

describe('migration の適用', () => {
  it('P1-3 が未適用の DB では何も変えずに止まる（RPC は INVOKER のまま・直接の書き込み権限も残る）', async () => {
    await server.createDatabase('p14_pre')
    const c = await server.connect('p14_pre')
    await setupBase(c)
    const e = await pgError(c.query(readMigration(MIGRATION_P1_4)))
    expect(e.message).toBe('P1-4 precondition failed: apply 20261011000001 first')
    const { rows: [s] } = await c.query(`
      SELECT bool_or(prosecdef) AS definer,
             has_table_privilege('authenticated', 'public.cost_ledger_invoices', 'INSERT') AS can_insert
      FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%'`)
    expect(s).toEqual({ definer: false, can_insert: true })
    await c.end()
  })

  it('RLS ポリシーと既存の請求書を変更しない', async () => {
    expect(await policies(admin)).toEqual(policiesBefore)
    expect((await admin.query('SELECT * FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1 ORDER BY id', [LEGACY_ITEM])).rows)
      .toEqual(legacyBefore)
    expect(await actualCost(LEGACY_ITEM)).toBe('30000')
  })

  it('2回適用しても同じ状態になる', async () => {
    await admin.query(readMigration(MIGRATION_P1_4))
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%' AND prosecdef")
    expect(rows[0].n).toBe(3)
  })

  it('3つの RPC: SECURITY DEFINER・search_path 空・lock_timeout 5s。EXECUTE は authenticated のみ', async () => {
    const { rows } = await admin.query(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'cost_ledger_invoice_%' ORDER BY p.proname`)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r).toMatchObject({
        prosecdef: true, proconfig: ['search_path=""', 'lock_timeout=5s'],
        public_exec: false, anon_exec: false, service_exec: false, auth_exec: true,
      })
    }
  })

  it('請求書テーブル: anon・authenticated・PUBLIC は書き込めず（列単位も）、authenticated は読める。service_role は変えない', async () => {
    const { rows } = await admin.query(`
      SELECT r,
             has_table_privilege(r, 'public.cost_ledger_invoices', 'INSERT, UPDATE, DELETE, TRUNCATE') AS write,
             has_any_column_privilege(r, 'public.cost_ledger_invoices', 'INSERT')
               OR has_any_column_privilege(r, 'public.cost_ledger_invoices', 'UPDATE') AS col_write,
             has_table_privilege(r, 'public.cost_ledger_invoices', 'SELECT') AS read
      FROM unnest(ARRAY['public', 'anon', 'authenticated', 'service_role']) r ORDER BY r`)
    expect(rows).toEqual([
      { r: 'anon', write: false, col_write: false, read: true },
      { r: 'authenticated', write: false, col_write: false, read: true },
      { r: 'public', write: false, col_write: false, read: false },
      { r: 'service_role', write: true, col_write: true, read: true },
    ])
  })
})

// ── 1〜4. 直接の書き込みの拒否 ─────────────────────────────────

describe('直接の書き込み（RPC を通らない）は権限で拒否される', () => {
  it('1. authenticated の直接 INSERT（自社の項目でも）は 42501 で拒否され、何も増えない', async () => {
    const item = await newItem()
    await seedInvoice(item, 10000)
    const e = await pgError(as(userA, USER_A, () => userA.query(
      'INSERT INTO public.cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 5000)', [item, PROJECT_A])))
    expect(e.code).toBe('42501')
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '10000' })
    await expectConsistent(item)
  })

  it('2. authenticated の直接 UPDATE（金額・備考だけでも）は 42501 で拒否され、何も変わらない', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    for (const set of ['amount = 1', "note = 'x'", 'cost_ledger_item_id = cost_ledger_item_id']) {
      const e = await pgError(as(userA, USER_A, () => userA.query(`UPDATE public.cost_ledger_invoices SET ${set} WHERE id = $1`, [inv])))
      expect(e.code).toBe('42501')
    }
    expect(await invoiceRow(inv)).toMatchObject({ amount: '10000', note: null })
    await expectConsistent(item)
  })

  it('3. authenticated の直接 DELETE・TRUNCATE は 42501 で拒否され、何も消えない', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    expect((await pgError(as(userA, USER_A, () => userA.query('DELETE FROM public.cost_ledger_invoices WHERE id = $1', [inv])))).code).toBe('42501')
    expect((await pgError(as(userA, USER_A, () => userA.query('TRUNCATE public.cost_ledger_invoices')))).code).toBe('42501')
    expect(await invoiceRow(inv)).not.toBeNull()
    await expectConsistent(item)
  })

  it('4. anon は INSERT / UPDATE / DELETE / TRUNCATE のどれもできない（ユーザー ID を名乗っても同じ）', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    for (const uid of [null, USER_A]) {
      for (const [sql, params] of [
        ['INSERT INTO public.cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 1)', [item, PROJECT_A]],
        ['UPDATE public.cost_ledger_invoices SET amount = 1 WHERE id = $1', [inv]],
        ['DELETE FROM public.cost_ledger_invoices WHERE id = $1', [inv]],
        ['TRUNCATE public.cost_ledger_invoices', []],
      ] as const) {
        expect((await pgError(as(userA, uid, () => userA.query(sql, [...params]), 'anon'))).code).toBe('42501')
      }
    }
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '10000' })
  })
})

// ── 5〜7. 自社の請求書は RPC で操作できる ──────────────────────

describe('自社の請求書は RPC で登録・編集・削除できる（戻り値・エラーは P1-2 と同じ）', () => {
  it('5. 登録: 手動・OCR とも保存され、actual_cost が合計になる。戻り値の形は P1-2 と同じ', async () => {
    const item = await newItem({ actualCost: '99999' })
    const r1 = await as(userA, USER_A, () => rpcInsert(userA, item, 12000, { note: ' 足場 ' }))
    expect(Object.keys(r1).sort()).toEqual(['actual_cost', 'invoice', 'invoice_count', 'item_id'])
    expect(Object.keys(r1.invoice).sort()).toEqual([
      'amount', 'cost_ledger_item_id', 'created_at', 'id', 'invoice_date', 'invoice_number', 'note', 'payment_date', 'source', 'vendor_name'])
    expect(r1).toMatchObject({ item_id: item, actual_cost: 12000, invoice_count: 1 })
    expect(r1.invoice.note).toBe('足場')
    const r2 = await as(userA, USER_A, () => rpcInsert(userA, item, 3000.5, { source: 'ocr', sha: sha(0x401), key: randomUUID(), vendor: '業者' }))
    expect(r2).toMatchObject({ actual_cost: 15000.5, invoice_count: 2 })
    expect(r2.invoice).toMatchObject({ source: 'ocr', vendor_name: '業者' })
    // project_id はリクエストではなく親の台帳項目から入る
    const { rows } = await admin.query('SELECT DISTINCT project_id FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [item])
    expect(rows).toEqual([{ project_id: PROJECT_A }])
    await expectConsistent(item)
  })

  it('6. 編集: 金額・日付・備考を変更でき、合計が更新される。変更できない列は CL400 のまま', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    await seedInvoice(item, 5000)
    const r = await as(userA, USER_A, () => rpcUpdate(userA, inv, { amount: 7000, note: '変更', invoice_date: '2026-10-01' }))
    expect(r).toMatchObject({ actual_cost: 12000, invoice_count: 2 })
    expect(r.invoice).toMatchObject({ amount: 7000, note: '変更', invoice_date: '2026-10-01' })
    const other = await newItem()
    for (const patch of [{ cost_ledger_item_id: other }, { project_id: PROJECT_B }, { amount: 0 }, {}]) {
      expect((await pgError(as(userA, USER_A, () => rpcUpdate(userA, inv, patch)))).code).toBe('CL400')
    }
    expect(await invoiceRow(inv)).toMatchObject({ amount: '7000', cost_ledger_item_id: item })
    await expectConsistent(item)
  })

  it('7. 削除: 合計が更新され、最後の 1 件で actual_cost は NULL', async () => {
    const item = await newItem()
    const a = await seedInvoice(item, 10000)
    const b = await seedInvoice(item, 5000)
    expect(await as(userA, USER_A, () => rpcDelete(userA, a))).toMatchObject({ deleted_id: a, actual_cost: 5000, invoice_count: 1 })
    expect(await as(userA, USER_A, () => rpcDelete(userA, b))).toMatchObject({ actual_cost: null, invoice_count: 0 })
    expect(await actualCost(item)).toBeNull()
  })

  it('適用前からある請求書（project_id が NULL の既存行を含む）も RPC で編集・削除できる', async () => {
    const item = await newItem({ actualCost: '8000' })
    const { rows: [old] } = await admin.query(
      'INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, NULL, 8000) RETURNING id', [item])
    expect(await as(userA, USER_A, () => rpcUpdate(userA, old.id, { amount: 9000 }))).toMatchObject({ actual_cost: 9000 })
    expect(await as(userA, USER_A, () => rpcDelete(userA, old.id))).toMatchObject({ actual_cost: null })
  })
})

// ── 8〜10. 他社・削除済み・所属なし ──────────────────────────────

describe('他社データの分離（SECURITY DEFINER でも関数内で所属を確かめる）', () => {
  it('8. 他社（B社）のユーザーは A社の請求書を編集・削除できず、存在も区別できない（CL404・何も変わらない）', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    for (const call of <Call[]>[() => rpcUpdate(userB, inv, { amount: 1 }), () => rpcDelete(userB, inv)]) {
      const e = await pgError(as(userB, USER_B, call))
      expect(e).toEqual({ code: 'CL404', message: 'not_found' })
    }
    // 存在しない請求書と同じ応答
    expect(await pgError(as(userB, USER_B, () => rpcDelete(userB, randomUUID())))).toEqual({ code: 'CL404', message: 'not_found' })
    expect(await invoiceRow(inv)).toMatchObject({ amount: '10000' })
    await expectConsistent(item)
  })

  it('9. 他社の台帳項目への登録は CL404 で拒否され、請求書も actual_cost も変わらない', async () => {
    const item = await newItem({ actualCost: '777' })
    for (const extra of [{}, { source: 'ocr', sha: sha(0x901), key: randomUUID() }]) {
      expect(await pgError(as(userB, USER_B, () => rpcInsert(userB, item, 5000, extra)))).toEqual({ code: 'CL404', message: 'not_found' })
    }
    expect(await invoiceTotal(item)).toEqual({ count: 0, total: null })
    expect(await actualCost(item)).toBe('777')
  })

  it('どの会社にも所属しないユーザー・所属を外されたユーザーは、登録・編集・削除のどれもできない', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    // 所属を外す（USER_REMOVED は A社のメンバーだった）
    expect((await as(userA2, USER_REMOVED, () => rpcInsert(userA2, item, 1))).invoice_count).toBe(2)
    await admin.query('DELETE FROM company_members WHERE user_id = $1', [USER_REMOVED])
    for (const user of [USER_NO_COMPANY, USER_REMOVED]) {
      for (const call of <Call[]>[() => rpcInsert(userA2, item, 1), () => rpcUpdate(userA2, inv, { amount: 1 }), () => rpcDelete(userA2, inv)]) {
        expect((await pgError(as(userA2, user, call))).code).toBe('CL404')
      }
    }
    expect(await invoiceTotal(item)).toEqual({ count: 2, total: '10001' })
    await expectConsistent(item)
  })

  it('台帳項目と案件の会社が食い違う行（A社の項目に B社の案件）は、A社・B社どちらからも書けない', async () => {
    const item = await newItem({ project: PROJECT_B, company: COMPANY_A })
    for (const [c, user] of [[userA, USER_A], [userB, USER_B]] as const) {
      expect((await pgError(as(c, user, () => rpcInsert(c, item, 1)))).code).toBe('CL404')
    }
    expect(await invoiceTotal(item)).toEqual({ count: 0, total: null })
  })

  it('自社の項目でも、請求書の project_id が他社の案件を指す行は編集・削除しない（CL409）', async () => {
    const item = await newItem({ actualCost: '100' })
    const { rows: [bad] } = await admin.query(
      'INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 100) RETURNING id', [item, PROJECT_B])
    expect((await pgError(as(userA, USER_A, () => rpcUpdate(userA, bad.id, { amount: 1 })))).code).toBe('CL409')
    expect((await pgError(as(userA, USER_A, () => rpcDelete(userA, bad.id)))).code).toBe('CL409')
    expect(await invoiceRow(bad.id)).toMatchObject({ amount: '100' })
  })

  it('10. 削除済みの案件・削除済みの台帳項目には登録・編集・削除できない（CL404）', async () => {
    const onDeletedProject = await newItem({ project: PROJECT_A_DELETED })
    expect((await pgError(as(userA, USER_A, () => rpcInsert(userA, onDeletedProject, 1)))).code).toBe('CL404')

    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    await admin.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [item])
    for (const call of <Call[]>[() => rpcInsert(userA, item, 1), () => rpcUpdate(userA, inv, { amount: 1 }), () => rpcDelete(userA, inv)]) {
      expect((await pgError(as(userA, USER_A, call))).code).toBe('CL404')
    }

    const item2 = await newItem()
    const inv2 = await seedInvoice(item2, 10000)
    await admin.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [PROJECT_A])
    try {
      for (const call of <Call[]>[() => rpcInsert(userA, item2, 1), () => rpcUpdate(userA, inv2, { amount: 1 }), () => rpcDelete(userA, inv2)]) {
        expect((await pgError(as(userA, USER_A, call))).code).toBe('CL404')
      }
    } finally {
      await admin.query('UPDATE projects SET deleted_at = NULL WHERE id = $1', [PROJECT_A])
    }
    expect(await invoiceTotal(item2)).toEqual({ count: 1, total: '10000' })
  })

  it('未認証（ユーザー ID なし）は CL401。anon・service_role は関数を実行できない（42501）', async () => {
    const item = await newItem()
    const inv = await seedInvoice(item, 10000)
    expect((await pgError(as(userA, null, () => rpcInsert(userA, item, 1)))).code).toBe('CL401')
    for (const role of ['anon', 'service_role']) {
      for (const call of <Call[]>[() => rpcInsert(userA, item, 1), () => rpcUpdate(userA, inv, { amount: 1 }), () => rpcDelete(userA, inv)]) {
        expect((await pgError(as(userA, USER_A, call, role))).code).toBe('42501')
      }
    }
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '10000' })
  })

  it('読み取りは従来どおり RLS で自社分だけ（B社から A社の請求書は見えない）', async () => {
    const item = await newItem()
    await seedInvoice(item, 10000)
    const seenByB = await as(userB, USER_B, () => userB.query('SELECT id FROM public.cost_ledger_invoices WHERE cost_ledger_item_id = $1', [item]))
    expect(seenByB.rows).toEqual([])
    const seenByA = await as(userA, USER_A, () => userA.query('SELECT id FROM public.cost_ledger_invoices WHERE cost_ledger_item_id = $1', [item]))
    expect(seenByA.rows).toHaveLength(1)
  })

  it('一時テーブルで同名の表を作っても、関数は public の表だけを読み書きする（search_path 固定）', async () => {
    const item = await newItem()
    const r = await as(userA, USER_A, async () => {
      await userA.query('CREATE TEMP TABLE cost_ledger_items (id uuid, project_id uuid, company_id uuid, deleted_at timestamptz, actual_cost numeric) ON COMMIT DROP')
      await userA.query('CREATE TEMP TABLE company_members (company_id uuid, user_id uuid) ON COMMIT DROP')
      await userA.query('INSERT INTO pg_temp.company_members VALUES ($1, $2)', [COMPANY_B, USER_A])
      return rpcInsert(userA, item, 4000)
    })
    expect(r).toMatchObject({ actual_cost: 4000, invoice_count: 1 })
    // 一時テーブルで B社の所属を名乗っても B社の項目には書けない
    const itemB = await newItem({ project: PROJECT_B, company: COMPANY_B })
    const e = await pgError(as(userA, USER_A, async () => {
      await userA.query('CREATE TEMP TABLE company_members (company_id uuid, user_id uuid) ON COMMIT DROP')
      await userA.query('INSERT INTO pg_temp.company_members VALUES ($1, $2)', [COMPANY_B, USER_A])
      return rpcInsert(userA, itemB, 1)
    }))
    expect(e.code).toBe('CL404')
    expect(await invoiceTotal(itemB)).toEqual({ count: 0, total: null })
  })
})

// ── 11. 二重登録防止 ───────────────────────────────────────────

describe('11. 二重登録の防止（P1-1 の一意インデックス）を維持する', () => {
  it('同じ idempotency_key の再送は 23505 で、請求書も actual_cost も増えない', async () => {
    const item = await newItem()
    const key = randomUUID()
    await as(userA, USER_A, () => rpcInsert(userA, item, 10000, { source: 'ocr', sha: sha(0xb01), key }))
    const e = await pgError(as(userA, USER_A, () => rpcInsert(userA, item, 10000, { source: 'ocr', sha: sha(0xb01), key })))
    expect(e.code).toBe('23505')
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '10000' })
    await expectConsistent(item)
  })

  it('同じ案件に同じ画像は、別の台帳項目でも 23505', async () => {
    const a = await newItem()
    const b = await newItem()
    await as(userA, USER_A, () => rpcInsert(userA, a, 1000, { source: 'ocr', sha: sha(0xb02), key: randomUUID() }))
    expect((await pgError(as(userA, USER_A, () => rpcInsert(userA, b, 1000, { source: 'ocr', sha: sha(0xb02), key: randomUUID() })))).code).toBe('23505')
    expect(await invoiceTotal(b)).toEqual({ count: 0, total: null })
  })

  it('連打（同じキーを 2 本の接続から同時に送信）: 1 件だけ登録され、もう片方は 23505', async () => {
    const item = await newItem()
    const key = randomUUID()
    const send = (c: Client) => as(c, USER_A, () => rpcInsert(c, item, 2000, { source: 'ocr', sha: sha(0xb03), key }))
      .then(() => 'ok', (e: { code: string }) => e.code)
    const results = await Promise.all([send(pool[0]), send(pool[1])])
    expect(results.sort()).toEqual(['23505', 'ok'])
    expect(await invoiceTotal(item)).toEqual({ count: 1, total: '2000' })
    await expectConsistent(item)
  })
})

// ── 12. 同時実行 ──────────────────────────────────────────────

describe('12. 同時実行（独立した DB 接続で実際にトランザクションを重ねる）', () => {
  it('ロック順は 台帳項目 → 請求書 のまま: 2 本目の登録は 1 本目の親行ロックを待ち、合計は 2 件分', async () => {
    const item = await newItem()
    await begin(userA, USER_A)
    await rpcInsert(userA, item, 1000)
    await begin(userA2, USER_A)
    const pending = rpcInsert(userA2, item, 2000)
    await waitUntilBlocked(pidA2)
    await userA.query('COMMIT')
    const r = await pending
    await userA2.query('COMMIT')
    expect(r).toMatchObject({ actual_cost: 3000, invoice_count: 2 })
    await expectConsistent(item)
  })

  it('登録・編集・削除を 8 本の接続から同時に混ぜても、最後に actual_cost = 請求書の合計', async () => {
    const item = await newItem()
    const seeded: string[] = []
    for (let i = 0; i < 8; i++) seeded.push(await seedInvoice(item, 1000))
    const ops = pool.map((c, i) => async () => {
      for (let k = 0; k < 5; k++) {
        await as(c, USER_A, () => rpcInsert(c, item, 100 + i))
      }
      if (i % 2 === 0) await as(c, USER_A, () => rpcUpdate(c, seeded[i], { amount: 2500 }))
      else await as(c, USER_A, () => rpcDelete(c, seeded[i]))
    })
    await Promise.all(ops.map(f => f()))
    const t = await invoiceTotal(item)
    expect(t.count).toBe(8 * 5 + 4)
    await expectConsistent(item)
  }, 30_000)
})

// ── 13〜14. P1-3 のトリガー ─────────────────────────────────────

describe('P1-3 の actual_cost 保護との組み合わせ', () => {
  it('13. 請求書がある項目の actual_cost を合計以外へ直接変更すると CL423。合計と同じ値なら通る', async () => {
    const item = await newItem()
    await seedInvoice(item, 10000)
    const e = await pgError(as(userA, USER_A, () => userA.query('UPDATE public.cost_ledger_items SET actual_cost = 1 WHERE id = $1', [item])))
    expect(e).toEqual({ code: 'CL423', message: 'actual_cost_locked' })
    expect((await as(userA, USER_A, () => userA.query('UPDATE public.cost_ledger_items SET actual_cost = 10000.00 WHERE id = $1', [item]))).rowCount).toBe(1)
    await expectConsistent(item)
  })

  it('14. 請求書が 0 件の項目は従来どおり actual_cost を直接入力・空にできる（最後の請求書を削除した後も）', async () => {
    const item = await newItem({ actualCost: '50000' })
    expect((await as(userA, USER_A, () => userA.query('UPDATE public.cost_ledger_items SET actual_cost = 42000 WHERE id = $1', [item]))).rowCount).toBe(1)
    const inv = await seedInvoice(item, 3000)
    await as(userA, USER_A, () => rpcDelete(userA, inv))
    expect((await as(userA, USER_A, () => userA.query('UPDATE public.cost_ledger_items SET actual_cost = NULL WHERE id = $1', [item]))).rowCount).toBe(1)
    expect((await as(userA, USER_A, () => userA.query('UPDATE public.cost_ledger_items SET actual_cost = 1234 WHERE id = $1', [item]))).rowCount).toBe(1)
    expect(await actualCost(item)).toBe('1234')
  })

  it('台帳項目の削除（請求書ごと消える）・actual_cost 以外の列の変更は従来どおりできる', async () => {
    const item = await newItem()
    await seedInvoice(item, 10000)
    expect((await as(userA, USER_A, () => userA.query("UPDATE public.cost_ledger_items SET name = '名称変更' WHERE id = $1", [item]))).rowCount).toBe(1)
    expect((await as(userA, USER_A, () => userA.query('DELETE FROM public.cost_ledger_items WHERE id = $1', [item]))).rowCount).toBe(1)
    expect(await invoiceTotal(item)).toEqual({ count: 0, total: null })
  })
})

// ── 15. 読み取り API の互換 ─────────────────────────────────────

describe('15. 既存の読み取り（原価台帳一覧・内訳・件数）は従来どおり', () => {
  it('API と同じ SELECT（内訳の列・件数・keyset ページング）が authenticated で動く', async () => {
    const item = await newItem()
    for (let i = 0; i < 3; i++) await seedInvoice(item, 1000 + i)
    const r = await as(userA, USER_A, async () => ({
      list: (await userA.query(`
        SELECT id, cost_ledger_item_id, amount, invoice_date, payment_date, note, source, vendor_name, invoice_number, created_at
        FROM public.cost_ledger_invoices WHERE cost_ledger_item_id = $1 ORDER BY created_at`, [item])).rows,
      count: (await userA.query('SELECT count(*)::int AS n FROM public.cost_ledger_invoices WHERE cost_ledger_item_id = $1', [item])).rows[0].n,
      page: (await userA.query(`
        SELECT id, cost_ledger_item_id FROM public.cost_ledger_invoices
        WHERE cost_ledger_item_id = ANY($1::uuid[]) AND id > $2 ORDER BY id LIMIT 2`, [[item], '00000000-0000-0000-0000-000000000000'])).rows,
      items: (await userA.query('SELECT id, actual_cost FROM public.cost_ledger_items WHERE id = $1', [item])).rows,
      byKey: (await userA.query('SELECT id FROM public.cost_ledger_invoices WHERE idempotency_key = $1', [randomUUID()])).rows,
    }))
    expect(r.list).toHaveLength(3)
    expect(r.count).toBe(3)
    expect(r.page).toHaveLength(2)
    expect(r.items).toHaveLength(1)
    expect(r.byKey).toEqual([])
  })
})

// ── SQL Editor 用の適用・ロールバックスクリプト（docs/db/p1-4-sql-editor-*.sql） ──

describe('SQL Editor 用スクリプト（1 トランザクションでの適用と migration 履歴）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const APPLY = readFileSync(path.join(DOCS, 'p1-4-sql-editor-apply.sql'), 'utf8')
  const ROLLBACK = readFileSync(path.join(DOCS, 'p1-4-sql-editor-rollback.sql'), 'utf8')
  // P1-2・P1-3 は SQL Editor で履歴つきで適用済み（本番と同じ前提）
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
      ('20261010000002', 'atomic_cost_ledger_invoice_writes'), ('20261011000001', 'lock_actual_cost_with_invoices');`
  const APPLIED = [{ history_rows: '1', definer_rpcs: '3', direct_write_roles: '0' }]
  const NONE = [{ history_rows: '0', definer_rpcs: '0', direct_write_roles: '2' }]

  let dbSeq = 0
  /** P1-4 未適用の DB（SQL Editor で適用する前の本番に相当） */
  async function freshDb(opts: { history?: string | null } = {}) {
    const name = `p14_editor_${++dbSeq}`
    await server.createDatabase(name)
    const c = await server.connect(name)
    await setupBase(c)
    await c.query(readMigration(MIGRATION_P1_3))
    if (opts.history !== null) await c.query(opts.history ?? HISTORY_SQL)
    return c
  }
  async function history(c: Client) {
    const { rows } = await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261012000001'")
    return rows
  }
  async function state(c: Client) {
    const { rows } = await c.query(`
      SELECT (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%' AND prosecdef) AS definer,
             has_table_privilege('authenticated', 'public.cost_ledger_invoices', 'INSERT') AS auth_insert`)
    return rows[0] as { definer: number; auth_insert: boolean }
  }
  async function fnSources(c: Client) {
    const { rows } = await c.query(`
      SELECT p.proname, md5(p.prosrc) AS src, p.prosecdef, p.proconfig, p.proacl::text AS acl
      FROM pg_proc p WHERE p.proname LIKE 'cost_ledger_invoice_%' ORDER BY p.proname`)
    return rows
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
  const UNCHANGED = { definer: 0, auth_insert: true }

  it('適用スクリプトの本体は migration ファイルと、ロールバックの本体は P1-2 の migration と完全に一致する', () => {
    const body = (sql: string, marker: string) => {
      const start = sql.indexOf(`-- >>> ${marker}\n`)
      const end = sql.lastIndexOf(`-- <<< ${marker}`)
      expect(start).toBeGreaterThan(0)
      return sql.slice(start + `-- >>> ${marker}\n`.length, end)
    }
    expect(body(APPLY, 'MIGRATION BODY')).toBe(readMigration(MIGRATION_P1_4))
    expect(body(ROLLBACK, 'P1-2 MIGRATION BODY')).toBe(readMigration(MIGRATION_P1_2))
    expect(readMigration(MIGRATION_P1_4)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    for (const sql of [APPLY, ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('成功時: 関数の変更・権限の取り消し・履歴がそろって確定する。トランザクションは閉じている', async () => {
    const c = await freshDb()
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261012000001', name: 'restrict_cost_ledger_invoice_writes' }])
    expect(await state(c)).toEqual({ definer: 3, auth_insert: false })
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)
    await c.end()
  })

  it('二度目の実行はガードで止まり、何も変わらない', async () => {
    const c = await freshDb()
    await runScript(c, APPLY)
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-4 apply aborted: version 20261012000001 is already recorded')
    expect(await history(c)).toHaveLength(1)
    await c.end()
  })

  it('P1-3 の履歴が無ければ何もせずに止まる', async () => {
    const c = await freshDb({
      history: `CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text);
        INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261010000002');`,
    })
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-4 apply aborted: version 20261011000001 (P1-3) is not recorded')
    expect(await state(c)).toEqual(UNCHANGED)
    await c.end()
  })

  it('請求書テーブルの権限が想定（Supabase の既定）と違えば止まる（ロールバックで正確に戻せないため）', async () => {
    for (const tweak of [
      'REVOKE TRUNCATE ON public.cost_ledger_invoices FROM anon',
      'GRANT INSERT ON public.cost_ledger_invoices TO PUBLIC',
      'GRANT UPDATE (note) ON public.cost_ledger_invoices TO authenticated',
    ]) {
      const c = await freshDb()
      await c.query(tweak)
      const e = await runScriptExpectingError(c, APPLY)
      expect(e.message).toMatch(/^P1-4 apply aborted: unexpected (table|column-level) privileges/)
      expect(await history(c)).toHaveLength(0)
      expect((await state(c)).definer).toBe(0)
      await c.end()
    }
  })

  it('RPC が履歴なしで既に SECURITY DEFINER なら置き換えずに止まる', async () => {
    const c = await freshDb()
    await c.query(readMigration(MIGRATION_P1_4))
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('P1-4 apply aborted: RPC is already SECURITY DEFINER (history is missing)')
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('最後の履歴登録で失敗しても、関数の変更・権限の取り消しごと取り消される', async () => {
    const c = await freshDb({
      history: `CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, required_extra text);
        INSERT INTO supabase_migrations.schema_migrations (version, required_extra) VALUES ('20261010000002', 'x'), ('20261011000001', 'x');
        ALTER TABLE supabase_migrations.schema_migrations ALTER COLUMN required_extra SET NOT NULL;`,
    })
    const before = await fnSources(c)
    const aclBefore = await invoiceAcl(c)
    const e = await pgError(c.query(APPLY))
    expect(e.code).toBe('23502')
    const commit = await c.query('COMMIT')
    expect(commit.command).toBe('ROLLBACK')
    expect(await fnSources(c)).toEqual(before)
    expect(await invoiceAcl(c)).toEqual(aclBefore)
    await c.end()
  })

  it('テーブルロックを取らない: 別の接続が請求書・台帳項目をロック中でも待たずに適用でき、相手のトランザクションも止めない', async () => {
    const c = await freshDb()
    const holder = await server.connect(c.database!)
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.cost_ledger_invoices, public.cost_ledger_items IN ACCESS EXCLUSIVE MODE')
    const started = Date.now()
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(Date.now() - started).toBeLessThan(5000)
    await holder.query('COMMIT')
    await holder.end()
    expect(await state(c)).toEqual({ definer: 3, auth_insert: false })
    await c.end()
  }, 30_000)

  it('ロールバックスクリプト: 関数を P1-2 の定義に、権限を適用前に戻し、履歴を消す。データ・RLS・P1-3 は残る', async () => {
    const c = await freshDb()
    const company = randomUUID()
    await c.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'X'])
    const { rows: [p] } = await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [company])
    const { rows: [item] } = await c.query(
      "INSERT INTO cost_ledger_items (project_id, company_id, name, actual_cost) VALUES ($1, $2, 'x', 10000) RETURNING id", [p.id, company])
    await c.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 10000)', [item.id, p.id])
    const fnBefore = await fnSources(c)
    const aclBefore = await invoiceAcl(c)
    const policiesBeforeApply = await policies(c)

    await runScript(c, APPLY)
    expect(await fnSources(c)).not.toEqual(fnBefore)
    expect(await runScript(c, ROLLBACK)).toEqual(NONE)
    expect(await fnSources(c)).toEqual(fnBefore)
    expect(await invoiceAcl(c)).toEqual(aclBefore)
    expect(await policies(c)).toEqual(policiesBeforeApply)
    expect(await history(c)).toHaveLength(0)
    const { rows: [after] } = await c.query(`
      SELECT (SELECT count(*)::int FROM cost_ledger_invoices) AS invoices,
             (SELECT actual_cost::text FROM cost_ledger_items WHERE id = $1) AS actual,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost') AS p13_trigger`, [item.id])
    expect(after).toEqual({ invoices: 1, actual: '10000', p13_trigger: 1 })

    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('P1-4 rollback aborted: nothing to roll back (no history row, RPC is not SECURITY DEFINER)')
    // ロールバック後は適用スクリプトをもう一度実行できる
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })
})
