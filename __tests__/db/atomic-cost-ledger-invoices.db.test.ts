/**
 * P1-2 migration（20261010000002_atomic_cost_ledger_invoice_writes.sql）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL 17（embedded-postgres）を起動し、実際の migration ファイルを適用して検証する。
 *   本番・Preview の DB には接続しない。
 *   同時実行のテストは、独立した複数の DB 接続（別々のバックエンドプロセス）で実際にトランザクションを重ねる。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_INVOICES_SQL, MIGRATION_COST_LEDGER_ITEMS, MIGRATION_P1_1, MIGRATION_P1_2,
  SUPABASE_STUB_SQL, readMigration, startLocalPostgres, type LocalPostgres,
} from './helpers/local-postgres'

// ── 準備 ──────────────────────────────────────────────────────

let server: LocalPostgres
let admin: Client // superuser（データの準備と確認だけに使う。関数の呼び出しは必ず権限を落とす）

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const USER_NO_COMPANY = randomUUID()
let PROJECT_A: string
let PROJECT_A_DELETED: string
let PROJECT_B: string

const sha = (n: number) => n.toString(16).padStart(64, '0')

async function setupDatabase(c: Client, opts: { withP1_1?: boolean; withP1_2?: boolean } = {}) {
  await c.query(SUPABASE_STUB_SQL)
  await c.query(readMigration(MIGRATION_COST_LEDGER_ITEMS))
  await c.query(BASE_INVOICES_SQL)
  if (opts.withP1_1 !== false) await c.query(readMigration(MIGRATION_P1_1))
  if (opts.withP1_2 !== false) await c.query(readMigration(MIGRATION_P1_2))
}

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('p12')
  admin = await server.connect('p12')

  // migration 適用前の RLS ポリシーを記録してから適用する
  await setupDatabase(admin, { withP1_2: false })
  policiesBefore = await policies(admin)
  await admin.query(readMigration(MIGRATION_P1_2))

  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [USER_A, USER_B, USER_NO_COMPANY])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($3, $4)', [COMPANY_A, USER_A, COMPANY_B, USER_B])
  PROJECT_A = await newProject(COMPANY_A)
  PROJECT_A_DELETED = await newProject(COMPANY_A, true)
  PROJECT_B = await newProject(COMPANY_B)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

let policiesBefore: unknown[]
async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)
  return rows
}

async function newProject(companyId: string, deleted = false): Promise<string> {
  const { rows } = await admin.query(
    'INSERT INTO projects (company_id, deleted_at) VALUES ($1, $2) RETURNING id',
    [companyId, deleted ? new Date().toISOString() : null],
  )
  return rows[0].id
}

/** 台帳項目を作る。actual_cost は見積原価の初期値・直接入力値を想定 */
async function newItem(projectId: string, companyId: string, actualCost: string | null = null, deleted = false): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO cost_ledger_items (project_id, company_id, name, actual_cost, deleted_at)
     VALUES ($1, $2, 'テスト項目', $3, $4) RETURNING id`,
    [projectId, companyId, actualCost, deleted ? new Date().toISOString() : null],
  )
  return rows[0].id
}

/** 台帳項目の状態（numeric は文字列のまま比べる。浮動小数点を経由しない） */
async function state(itemId: string) {
  const { rows: [item] } = await admin.query(
    'SELECT actual_cost::text AS actual_cost, updated_at FROM cost_ledger_items WHERE id = $1', [itemId])
  const { rows: [sum] } = await admin.query(
    'SELECT count(*)::int AS count, sum(amount)::text AS total FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [itemId])
  return { actualCost: item.actual_cost as string | null, count: sum.count as number, total: sum.total as string | null }
}

/** 内訳の件数・合計と actual_cost が整合しているか（0件なら NULL） */
async function expectConsistent(itemId: string) {
  const s = await state(itemId)
  if (s.count === 0) expect(s.actualCost).toBeNull()
  else expect(numEq(s.actualCost, s.total)).toBe(true)
  return s
}

const numEq = (a: string | null, b: string | null) => a !== null && b !== null && Number(a) === Number(b) && trimZeros(a) === trimZeros(b)
const trimZeros = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v)

async function backendPid(c: Client): Promise<number> {
  const { rows } = await c.query('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}

/** 指定の接続がロック待ちになるまで待つ（実際に待っていることを pg_stat_activity で確かめる） */
async function waitUntilBlocked(pid: number, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { rows } = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])
    if (rows.length > 0) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`backend ${pid} did not block on a lock`)
}

/** ユーザーとしてトランザクションを開始する（Supabase の authenticated と同じ状態） */
async function begin(c: Client, userId: string | null, role = 'authenticated') {
  await c.query('BEGIN')
  await c.query(`SET LOCAL ROLE ${role}`)
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
}

/** 1トランザクションで実行してコミット（失敗したらロールバックして例外をそのまま投げる） */
async function asUser<T>(c: Client, userId: string | null, fn: () => Promise<T>, role = 'authenticated'): Promise<T> {
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

type InsertArgs = {
  item: string; amount: string | number; source?: 'ocr' | 'manual' | null
  invoice_date?: string | null; payment_date?: string | null; note?: string | null
  vendor?: string | null; number?: string | null; sha?: string | null; key?: string | null
}

type RpcResult = {
  invoice: Record<string, unknown>
  item_id: string
  actual_cost: number | null
  invoice_count: number
}

async function rpcInsert(c: Client, a: InsertArgs): Promise<RpcResult> {
  const { rows } = await c.query(
    `SELECT public.cost_ledger_invoice_insert(
       p_item_id => $1, p_amount => $2::numeric, p_invoice_date => $3::date, p_payment_date => $4::date,
       p_note => $5, p_source => $6, p_vendor_name => $7, p_invoice_number => $8,
       p_document_sha256 => $9, p_idempotency_key => $10::uuid) AS r`,
    [a.item, String(a.amount), a.invoice_date ?? null, a.payment_date ?? null, a.note ?? null,
      a.source === undefined ? 'manual' : a.source, a.vendor ?? null, a.number ?? null, a.sha ?? null, a.key ?? null],
  )
  return rows[0].r
}

async function rpcUpdate(c: Client, invoiceId: string, patch: unknown): Promise<RpcResult> {
  const { rows } = await c.query('SELECT public.cost_ledger_invoice_update($1, $2::jsonb) AS r', [invoiceId, JSON.stringify(patch)])
  return rows[0].r
}

async function rpcDelete(c: Client, invoiceId: string): Promise<{ deleted_id: string; item_id: string; actual_cost: number | null; invoice_count: number }> {
  const { rows } = await c.query('SELECT public.cost_ledger_invoice_delete($1) AS r', [invoiceId])
  return rows[0].r
}

/** PostgreSQL のエラー（SQLSTATE と本文） */
async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string; detail?: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code: string; message: string; detail?: string }
    return { code: err.code, message: err.message, detail: err.detail }
  }
  throw new Error('expected an error')
}

let userA: Client
let userA2: Client
let userB: Client
beforeAll(async () => {
  userA = await server.connect('p12')
  userA2 = await server.connect('p12')
  userB = await server.connect('p12')
})

// ── 1・2 登録と合計 ─────────────────────────────────────────

describe('登録', () => {
  it('1. 初回の登録で actual_cost が内訳合計になる（見積原価の初期値を置き換える）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A, '100000')
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 30000, invoice_date: '2026-10-01', note: '  手すり  ' }))
    expect(r.actual_cost).toBe(30000)
    expect(r.invoice_count).toBe(1)
    expect(r.item_id).toBe(item)
    expect(r.invoice).toMatchObject({
      cost_ledger_item_id: item, amount: 30000, invoice_date: '2026-10-01', payment_date: null,
      note: '手すり', source: 'manual', vendor_name: null, invoice_number: null,
    })
    // 応答に画像ハッシュ・idempotency_key・project_id は含めない
    expect(Object.keys(r.invoice).sort()).toEqual(
      ['amount', 'cost_ledger_item_id', 'created_at', 'id', 'invoice_date', 'invoice_number', 'note', 'payment_date', 'source', 'vendor_name'])
    const s = await expectConsistent(item)
    expect(s).toMatchObject({ actualCost: '30000', count: 1 })
    // project_id は親の台帳項目から入る
    const { rows } = await admin.query('SELECT project_id FROM cost_ledger_invoices WHERE id = $1', [r.invoice.id])
    expect(rows[0].project_id).toBe(PROJECT_A)
  })

  it('2. 2件目の登録で合計が加算される（NUMERIC で計算し、小数の誤差を持ち込まない）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: '0.1' }))
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: '0.2' }))
    expect(r.invoice_count).toBe(2)
    const s = await expectConsistent(item)
    expect(s.actualCost).toBe('0.3') // JavaScript の 0.1 + 0.2 = 0.30000000000000004 にならない

    const big = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: big, amount: '999999999999.99' }))
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: big, amount: '0.01' }))
    expect((await expectConsistent(big)).actualCost).toBe('1000000000000.00')
  })

  it('12. マイナス請求（値引・返品）は登録でき、合計から差し引かれる。0円は拒否', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 10000 }))
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: -2500, note: '値引' }))
    expect(r.actual_cost).toBe(7500)
    // 合計がマイナスになる場合もそのまま（現行 API と同じ）
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: -9000 }))
    expect((await expectConsistent(item)).actualCost).toBe('-1500')

    for (const amount of ['0', '0.00', '1000000000000', '-1000000000000']) {
      const e = await pgError(asUser(userA, USER_A, () => rpcInsert(userA, { item, amount })))
      expect(e).toMatchObject({ code: 'CL400', message: 'invalid_input' })
    }
    expect((await state(item)).count).toBe(3)
  })

  it('入力の検証は現行 POST API と同じ（OCR はハッシュとキーが必須・手動はハッシュ不可・長さの上限）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const bad: InsertArgs[] = [
      { item, amount: 1, source: 'ocr', sha: null, key: randomUUID() },
      { item, amount: 1, source: 'ocr', sha: sha(1), key: null },
      { item, amount: 1, source: 'ocr', sha: 'A'.repeat(64), key: randomUUID() },
      { item, amount: 1, source: 'manual', sha: sha(1) },
      { item, amount: 1, source: 'unknown' as 'ocr' },
      { item, amount: 1, note: 'あ'.repeat(501) },
      { item, amount: 1, source: 'ocr', sha: sha(2), key: randomUUID(), vendor: 'x'.repeat(201) },
      { item, amount: 1, source: 'ocr', sha: sha(3), key: randomUUID(), number: 'x'.repeat(101) },
    ]
    for (const a of bad) {
      const e = await pgError(asUser(userA, USER_A, () => rpcInsert(userA, a))).catch(err => ({ code: String(err), message: '' }))
      expect(e.code, JSON.stringify({ ...a, item: undefined })).toBe('CL400')
    }
    expect(await state(item)).toMatchObject({ count: 0, actualCost: null })

    // 手動登録には OCR の読み取り情報を持たせない（現行 API と同じ）。空白だけの備考は NULL
    const m = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 5, vendor: '業者', number: 'No.1', note: '   ' }))
    expect(m.invoice).toMatchObject({ vendor_name: null, invoice_number: null, note: null, source: 'manual' })
    // source 省略（NULL）は手動扱い
    const n = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 5, source: null }))
    expect(n.invoice.source).toBe('manual')
  })

  it('値は SQL として解釈されない（文字列はそのまま保存される）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const note = "'); DELETE FROM cost_ledger_invoices; --"
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1, note }))
    expect(r.invoice.note).toBe(note)
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM cost_ledger_invoices')
    expect(rows[0].n).toBeGreaterThan(1)
  })
})

// ── 4・5 既存の一意制約 ─────────────────────────────────────

describe('既存の一意制約（P1-1）を維持する', () => {
  it('4. 同じ案件に同じ画像の OCR 登録は、別の台帳項目でも 23505 で拒否され、何も変わらない', async () => {
    const item1 = await newItem(PROJECT_A, COMPANY_A)
    const item2 = await newItem(PROJECT_A, COMPANY_A, '500')
    const doc = sha(0xabc)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: item1, amount: 1000, source: 'ocr', sha: doc, key: randomUUID(), vendor: 'A工業' }))
    const before = await state(item2)
    const e = await pgError(asUser(userA, USER_A, () => rpcInsert(userA, { item: item2, amount: 1000, source: 'ocr', sha: doc, key: randomUUID() })))
    expect(e.code).toBe('23505')
    expect(await state(item2)).toEqual(before) // actual_cost も更新日時も変わらない
    expect(await state(item1)).toMatchObject({ count: 1, actualCost: '1000' })

    // 別の案件なら同じ画像を登録できる
    const otherProject = await newProject(COMPANY_A)
    const item3 = await newItem(otherProject, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: item3, amount: 1000, source: 'ocr', sha: doc, key: randomUUID() }))
    await expectConsistent(item3)
  })

  it('5. 同じ idempotency_key は 23505 で拒否され、請求書も actual_cost も増えない', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const key = randomUUID()
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 4000, key }))
    const before = await state(item)
    const e = await pgError(asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 4000, key })))
    expect(e.code).toBe('23505')
    expect(await state(item)).toEqual(before)
    expect(before).toMatchObject({ count: 1, actualCost: '4000' })
  })

  it('5b. 同じキーの同時送信（別の台帳項目）: 後の方は先の確定を待って 23505。actual_cost は片方だけ', async () => {
    const item1 = await newItem(PROJECT_A, COMPANY_A)
    const item2 = await newItem(PROJECT_A, COMPANY_A)
    const key = randomUUID()
    await begin(userA, USER_A)
    await rpcInsert(userA, { item: item1, amount: 700, key })
    await begin(userA2, USER_A)
    const pid = await backendPid(userA2)
    const second = pgError(rpcInsert(userA2, { item: item2, amount: 700, key }))
    await waitUntilBlocked(pid) // 一意インデックスの確定待ち
    await userA.query('COMMIT')
    expect((await second).code).toBe('23505')
    await userA2.query('ROLLBACK')
    expect(await state(item1)).toMatchObject({ count: 1, actualCost: '700' })
    expect(await state(item2)).toMatchObject({ count: 0, actualCost: null })
  })
})

// ── 6・7・8 編集と削除 ──────────────────────────────────────

describe('編集・削除', () => {
  it('6. 金額の変更後に合計が一致する。日付・備考だけの変更でも合計は変わらない', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000, note: '元', invoice_date: '2026-09-01' }))
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 2000 }))
    const r = await asUser(userA, USER_A, () => rpcUpdate(userA, a.invoice.id as string, { amount: 1500.5 }))
    expect(r.actual_cost).toBe(3500.5)
    expect(r.invoice).toMatchObject({ amount: 1500.5, note: '元', invoice_date: '2026-09-01' }) // 含まれないキーは変えない
    await expectConsistent(item)

    const r2 = await asUser(userA, USER_A, () => rpcUpdate(userA, a.invoice.id as string, { note: null, invoice_date: '2026-09-30', payment_date: '' }))
    expect(r2.invoice).toMatchObject({ amount: 1500.5, note: null, invoice_date: '2026-09-30', payment_date: null })
    expect((await expectConsistent(item)).actualCost).toBe('3500.5')
  })

  it('6b. 変更できない列・不正な値は何も変えずに CL400（別の台帳項目への移動はできない）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const other = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000, note: '元' }))
    const id = a.invoice.id as string
    const before = await admin.query('SELECT * FROM cost_ledger_invoices WHERE id = $1', [id])
    const bad: unknown[] = [
      { cost_ledger_item_id: other },
      { amount: 2000, cost_ledger_item_id: other },
      { project_id: PROJECT_B },
      { source: 'ocr' },
      { document_sha256: sha(9) },
      { idempotency_key: randomUUID() },
      { id: randomUUID() },
      {},
      [],
      'amount',
      { amount: 0 },
      { amount: '2000' },        // 文字列の数値は受け付けない
      { amount: null },
      { amount: 1e12 },
      { invoice_date: '2026-02-30' },
      { invoice_date: '2026/10/01' },
      { payment_date: 20261001 },
      { note: 'あ'.repeat(501) },
      { note: 1 },
    ]
    for (const patch of bad) {
      const e = await pgError(asUser(userA, USER_A, () => rpcUpdate(userA, id, patch)))
      expect(e, JSON.stringify(patch)).toMatchObject({ code: 'CL400', message: 'invalid_input' })
    }
    const after = await admin.query('SELECT * FROM cost_ledger_invoices WHERE id = $1', [id])
    expect(after.rows).toEqual(before.rows)
    expect(await state(other)).toMatchObject({ count: 0, actualCost: null })
    expect((await expectConsistent(item)).actualCost).toBe('1000')
  })

  it('7. 削除後に合計が一致する', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 2345 }))
    const r = await asUser(userA, USER_A, () => rpcDelete(userA, a.invoice.id as string))
    expect(r).toMatchObject({ deleted_id: a.invoice.id, item_id: item, actual_cost: 2345, invoice_count: 1 })
    await expectConsistent(item)
  })

  it('8. 最後の請求書を削除すると actual_cost は NULL（登録前の初期値には戻らない＝現行仕様）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A, '88000')
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    const r = await asUser(userA, USER_A, () => rpcDelete(userA, a.invoice.id as string))
    expect(r).toMatchObject({ actual_cost: null, invoice_count: 0 })
    expect(await state(item)).toMatchObject({ actualCost: null, count: 0 })
    // もう一度削除すると not_found
    const e = await pgError(asUser(userA, USER_A, () => rpcDelete(userA, a.invoice.id as string)))
    expect(e).toMatchObject({ code: 'CL404', message: 'not_found' })
  })
})

// ── 9 途中失敗のロールバック ────────────────────────────────

describe('9. 途中で失敗したら請求書の変更も原価の変更も取り消される', () => {
  beforeAll(async () => {
    // テスト専用: 再集計（親行の UPDATE）だけを失敗させるトリガー
    await admin.query(`
      CREATE FUNCTION test_fail_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.fail_recalc', true) = 'on' THEN
          RAISE EXCEPTION 'simulated recalc failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_recalc BEFORE UPDATE ON cost_ledger_items
        FOR EACH ROW EXECUTE FUNCTION test_fail_recalc();`)
  })
  afterAll(async () => {
    await admin.query('DROP TRIGGER test_fail_recalc ON cost_ledger_items; DROP FUNCTION test_fail_recalc();')
  })

  async function failing<T>(fn: () => Promise<T>) {
    return pgError(asUser(userA, USER_A, async () => {
      await userA.query("SELECT set_config('test.fail_recalc', 'on', true)")
      return fn()
    }))
  }

  it('登録: 再集計が失敗すると請求書も残らない（同じキーで再送すれば登録できる）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A, '100000')
    const key = randomUUID()
    const before = await state(item)
    const e = await failing(() => rpcInsert(userA, { item, amount: 5000, key }))
    expect(e.message).toBe('simulated recalc failure')
    expect(await state(item)).toEqual(before)
    const { rows } = await admin.query('SELECT 1 FROM cost_ledger_invoices WHERE idempotency_key = $1', [key])
    expect(rows).toHaveLength(0)
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 5000, key }))
    expect(r.actual_cost).toBe(5000)
  })

  it('編集・削除: 再集計が失敗すると請求書の変更も取り消される', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    const id = a.invoice.id as string
    const before = await state(item)
    expect((await failing(() => rpcUpdate(userA, id, { amount: 9999 }))).message).toBe('simulated recalc failure')
    expect(await state(item)).toEqual(before)
    expect((await failing(() => rpcDelete(userA, id))).message).toBe('simulated recalc failure')
    expect(await state(item)).toEqual(before)
    expect(before).toMatchObject({ count: 1, actualCost: '1000' })
  })
})

// ── 10・11 権限 ─────────────────────────────────────────────

describe('権限・RLS', () => {
  it('10. 他社のユーザーは登録・編集・削除できず、存在も区別できない（CL404）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A, '100')
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000, note: 'A社の請求' }))
    const id = a.invoice.id as string
    const before = await admin.query('SELECT * FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1 ORDER BY id', [item])
    const beforeState = await state(item)

    for (const call of [
      () => rpcInsert(userB, { item, amount: 1 }),
      () => rpcUpdate(userB, id, { amount: 1 }),
      () => rpcDelete(userB, id),
    ]) {
      await begin(userB, USER_B)
      const e = await pgError(call())
      await userB.query('ROLLBACK')
      expect(e).toMatchObject({ code: 'CL404', message: 'not_found' })
      expect(e.detail).toBeUndefined()
    }
    // 存在しない ID と同じ応答（他社の行があるかどうかを漏らさない）
    const missing = await pgError(asUser(userB, USER_B, () => rpcUpdate(userB, randomUUID(), { amount: 1 })))
    expect(missing).toMatchObject({ code: 'CL404', message: 'not_found' })
    // 会社に所属していないユーザーも同じ
    const none = await pgError(asUser(userB, USER_NO_COMPANY, () => rpcInsert(userB, { item, amount: 1 })))
    expect(none.code).toBe('CL404')

    const after = await admin.query('SELECT * FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1 ORDER BY id', [item])
    expect(after.rows).toEqual(before.rows)
    expect(await state(item)).toEqual(beforeState)
  })

  it('10b. 他社の画像・キーと重なっても他社の行は見えない（23505 になるだけで中身は返らない）', async () => {
    const itemA = await newItem(PROJECT_A, COMPANY_A)
    const itemB = await newItem(PROJECT_B, COMPANY_B)
    const key = randomUUID()
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: itemA, amount: 1000, key, note: 'A社の秘密' }))
    const e = await pgError(asUser(userB, USER_B, () => rpcInsert(userB, { item: itemB, amount: 1, key })))
    expect(e.code).toBe('23505')
    expect(e.message).not.toContain('A社の秘密')
    expect(await state(itemB)).toMatchObject({ count: 0, actualCost: null })
    // 別会社の同じ画像は別案件なので登録できる
    const doc = sha(0xdef)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item: itemA, amount: 1, source: 'ocr', sha: doc, key: randomUUID() }))
    await asUser(userB, USER_B, () => rpcInsert(userB, { item: itemB, amount: 1, source: 'ocr', sha: doc, key: randomUUID() }))
    await expectConsistent(itemA)
    await expectConsistent(itemB)
  })

  it('11. 未認証（anon・ユーザーなし）と service_role は実行できない', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    const id = a.invoice.id as string

    for (const role of ['anon', 'service_role']) {
      for (const call of [(): Promise<unknown> => rpcInsert(userB, { item, amount: 1 }), () => rpcUpdate(userB, id, { amount: 1 }), () => rpcDelete(userB, id)]) {
        const e = await pgError(asUser(userB, USER_A, call, role))
        expect(e.code, role).toBe('42501') // permission denied for function
      }
    }
    // authenticated でも auth.uid() が無ければ実行しない
    for (const call of [(): Promise<unknown> => rpcInsert(userB, { item, amount: 1 }), () => rpcUpdate(userB, id, { amount: 1 }), () => rpcDelete(userB, id)]) {
      const e = await pgError(asUser(userB, null, call))
      expect(e).toMatchObject({ code: 'CL401', message: 'unauthenticated' })
    }
    expect(await state(item)).toMatchObject({ count: 1, actualCost: '1000' })
  })

  it('11b. 削除済みの台帳項目・削除済みの案件は拒否する（その請求書の編集・削除も）', async () => {
    const deletedItem = await newItem(PROJECT_A, COMPANY_A, null, true)
    const onDeletedProject = await newItem(PROJECT_A_DELETED, COMPANY_A)
    for (const item of [deletedItem, onDeletedProject]) {
      const e = await pgError(asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1 })))
      expect(e.code).toBe('CL404')
    }

    // 登録後に台帳項目・案件が削除された請求書
    const project = await newProject(COMPANY_A)
    const item = await newItem(project, COMPANY_A)
    const item2 = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    const b = await asUser(userA, USER_A, () => rpcInsert(userA, { item: item2, amount: 1000 }))
    await admin.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [project])
    await admin.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [item2])
    for (const id of [a.invoice.id, b.invoice.id] as string[]) {
      expect((await pgError(asUser(userA, USER_A, () => rpcUpdate(userA, id, { amount: 5 })))).code).toBe('CL404')
      expect((await pgError(asUser(userA, USER_A, () => rpcDelete(userA, id)))).code).toBe('CL404')
    }
    expect(await state(item)).toMatchObject({ count: 1, actualCost: '1000' })
    expect(await state(item2)).toMatchObject({ count: 1, actualCost: '1000' })
  })

  it('11c. 台帳項目と案件の会社が食い違う行は扱わない（リクエストの値を信用しない）', async () => {
    // A社の案件に B社の company_id を持つ台帳項目（不整合データ）。B社ユーザーには項目は見えるが案件が見えない
    const odd = await newItem(PROJECT_A, COMPANY_B)
    expect((await pgError(asUser(userB, USER_B, () => rpcInsert(userB, { item: odd, amount: 1 })))).code).toBe('CL404')
    expect((await pgError(asUser(userA, USER_A, () => rpcInsert(userA, { item: odd, amount: 1 })))).code).toBe('CL404')
    expect(await state(odd)).toMatchObject({ count: 0 })
  })

  it('11d. 請求書の project_id が親の案件と食い違う行は編集・削除しない（CL409）', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const other = await newProject(COMPANY_A)
    const { rows } = await admin.query(
      `INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 100) RETURNING id`, [item, other])
    const e1 = await pgError(asUser(userA, USER_A, () => rpcUpdate(userA, rows[0].id, { amount: 5 })))
    const e2 = await pgError(asUser(userA, USER_A, () => rpcDelete(userA, rows[0].id)))
    expect(e1).toMatchObject({ code: 'CL409', message: 'inconsistent' })
    expect(e2).toMatchObject({ code: 'CL409', message: 'inconsistent' })
    expect((await state(item)).count).toBe(1)
  })

  it('関数の定義: SECURITY INVOKER・search_path 固定・EXECUTE は authenticated のみ', async () => {
    const { rows } = await admin.query(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'cost_ledger_invoice_%'
      ORDER BY p.proname`)
    expect(rows.map(r => r.proname)).toEqual(['cost_ledger_invoice_delete', 'cost_ledger_invoice_insert', 'cost_ledger_invoice_update'])
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: false, anon: false, authed: true, service: false, public_exec: false })
      expect(r.proconfig).toEqual(expect.arrayContaining(['search_path=""', 'lock_timeout=5s']))
    }
  })

  it('既存の RLS ポリシーは変更しない', async () => {
    expect(await policies(admin)).toEqual(policiesBefore)
  })
})

// ── 13 既存の API・既存行との互換 ───────────────────────────

describe('13. 既存の書き込み・既存行との互換', () => {
  it('現行 API と同じ直接の INSERT（手動・OCR・source なしの既存行）は引き続き動き、RPC の合計に含まれる', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, async () => {
      // migration 以前の既存行（source / project_id なし）
      await userA.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, amount) VALUES ($1, 100)', [item])
      // PR #30 の手動登録
      await userA.query(
        `INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount, source, idempotency_key)
         VALUES ($1, $2, 200, 'manual', $3)`, [item, PROJECT_A, randomUUID()])
      // PR #30 の OCR 登録
      await userA.query(
        `INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount, source, document_sha256, idempotency_key, vendor_name)
         VALUES ($1, $2, 300, 'ocr', $3, $4, 'B工業')`, [item, PROJECT_A, sha(0x13), randomUUID()])
    })
    const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 400 }))
    expect(r).toMatchObject({ actual_cost: 1000, invoice_count: 4 })

    // project_id が NULL の既存行も RPC で編集・削除できる
    const { rows } = await admin.query('SELECT id FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1 AND project_id IS NULL', [item])
    expect((await asUser(userA, USER_A, () => rpcUpdate(userA, rows[0].id, { amount: 150 }))).actual_cost).toBe(1050)
    expect((await asUser(userA, USER_A, () => rpcDelete(userA, rows[0].id))).actual_cost).toBe(900)
    await expectConsistent(item)
  })

  it('RPC で登録した行は現行 API の SELECT 列でそのまま読める', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1234, source: 'ocr', sha: sha(0x99), key: randomUUID(), vendor: 'C商店', number: 'INV-1' }))
    const { rows } = await asUser(userA, USER_A, () => userA.query(
      `SELECT id, cost_ledger_item_id, amount, invoice_date, payment_date, note, source, vendor_name, invoice_number, created_at, document_sha256
       FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1`, [item]))
    expect(rows[0]).toMatchObject({ source: 'ocr', vendor_name: 'C商店', invoice_number: 'INV-1', document_sha256: sha(0x99) })
  })
})

// ── 3・14・15 同時実行（独立した複数の接続） ──────────────────

describe('同時実行（独立した DB 接続で実際にトランザクションを重ねる）', () => {
  it('3. 同じ台帳項目への2件の同時登録: 後の方は親行のロックを待ち、合計は2件分', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A, '100000')
    await begin(userA, USER_A)
    await rpcInsert(userA, { item, amount: 1000 })
    await begin(userA2, USER_A)
    const pid = await backendPid(userA2)
    const second = rpcInsert(userA2, { item, amount: 2000 })
    await waitUntilBlocked(pid) // 実際にロック待ちになっている
    await userA.query('COMMIT')
    const r = await second
    await userA2.query('COMMIT')
    expect(r).toMatchObject({ actual_cost: 3000, invoice_count: 2 })
    expect(await expectConsistent(item)).toMatchObject({ actualCost: '3000', count: 2 })
  })

  it('3b. 別の台帳項目への操作は互いを待たない', async () => {
    const item1 = await newItem(PROJECT_A, COMPANY_A)
    const item2 = await newItem(PROJECT_A, COMPANY_A)
    await begin(userA, USER_A)
    await rpcInsert(userA, { item: item1, amount: 1000 }) // item1 をロックしたまま
    const r = await asUser(userA2, USER_A, () => rpcInsert(userA2, { item: item2, amount: 2000 }))
    expect(r.actual_cost).toBe(2000)
    await userA.query('COMMIT')
    await expectConsistent(item1)
    await expectConsistent(item2)
  })

  it('3c. 8本の接続から同じ台帳項目へ40件を同時に登録しても、件数と合計が一致する', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const conns = await Promise.all(Array.from({ length: 8 }, () => server.connect('p12')))
    const amounts = Array.from({ length: 40 }, (_, i) => `${(i + 1) * 1000}.${String(i % 100).padStart(2, '0')}`)
    await Promise.all(conns.map(async (c, ci) => {
      for (let i = ci; i < amounts.length; i += conns.length) {
        await asUser(c, USER_A, () => rpcInsert(c, { item, amount: amounts[i] }))
      }
    }))
    const s = await expectConsistent(item)
    expect(s.count).toBe(40)
    // 銭単位の整数で合計して比べる（浮動小数点を使わない）
    const cents = amounts.reduce((sum, a) => sum + Number(a.replace('.', '')), 0)
    expect(s.actualCost).toBe(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`)
    await Promise.all(conns.map(c => c.end()))
  })

  it('14. 登録・編集・削除を8本の接続から同時に混ぜても、最後に合計が一致する', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const seeds: string[] = []
    for (let i = 0; i < 12; i++) {
      const r = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 + i }))
      seeds.push(r.invoice.id as string)
    }
    const conns = await Promise.all(Array.from({ length: 8 }, () => server.connect('p12')))
    const outcomes: string[] = []
    await Promise.all(conns.map(async (c, ci) => {
      for (let step = 0; step < 6; step++) {
        const target = seeds[(ci * 3 + step) % seeds.length]
        const op = (ci + step) % 3
        try {
          if (op === 0) await asUser(c, USER_A, () => rpcInsert(c, { item, amount: `${ci}${step}.25` }))
          else if (op === 1) await asUser(c, USER_A, () => rpcUpdate(c, target, { amount: 500 + ci + step }))
          else await asUser(c, USER_A, () => rpcDelete(c, target))
          outcomes.push('ok')
        } catch (e) {
          // 同じ請求書を別の接続が先に削除した場合だけを許す
          expect((e as { code: string }).code).toBe('CL404')
          outcomes.push('not_found')
        }
      }
    }))
    expect(outcomes).toHaveLength(48)
    expect(outcomes.filter(o => o === 'ok').length).toBeGreaterThan(0)
    await expectConsistent(item)
    await Promise.all(conns.map(c => c.end()))
  })

  it('14b. 削除と編集が同じ請求書で競合: 編集は削除の確定を待ち、not_found で何も変えない', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 2000 }))
    await begin(userA, USER_A)
    await rpcDelete(userA, a.invoice.id as string)
    await begin(userA2, USER_A)
    const pid = await backendPid(userA2)
    const upd = pgError(rpcUpdate(userA2, a.invoice.id as string, { amount: 9999 }))
    await waitUntilBlocked(pid)
    await userA.query('COMMIT')
    expect((await upd).code).toBe('CL404')
    await userA2.query('ROLLBACK')
    expect(await expectConsistent(item)).toMatchObject({ actualCost: '2000', count: 1 })
  })

  it('15. ロック待ちが 5 秒を超えると 55P03 で打ち切られ、何も変わらない', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    await begin(userA, USER_A)
    await rpcInsert(userA, { item, amount: 1 }) // 親行をロックしたまま確定しない
    const started = Date.now()
    const e = await pgError(asUser(userA2, USER_A, () => rpcUpdate(userA2, a.invoice.id as string, { amount: 5 })))
    const waited = Date.now() - started
    expect(e.code).toBe('55P03')
    expect(waited).toBeGreaterThanOrEqual(4500)
    expect(waited).toBeLessThan(15000)
    await userA.query('ROLLBACK')
    expect(await expectConsistent(item)).toMatchObject({ actualCost: '1000', count: 1 })
  }, 30_000)

  it('15b. RPC を通らない書き込み（ロック順が逆）とのデッドロック: 片方だけが 40P01 で丸ごと取り消される', async () => {
    const item = await newItem(PROJECT_A, COMPANY_A)
    const a = await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    const id = a.invoice.id as string

    // 接続1: 現行 PATCH API と同じ順（請求書を更新 → 親行を更新）。請求書の行ロックを持つ
    await begin(userA, USER_A)
    await userA.query('UPDATE cost_ledger_invoices SET note = $2 WHERE id = $1', [id, 'legacy'])
    // 接続2: RPC（親行をロック → 請求書のロックを待つ）
    await begin(userA2, USER_A)
    const pid = await backendPid(userA2)
    const rpc = rpcUpdate(userA2, id, { amount: 3000 }).then(() => 'ok', (e: { code: string }) => e.code)
    await waitUntilBlocked(pid)
    // 接続1: 親行の更新で接続2のロックを待つ → デッドロック
    const legacy = userA.query('UPDATE cost_ledger_items SET updated_at = now() WHERE id = $1', [item])
      .then(() => 'ok', (e: { code: string }) => e.code)
    const [rpcResult, legacyResult] = await Promise.all([rpc, legacy])
    expect([rpcResult, legacyResult].sort()).toEqual(['40P01', 'ok'])
    await userA.query(legacyResult === 'ok' ? 'COMMIT' : 'ROLLBACK')
    await userA2.query(rpcResult === 'ok' ? 'COMMIT' : 'ROLLBACK')

    const { rows } = await admin.query('SELECT amount::text, note FROM cost_ledger_invoices WHERE id = $1', [id])
    if (rpcResult === 'ok') {
      // RPC が勝った: 接続1の備考の変更は取り消され、金額と合計は RPC のとおり
      expect(rows[0]).toEqual({ amount: '3000', note: null })
      expect(await expectConsistent(item)).toMatchObject({ actualCost: '3000' })
    } else {
      // 現行の書き込みが勝った: RPC の金額変更も再集計も残らない
      expect(rows[0]).toEqual({ amount: '1000', note: 'legacy' })
      expect(await expectConsistent(item)).toMatchObject({ actualCost: '1000' })
    }
  })

  it('（限界の確認）RPC を通らない現行の書き込みはロックを取らないため、合計がずれうる', async () => {
    // PR #32 で現行 API を RPC に切り替える必要があることの確認。ここでは「ずれうる」ことだけを示す
    const item = await newItem(PROJECT_A, COMPANY_A)
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1000 }))
    // 現行 PATCH /api/cost-ledger/[id] の actual_cost 直接編集（請求書があっても書ける）
    await asUser(userA, USER_A, () => userA.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [item]))
    const s = await state(item)
    expect(s).toMatchObject({ actualCost: '1', total: '1000' }) // ずれている
    // 次に RPC で書き込むと内訳合計に揃う
    await asUser(userA, USER_A, () => rpcInsert(userA, { item, amount: 1 }))
    expect((await expectConsistent(item)).actualCost).toBe('1001')
  })
})

// ── migration の事前確認・ロールバック ──────────────────────

describe('migration の適用条件とロールバック', () => {
  it('P1-1 が未適用の DB では、何も作らずにエラーで止まる', async () => {
    await server.createDatabase('p12_without_p11')
    const c = await server.connect('p12_without_p11')
    await setupDatabase(c, { withP1_1: false, withP1_2: false })
    const e = await pgError(c.query(readMigration(MIGRATION_P1_2)))
    expect(e.message).toContain('P1-2 precondition failed')
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%'")
    expect(rows[0].n).toBe(0)
    await c.end()
  })

  it('二度適用しても同じ状態になる（CREATE OR REPLACE）', async () => {
    await server.createDatabase('p12_twice')
    const c = await server.connect('p12_twice')
    await setupDatabase(c)
    await c.query(readMigration(MIGRATION_P1_2))
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%'")
    expect(rows[0].n).toBe(3)
    await c.end()
  })

  it('ロールバック SQL で関数だけが消え、テーブル・データ・RLS は残る', async () => {
    await server.createDatabase('p12_rollback')
    const c = await server.connect('p12_rollback')
    await setupDatabase(c)
    const before = await policies(c)
    const company = randomUUID(); const user = randomUUID()
    await c.query('INSERT INTO auth.users (id) VALUES ($1)', [user])
    await c.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'X'])
    await c.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)', [company, user])
    const { rows: [p] } = await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [company])
    const { rows: [it1] } = await c.query(
      "INSERT INTO cost_ledger_items (project_id, company_id, name) VALUES ($1, $2, 'x') RETURNING id", [p.id, company])
    await asUser(c, user, () => rpcInsert(c, { item: it1.id, amount: 777 }))

    await c.query(`
      DROP FUNCTION IF EXISTS public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid);
      DROP FUNCTION IF EXISTS public.cost_ledger_invoice_update(uuid, jsonb);
      DROP FUNCTION IF EXISTS public.cost_ledger_invoice_delete(uuid);`)

    const { rows: fns } = await c.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'cost_ledger_invoice_%'")
    expect(fns[0].n).toBe(0)
    const { rows: [after] } = await c.query(
      'SELECT (SELECT count(*)::int FROM cost_ledger_invoices) AS invoices, (SELECT actual_cost::text FROM cost_ledger_items WHERE id = $1) AS actual', [it1.id])
    expect(after).toEqual({ invoices: 1, actual: '777' })
    expect(await policies(c)).toEqual(before)
    await c.end()
  })
})
