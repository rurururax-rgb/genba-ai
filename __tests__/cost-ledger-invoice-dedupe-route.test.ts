import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * 業者請求書 API（POST /api/cost-ledger/[id]/invoices・PATCH/DELETE /api/cost-ledger/invoices/[invoiceId]）と、
 * 実績原価（actual_cost）の直接編集の保護（PATCH /api/cost-ledger/[id]・GET /api/cost-ledger の invoice_count）。
 * 二重登録防止（P1-1 / PR #30）と RPC への切り替え（P1-3 / PR #32）。
 * Supabase はメモリ上の偽クライアントで置き換える。
 *   - RLS: cost_ledger_items / projects は自社 company_id の行、cost_ledger_invoices は親の台帳項目が見える行だけ
 *   - migration 20261010000001 の一意制約（同じ案件 × 同じ画像の OCR、idempotency_key）と CHECK 制約を再現する
 *   - rpc(): migration 20261010000002 の cost_ledger_invoice_insert / update / delete を再現する
 *     （書き込みと再集計は一体。エラー時は何も変わらない）
 *   - dbLockTrigger: migration 20261011000001（未適用）のトリガーを再現する
 * 実 DB の RLS・制約・関数そのものの検証ではない（それは __tests__/db の隔離 DB 検証で行う）。
 */

type Row = Record<string, unknown>

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ME = 'user-me'
const CO_A = id(1)
const CO_B = id(2)
const P_A1 = id(11)
const P_A2 = id(12)
const P_A_DELETED = id(13)
const P_B1 = id(14)
const I_A1 = id(21)      // 案件 A1 の台帳項目
const I_A1_2 = id(22)    // 案件 A1 の別の台帳項目
const I_A2 = id(23)      // 案件 A2 の台帳項目
const I_A_DEL_PROJ = id(24)
const I_B1 = id(25)      // 他社の台帳項目
const I_A1_DELETED = id(26)
const KEY1 = id(101)
const KEY2 = id(102)
const KEY3 = id(103)
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

let currentUser: string | null
let tables: Record<string, Row[]>
/** 次の rpc() を指定の SQLSTATE で失敗させる（何も保存しない。実 DB のトランザクション取り消しと同じ） */
let failNextRpc: string | null
let failInvoiceRead: boolean
/** 次の請求書件数の確認を 0 件と答える（アプリの確認と書き込みの間に請求書が登録された競合を再現） */
let missNextCount: boolean
/** migration 20261011000001 のトリガー（請求書がある項目の actual_cost を合計以外にさせない）を有効にする */
let dbLockTrigger: boolean
/** PostgREST の max-rows（1回の応答の最大行数。超えた分は黙って切られる） */
let maxRows: number
/** 請求書の一覧読み取り（head でないもの）を、この回数だけ成功させた後に失敗させる（null = 失敗させない） */
let failInvoiceReadAfter: number | null
let invoicePageReads: number
/** 次の idempotency_key での検索を空にする（INSERT 前の確認をすり抜けた同時送信を再現し、23505 からの再取得を通す） */
let missNextKeyLookup: boolean

function seed() {
  tables = {
    company_members: [{ user_id: ME, company_id: CO_A }],
    projects: [
      { id: P_A1, company_id: CO_A, deleted_at: null },
      { id: P_A2, company_id: CO_A, deleted_at: null },
      { id: P_A_DELETED, company_id: CO_A, deleted_at: '2026-10-01T00:00:00Z' },
      { id: P_B1, company_id: CO_B, deleted_at: null },
    ],
    cost_ledger_items: [
      { id: I_A1, project_id: P_A1, company_id: CO_A, name: 'システムバス', actual_cost: null, deleted_at: null },
      { id: I_A1_2, project_id: P_A1, company_id: CO_A, name: '外壁塗装', actual_cost: null, deleted_at: null },
      { id: I_A2, project_id: P_A2, company_id: CO_A, name: '別案件の設備', actual_cost: null, deleted_at: null },
      { id: I_A_DEL_PROJ, project_id: P_A_DELETED, company_id: CO_A, name: '削除済み案件の項目', actual_cost: null, deleted_at: null },
      { id: I_B1, project_id: P_B1, company_id: CO_B, name: '他社の項目', actual_cost: 777, deleted_at: null },
      { id: I_A1_DELETED, project_id: P_A1, company_id: CO_A, name: '削除済み項目', actual_cost: null, deleted_at: '2026-10-01T00:00:00Z' },
    ],
    cost_ledger_invoices: [
      // 他社の請求書（見えてはいけない）
      {
        id: id(301), cost_ledger_item_id: I_B1, project_id: P_B1, amount: 777, invoice_date: '2026-09-01', payment_date: null,
        note: '他社の請求', source: 'ocr', vendor_name: '他社業者', invoice_number: 'SECRET-1',
        document_sha256: SHA_B, idempotency_key: KEY3, created_at: '2026-09-01T00:00:00Z',
      },
    ],
  }
  failNextRpc = null
  failInvoiceRead = false
  missNextKeyLookup = false
  missNextCount = false
  dbLockTrigger = false
  maxRows = 1000
  failInvoiceReadAfter = null
  invoicePageReads = 0
}

function myCompanies() {
  return new Set(tables.company_members.filter(r => r.user_id === currentUser).map(r => r.company_id))
}

/** RLS */
function visible(table: string): Row[] {
  if (!currentUser) return []
  if (table === 'company_members') return tables.company_members.filter(r => r.user_id === currentUser)
  const mine = myCompanies()
  if (table === 'cost_ledger_invoices') {
    const items = new Set(tables.cost_ledger_items.filter(i => mine.has(i.company_id)).map(i => i.id))
    return tables.cost_ledger_invoices.filter(r => items.has(r.cost_ledger_item_id))
  }
  return tables[table].filter(r => mine.has(r.company_id))
}

const pick = (row: Row, cols: string | null) => {
  if (!cols) return row
  const keys = cols.split(',').map(c => c.trim())
  return Object.fromEntries(keys.map(k => [k, row[k] ?? null]))
}

/** migration 20261010000001 の CHECK と一意制約（実 DB は RLS と関係なく全行で判定する） */
function constraintError(row: Row): { code: string; message: string } | null {
  const src = row.source ?? null
  if (src !== null && src !== 'ocr' && src !== 'manual') return { code: '23514', message: 'source_check' }
  if (src === 'ocr' && (!row.project_id || !row.document_sha256 || !row.idempotency_key)) return { code: '23514', message: 'ocr_keys_check' }
  if (row.document_sha256 != null && src !== 'ocr') return { code: '23514', message: 'sha256_source_check' }
  if (row.document_sha256 != null && !/^[0-9a-f]{64}$/.test(String(row.document_sha256))) return { code: '23514', message: 'sha256_format_check' }
  for (const r of tables.cost_ledger_invoices) {
    if (row.idempotency_key != null && r.idempotency_key === row.idempotency_key) {
      return { code: '23505', message: 'duplicate key value violates unique constraint "cost_ledger_invoices_idempotency_key_uq"' }
    }
    if (src === 'ocr' && r.source === 'ocr' && r.project_id === row.project_id && r.document_sha256 === row.document_sha256) {
      return { code: '23505', message: 'duplicate key value violates unique constraint "cost_ledger_invoices_project_sha256_ocr_uq"' }
    }
  }
  return null
}

let seq = 0

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let cols: string | null = null
  let mode: 'select' | 'insert' | 'update' = 'select'
  let payload: Row | null = null
  let writeResult: { rows: Row[]; error: { code: string; message: string } | null } | null = null
  let byKey = false
  let headCount = false
  let orderCol: string | null = null
  let limitN: number | null = null

  const doWrite = () => {
    if (writeResult) return writeResult
    if (mode === 'insert') {
      const row = payload!
      // RLS WITH CHECK: 親の台帳項目が自社のもの
      const parentVisible = visible('cost_ledger_items').some(i => i.id === row.cost_ledger_item_id)
      if (!parentVisible) return (writeResult = { rows: [], error: { code: '42501', message: 'row-level security' } })
      const err = constraintError(row)
      if (err) return (writeResult = { rows: [], error: err })
      const inserted = { id: id(500 + ++seq), created_at: `2026-10-10T00:00:${String(seq).padStart(2, '0')}Z`, ...row }
      tables[table].push(inserted)
      return (writeResult = { rows: [inserted], error: null })
    }
    // update
    const rows = visible(table).filter(r => filters.every(f => f(r)))
    if (table === 'cost_ledger_items' && dbLockTrigger && 'actual_cost' in payload!) {
      for (const r of rows) {
        const sum = invoiceSum(r.id as string)
        if (sum.count > 0 && Number(payload!.actual_cost) !== sum.total) {
          return (writeResult = { rows: [], error: { code: 'CL423', message: 'actual_cost_locked' } })
        }
      }
    }
    for (const r of rows) Object.assign(r, payload)
    return (writeResult = { rows, error: null })
  }

  const run = () => {
    if (mode !== 'select') {
      const w = doWrite()
      return { data: w.error ? null : w.rows.map(r => pick(r, cols)), error: w.error }
    }
    if (table === 'cost_ledger_invoices' && failInvoiceRead) return { data: null, error: { code: '57014', message: 'timeout' }, count: null }
    if (headCount) {
      if (table === 'cost_ledger_invoices' && missNextCount) {
        missNextCount = false
        return { data: null, error: null, count: 0 }
      }
      return { data: null, error: null, count: visible(table).filter(r => filters.every(f => f(r))).length }
    }
    if (table === 'cost_ledger_invoices' && byKey && missNextKeyLookup) {
      missNextKeyLookup = false
      return { data: [], error: null }
    }
    if (table === 'cost_ledger_invoices' && failInvoiceReadAfter !== null && invoicePageReads++ >= failInvoiceReadAfter) {
      return { data: null, error: { code: '57014', message: 'timeout' } }
    }
    let hit = visible(table).filter(r => filters.every(f => f(r)))
    if (orderCol) {
      const c = orderCol
      hit = [...hit].sort((a, b) => (a[c] == null || b[c] == null ? 0 : a[c]! < b[c]! ? -1 : a[c]! > b[c]! ? 1 : 0))
    }
    hit = hit.slice(0, Math.min(limitN ?? Infinity, maxRows))
    return { data: hit.map(r => pick(r, cols)), error: null }
  }
  const one = (strict: boolean) => {
    const { data, error } = run()
    if (error) return Promise.resolve({ data: null, error })
    if (data!.length === 1) return Promise.resolve({ data: data![0], error: null })
    if (data!.length === 0 && !strict) return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not exactly one row' } })
  }
  const q = {
    select: (c?: string, opts?: { count?: string; head?: boolean }) => {
      if (mode === 'select' && opts?.head) headCount = true
      cols = c ?? null
      return q
    },
    eq: (col: string, v: unknown) => { if (col === 'idempotency_key') byKey = true; filters.push(r => r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    in: (col: string, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return q },
    gt: (col: string, v: unknown) => { filters.push(r => (r[col] as string) > (v as string)); return q },
    order: (col: string) => { orderCol = col; return q },
    limit: (n: number) => { limitN = n; return q },
    single: () => one(true),
    maybeSingle: () => one(false),
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
    insert: (row: Row) => { mode = 'insert'; payload = row; return q },
    update: (row: Row) => { mode = 'update'; payload = row; return q },
  }
  return q
}

function invoiceSum(itemId: string) {
  const rows = tables.cost_ledger_invoices.filter(r => r.cost_ledger_item_id === itemId)
  return { count: rows.length, total: rows.reduce((s, r) => s + Number(r.amount), 0) }
}

/** RPC が返す請求書の列（画像ハッシュ・idempotency_key・project_id は返さない） */
const RPC_INVOICE_COLUMNS = 'id, cost_ledger_item_id, amount, invoice_date, payment_date, note, source, vendor_name, invoice_number, created_at'

type RpcError = { code: string; message: string; details?: string; hint?: string }
const rpcFail = (code: string, message: string) => ({ data: null, error: { code, message, details: 'internal detail: relation cost_ledger_items', hint: null } as RpcError & { hint: null } })

/** 親の台帳項目（自社・未削除・案件も未削除）。無ければ null（CL404） */
function lockableItem(itemId: unknown) {
  const item = visible('cost_ledger_items').find(i => i.id === itemId && i.deleted_at == null)
  if (!item) return null
  const project = visible('projects').find(p => p.id === item.project_id && p.deleted_at == null && p.company_id === item.company_id)
  return project ? item : null
}

/** 再集計（RPC と同じく、0件なら NULL） */
function recalc(item: Row) {
  const sum = invoiceSum(item.id as string)
  item.actual_cost = sum.count === 0 ? null : sum.total
  return { actual_cost: item.actual_cost, invoice_count: sum.count }
}

const rpcCalls: string[] = []

/** migration 20261010000002 の3関数（書き込みと再集計は一体。失敗時は何も変えない） */
async function rpc(fn: string, args: Row) {
  rpcCalls.push(fn)
  if (!currentUser) return rpcFail('CL401', 'unauthenticated')
  if (failNextRpc) {
    const code = failNextRpc
    failNextRpc = null
    return rpcFail(code, 'canceling statement due to lock timeout')
  }
  const trim = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

  if (fn === 'cost_ledger_invoice_insert') {
    const amount = args.p_amount as number
    const source = (args.p_source as string | null) ?? 'manual'
    if (typeof amount !== 'number' || amount === 0 || Math.abs(amount) >= 1e12 || !['ocr', 'manual'].includes(source)) {
      return rpcFail('CL400', 'invalid_input')
    }
    const item = lockableItem(args.p_item_id)
    if (!item) return rpcFail('CL404', 'not_found')
    const row: Row = {
      cost_ledger_item_id: item.id, project_id: item.project_id, amount,
      invoice_date: args.p_invoice_date ?? null, payment_date: args.p_payment_date ?? null, note: trim(args.p_note),
      source, vendor_name: source === 'ocr' ? trim(args.p_vendor_name) : null,
      invoice_number: source === 'ocr' ? trim(args.p_invoice_number) : null,
      document_sha256: args.p_document_sha256 ?? null, idempotency_key: args.p_idempotency_key ?? null,
    }
    const err = constraintError(row)
    if (err) return { data: null, error: err }
    const inserted = { id: id(500 + ++seq), created_at: `2026-10-10T00:00:${String(seq).padStart(2, '0')}Z`, ...row }
    tables.cost_ledger_invoices.push(inserted)
    return { data: { invoice: pick(inserted, RPC_INVOICE_COLUMNS), item_id: item.id, ...recalc(item) }, error: null }
  }

  if (fn === 'cost_ledger_invoice_update' || fn === 'cost_ledger_invoice_delete') {
    const patch = (args.p_patch ?? null) as Row | null
    if (fn === 'cost_ledger_invoice_update') {
      const keys = patch ? Object.keys(patch) : []
      if (keys.length === 0 || keys.some(k => !['amount', 'invoice_date', 'payment_date', 'note'].includes(k))) {
        return rpcFail('CL400', 'invalid_input')
      }
      if ('amount' in patch! && (typeof patch!.amount !== 'number' || patch!.amount === 0)) return rpcFail('CL400', 'invalid_input')
    }
    const inv = visible('cost_ledger_invoices').find(r => r.id === args.p_invoice_id)
    if (!inv) return rpcFail('CL404', 'not_found')
    const item = lockableItem(inv.cost_ledger_item_id)
    if (!item) return rpcFail('CL404', 'not_found')
    if (fn === 'cost_ledger_invoice_delete') {
      tables.cost_ledger_invoices = tables.cost_ledger_invoices.filter(r => r !== inv)
      return { data: { deleted_id: inv.id, item_id: item.id, ...recalc(item) }, error: null }
    }
    for (const [k, v] of Object.entries(patch!)) inv[k] = k === 'note' ? trim(v) : v
    return { data: { invoice: pick(inv, RPC_INVOICE_COLUMNS), item_id: item.id, ...recalc(item) }, error: null }
  }
  return rpcFail('PGRST202', 'Could not find the function')
}

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
    from,
    rpc,
  }),
}))

const { POST, GET } = await import('@/app/api/cost-ledger/[id]/invoices/route')
const invoiceRoute = await import('@/app/api/cost-ledger/invoices/[invoiceId]/route')
const itemRoute = await import('@/app/api/cost-ledger/[id]/route')
const listRoute = await import('@/app/api/cost-ledger/route')

async function post(itemId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/cost-ledger/${itemId}/invoices`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await POST(req, { params: Promise.resolve({ id: itemId }) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const ocr = (over: Record<string, unknown> = {}) => ({
  source: 'ocr', amount: 33000, invoice_date: '2026-10-01', payment_date: '2026-10-31',
  note: 'QA設備からの請求', vendor_name: 'QA設備', invoice_number: 'INV-001',
  document_sha256: SHA_A, idempotency_key: KEY1, ...over,
})
const manual = (over: Record<string, unknown> = {}) => ({
  amount: 10000, invoice_date: null, payment_date: null, note: null, ...over,
})

const invoiceCount = () => tables.cost_ledger_invoices.length
const actualCost = (itemId: string) => tables.cost_ledger_items.find(i => i.id === itemId)!.actual_cost

async function patchInvoice(invoiceId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/cost-ledger/invoices/${invoiceId}`, {
    method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await invoiceRoute.PATCH(req, { params: Promise.resolve({ invoiceId }) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

async function deleteInvoice(invoiceId: string) {
  const req = new NextRequest(`http://localhost/api/cost-ledger/invoices/${invoiceId}`, { method: 'DELETE' })
  const res = await invoiceRoute.DELETE(req, { params: Promise.resolve({ invoiceId }) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

async function patchItem(itemId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/cost-ledger/${itemId}`, {
    method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await itemRoute.PATCH(req, { params: Promise.resolve({ id: itemId }) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

/** DB のエラー文・内部情報が応答に含まれていないこと */
const expectNoLeak = (json: unknown) =>
  expect(JSON.stringify(json)).not.toMatch(/internal detail|relation|lock timeout|invalid_input|CL4\d\d|SECRET|777/)

beforeEach(() => {
  currentUser = ME
  seq = 0
  rpcCalls.length = 0
  seed()
})

describe('OCR 登録', () => {
  it('1. 初回の OCR 登録ができ、project_id は親の台帳項目から保存される', async () => {
    const r = await post(I_A1, { ...ocr(), project_id: P_A2 /* 本文の project_id は使わない */ })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ newActualCost: 33000, invoiceCount: 1, replayed: false, synced: true }))
    expect(r.json.invoice).toEqual(expect.objectContaining({ amount: 33000, source: 'ocr', vendor_name: 'QA設備', invoice_number: 'INV-001' }))
    expect(r.json.invoice).not.toHaveProperty('document_sha256')
    const saved = tables.cost_ledger_invoices.at(-1)!
    expect(saved).toEqual(expect.objectContaining({ project_id: P_A1, document_sha256: SHA_A, idempotency_key: KEY1, source: 'ocr' }))
    expect(actualCost(I_A1)).toBe(33000)
  })

  it('2. 同じ画像の2回目（新しい登録操作）は「この請求書は登録済みです」で拒否', async () => {
    await post(I_A1, ocr())
    const before = invoiceCount()
    const r = await post(I_A1, ocr({ idempotency_key: KEY2 }))
    expect(r.status).toBe(409)
    expect(r.json).toEqual(expect.objectContaining({ error: 'この請求書は登録済みです', code: 'duplicate_document' }))
    expect(r.json.existing).toEqual(expect.objectContaining({ cost_ledger_item_id: I_A1, item_name: 'システムバス', amount: 33000 }))
    expect(invoiceCount()).toBe(before)
    expect(actualCost(I_A1)).toBe(33000)
  })

  it('3. 同じ案件の別の台帳項目へ同じ画像も拒否', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1_2, ocr({ idempotency_key: KEY2 }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('duplicate_document')
    expect(actualCost(I_A1_2)).toBeNull()
  })

  it('4. 別の案件へ同じ画像は登録できる', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A2, ocr({ idempotency_key: KEY2 }))
    expect(r.status).toBe(200)
    expect(tables.cost_ledger_invoices.at(-1)).toEqual(expect.objectContaining({ project_id: P_A2, document_sha256: SHA_A }))
  })

  it('他社の案件に同じ画像があっても、自社案件への登録には影響しない（他社の情報も返さない）', async () => {
    const r = await post(I_A1, ocr({ document_sha256: SHA_B, idempotency_key: KEY2 }))
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.json)).not.toContain('SECRET-1')
  })

  it('一意制約の事前確認をすり抜けた同じ画像（同時送信）も 23505 から「登録済み」に分類する', async () => {
    const [a, b] = await Promise.all([post(I_A1, ocr()), post(I_A1_2, ocr({ idempotency_key: KEY2 }))])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    expect([a, b].find(x => x.status === 409)!.json.code).toBe('duplicate_document')
    expect(tables.cost_ledger_invoices.filter(i => i.document_sha256 === SHA_A)).toHaveLength(1)
  })
})

describe('同じ登録操作の再送（idempotency_key）', () => {
  it('6・7. 同じキーの再送は新しい行を作らず、actual_cost も増えない', async () => {
    const first = await post(I_A1, ocr())
    const before = invoiceCount()
    const again = await post(I_A1, ocr())
    expect(again.status).toBe(200)
    expect(again.json).toEqual(expect.objectContaining({ replayed: true, newActualCost: 33000 }))
    expect((again.json.invoice as Row).id).toBe((first.json.invoice as Row).id)
    expect(again.json.invoice).not.toHaveProperty('document_sha256')
    expect(invoiceCount()).toBe(before)
    expect(actualCost(I_A1)).toBe(33000)
  })

  it('5. 連打（同じキーの同時送信）でも1行だけ', async () => {
    const results = await Promise.all([post(I_A1, ocr()), post(I_A1, ocr()), post(I_A1, ocr())])
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.filter(r => r.json.replayed === false)).toHaveLength(1)
    expect(tables.cost_ledger_invoices.filter(i => i.idempotency_key === KEY1)).toHaveLength(1)
    expect(actualCost(I_A1)).toBe(33000)
  })

  it('8. 保存後に応答が失われても、同じキーで再送すれば安全（手動追加）', async () => {
    await post(I_A1, manual({ idempotency_key: KEY1 }))   // 応答が届かなかったとする
    const retry = await post(I_A1, manual({ idempotency_key: KEY1 }))
    expect(retry.json.replayed).toBe(true)
    expect(tables.cost_ledger_invoices.filter(i => i.cost_ledger_item_id === I_A1)).toHaveLength(1)
    expect(actualCost(I_A1)).toBe(10000)
  })

  it('同じキーで金額が違う再送は成功扱いにしない', async () => {
    await post(I_A1, manual({ idempotency_key: KEY1 }))
    const r = await post(I_A1, manual({ idempotency_key: KEY1, amount: 99999 }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('idempotency_conflict')
    expect(actualCost(I_A1)).toBe(10000)
  })

  it('同じキーで登録先の台帳項目が違う再送は成功扱いにしない', async () => {
    await post(I_A1, manual({ idempotency_key: KEY1 }))
    const r = await post(I_A1_2, manual({ idempotency_key: KEY1 }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('idempotency_conflict')
    expect(actualCost(I_A1_2)).toBeNull()
  })

  it.each([
    ['請求日', { invoice_date: '2026-10-02' }],
    ['支払日', { payment_date: '2026-11-30' }],
    ['メモ', { note: '別のメモ' }],
    ['業者名', { vendor_name: '別の業者' }],
    ['請求書番号', { invoice_number: 'INV-999' }],
  ])('同じキー・同じ金額でも %s が違う再送は 409 idempotency_conflict（行も原価も増えない）', async (_label, change) => {
    await post(I_A1, ocr())
    const before = invoiceCount()
    const r = await post(I_A1, ocr(change))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('idempotency_conflict')
    expect(invoiceCount()).toBe(before)
    expect(actualCost(I_A1)).toBe(33000)
  })

  it.each([
    ['請求日', { invoice_date: '2026-10-02' }],
    ['メモ', { note: '別のメモ' }],
  ])('手動登録でも同じキーで %s が違う再送は 409', async (_label, change) => {
    await post(I_A1, manual({ idempotency_key: KEY1, invoice_date: '2026-10-01', note: 'メモ' }))
    const r = await post(I_A1, manual({ idempotency_key: KEY1, invoice_date: '2026-10-01', note: 'メモ', ...change }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('idempotency_conflict')
    expect(actualCost(I_A1)).toBe(10000)
  })

  it('23505 から再取得した行でも同じ判定：内容が違えば 409、同じなら再送として返す', async () => {
    // OCR は同じ画像の事前確認で止まるため、23505 まで進む手動登録で確かめる
    await post(I_A1, manual({ idempotency_key: KEY1, note: 'メモ' }))
    missNextKeyLookup = true   // INSERT 前の確認をすり抜けた
    const conflict = await post(I_A1, manual({ idempotency_key: KEY1, note: '別のメモ' }))
    expect(conflict.status).toBe(409)
    expect(conflict.json.code).toBe('idempotency_conflict')

    missNextKeyLookup = true
    const same = await post(I_A1, manual({ idempotency_key: KEY1, note: 'メモ' }))
    expect(same.status).toBe(200)
    expect(same.json).toEqual(expect.objectContaining({ replayed: true, synced: true, newActualCost: 10000 }))
    expect(tables.cost_ledger_invoices.filter(i => i.cost_ledger_item_id === I_A1)).toHaveLength(1)
    expect(actualCost(I_A1)).toBe(10000)
  })

  it('NULL と空文字・前後の空白・numeric の文字列表現は同じ内容とみなす', async () => {
    await post(I_A1, manual({ idempotency_key: KEY1, note: null }))
    const saved = tables.cost_ledger_invoices.at(-1)!
    saved.amount = '10000.00'           // numeric が文字列で返る場合
    const r = await post(I_A1, manual({ idempotency_key: KEY1, note: '  ', invoice_date: '' }))
    expect(r.status).toBe(200)
    expect(r.json.replayed).toBe(true)
  })

  it('confirm_similar の違いは比較しない（保存内容ではないため）', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1, ocr({ confirm_similar: true }))
    expect(r.status).toBe(200)
    expect(r.json.replayed).toBe(true)
  })

  it('他社の行と同じキーで 23505 になっても他社の行は返さない（再取得は RLS の範囲だけ）', async () => {
    const r = await post(I_A1, ocr({ idempotency_key: KEY3, document_sha256: SHA_B, invoice_number: 'SECRET-1', vendor_name: '他社業者' }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('conflict')
    expect(JSON.stringify(r.json)).not.toMatch(/SECRET|777|他社/)
  })

  it('11. 他社の行と同じキー（見えない行との衝突）は中身を返さない汎用エラー', async () => {
    const r = await post(I_A1, manual({ idempotency_key: KEY3 }))
    expect(r.status).toBe(409)
    expect(r.json).toEqual({ error: '登録できませんでした。画面を再読み込みしてください。', code: 'conflict' })
    expect(JSON.stringify(r.json)).not.toMatch(/SECRET|777|他社|duplicate key/)
  })
})

describe('手動登録', () => {
  it('9. 同じ金額の分割請求（別の登録操作）は何度でも登録できる', async () => {
    expect((await post(I_A1, manual({ idempotency_key: KEY1 }))).status).toBe(200)
    expect((await post(I_A1, manual({ idempotency_key: KEY2 }))).status).toBe(200)
    expect((await post(I_A1, manual())).status).toBe(200)   // キーなし（従来のクライアント）
    expect(tables.cost_ledger_invoices.filter(i => i.cost_ledger_item_id === I_A1)).toHaveLength(3)
    expect(actualCost(I_A1)).toBe(30000)
    expect(tables.cost_ledger_invoices.at(-1)).toEqual(expect.objectContaining({ source: 'manual', document_sha256: null, project_id: P_A1 }))
  })

  it('手動登録に画像ハッシュは付けられない', async () => {
    const r = await post(I_A1, manual({ document_sha256: SHA_A }))
    expect(r.status).toBe(400)
    expect(invoiceCount()).toBe(1)
  })
})

describe('以前の請求書と似ている（10）', () => {
  it('請求書番号が同じなら確認を求め、確認後は登録できる（ハッシュ制約はすり抜けない）', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1_2, ocr({ document_sha256: 'c'.repeat(64), idempotency_key: KEY2, invoice_number: 'inv 001', amount: 1 }))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('similar_invoice')
    expect(r.json.similar).toEqual([expect.objectContaining({ reason: 'invoice_number', item_name: 'システムバス', amount: 33000 })])
    expect(invoiceCount()).toBe(2)

    const confirmed = await post(I_A1_2, ocr({ document_sha256: 'c'.repeat(64), idempotency_key: KEY2, invoice_number: 'inv 001', amount: 1, confirm_similar: true }))
    expect(confirmed.status).toBe(200)

    // 確認しても同じ画像は登録できない
    const same = await post(I_A1_2, ocr({ idempotency_key: KEY3.replace(/3$/, '4'), confirm_similar: true }))
    expect(same.status).toBe(409)
    expect(same.json.code).toBe('duplicate_document')
  })

  it('金額だけ同じ別の請求書は止めない', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1, ocr({ document_sha256: 'c'.repeat(64), idempotency_key: KEY2, invoice_number: 'INV-002', invoice_date: '2026-10-02' }))
    expect(r.status).toBe(200)
  })

  it('似ている判定は他社の請求書を対象にしない', async () => {
    const r = await post(I_A1, ocr({ invoice_number: 'SECRET-1', vendor_name: '他社業者', idempotency_key: KEY2 }))
    expect(r.status).toBe(200)
  })

  it('似ている判定の読み取りに失敗したら登録しない（確認なしで素通りさせない）', async () => {
    failInvoiceRead = true
    const r = await post(I_A1, ocr())
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.json)).not.toContain('timeout')
    failInvoiceRead = false
    expect(invoiceCount()).toBe(1)
  })
})

describe('対象・入力の検証（書き込み前に拒否）', () => {
  it('11. 他社の台帳項目には登録できない（404・他社の情報を返さない）', async () => {
    const r = await post(I_B1, manual())
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.json)).not.toContain('777')
    expect(invoiceCount()).toBe(1)
  })

  it('12. 削除済みの案件の台帳項目には登録できない', async () => {
    const r = await post(I_A_DEL_PROJ, manual())
    expect(r.status).toBe(404)
    expect(invoiceCount()).toBe(1)
  })

  it('削除済みの台帳項目には登録できない', async () => {
    expect((await post(I_A1_DELETED, manual())).status).toBe(404)
  })

  it('未ログインは 401', async () => {
    currentUser = null
    expect((await post(I_A1, manual())).status).toBe(401)
  })

  it.each([
    ['金額 0', manual({ amount: 0 })],
    ['金額が文字列', manual({ amount: '1000' })],
    ['金額が NaN 相当', '{"amount": NaN}'],
    ['金額が桁あふれ', manual({ amount: 1e15 })],
    ['存在しない日付', manual({ invoice_date: '2026-02-30' })],
    ['日付の形式違い', manual({ payment_date: '2026/10/01' })],
    ['キーが UUID でない', manual({ idempotency_key: 'abc' })],
    ['OCR でハッシュが大文字', ocr({ document_sha256: 'A'.repeat(64) })],
    ['OCR でハッシュが短い', ocr({ document_sha256: 'a'.repeat(63) })],
    ['OCR でハッシュなし', ocr({ document_sha256: undefined })],
    ['OCR でキーなし', ocr({ idempotency_key: undefined })],
    ['source が不明', manual({ source: 'import' })],
    ['備考が長すぎる', manual({ note: 'x'.repeat(501) })],
    ['本文が JSON でない', 'not json'],
  ])('13. 不正な入力は 400 で拒否し、DB を読まずに何も書き込まない: %s', async (_label, body) => {
    const before = JSON.stringify(tables)
    const r = await post(I_A1, body)
    expect(r.status).toBe(400)
    expect(JSON.stringify(tables)).toBe(before)
  })

  it('台帳項目 ID が UUID でなければ 400', async () => {
    expect((await post('not-a-uuid', manual())).status).toBe(400)
  })

  it('マイナス（値引・返品）の手動登録は従来どおりできる', async () => {
    expect((await post(I_A1, manual({ amount: -5000 }))).status).toBe(200)
    expect(actualCost(I_A1)).toBe(-5000)
  })
})

describe('actual_cost の再集計（16 / RPC で登録と一体）', () => {
  it('登録は RPC 1回で行い、API から actual_cost を別に書き込まない', async () => {
    const r = await post(I_A1, ocr())
    expect(r.json).toEqual(expect.objectContaining({ synced: true, replayed: false, newActualCost: 33000 }))
    expect(rpcCalls).toEqual(['cost_ledger_invoice_insert'])
  })

  it.each([
    ['55P03', 503, 'busy'],     // ロック待ち 5 秒超過
    ['40P01', 503, 'busy'],     // デッドロック
    ['CL409', 409, 'inconsistent'],
    ['CL404', 404, 'not_found'],
    ['XX000', 500, undefined],  // 想定外
  ])('RPC が %s で失敗したら請求書も原価も保存されず、%i を返す（DB のエラー文は返さない）', async (code, status, errCode) => {
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 100000
    failNextRpc = code
    const r = await post(I_A1, ocr())
    expect(r.status).toBe(status)
    expect(r.json.code).toBe(errCode)
    expectNoLeak(r.json)
    expect(invoiceCount()).toBe(1)
    expect(actualCost(I_A1)).toBe(100000)
  })

  it('エラー（503）→ 同じキーで再送：1件だけ保存され、原価は1回分だけ加算される', async () => {
    failNextRpc = '55P03'
    expect((await post(I_A1, manual({ idempotency_key: KEY1, amount: 50000 }))).status).toBe(503)
    const retry = await post(I_A1, manual({ idempotency_key: KEY1, amount: 50000 }))
    expect(retry.status).toBe(200)
    expect(retry.json).toEqual(expect.objectContaining({ replayed: false, synced: true, newActualCost: 50000, invoiceCount: 1 }))
    // さらに応答喪失 → 再送しても増えない
    const again = await post(I_A1, manual({ idempotency_key: KEY1, amount: 50000 }))
    expect(again.json).toEqual(expect.objectContaining({ replayed: true, synced: true, newActualCost: 50000 }))
    expect(tables.cost_ledger_invoices.filter(i => i.cost_ledger_item_id === I_A1)).toHaveLength(1)
    expect(actualCost(I_A1)).toBe(50000)
  })

  it('登録しなかった場合（重複）は再集計しない', async () => {
    await post(I_A1, ocr())
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 12345   // 不整合な既存データとする
    await post(I_A1, ocr({ idempotency_key: KEY2 }))
    expect(actualCost(I_A1)).toBe(12345)
  })

  it('再送（replayed）では再集計しない。内訳合計と一致しない actual_cost は synced: false（既存の不整合データ）', async () => {
    await post(I_A1, ocr())
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 12345
    const r = await post(I_A1, ocr())
    expect(r.json).toEqual(expect.objectContaining({ replayed: true, synced: false, newActualCost: null }))
    expect(actualCost(I_A1)).toBe(12345)   // 書き換えない（既存データの自動修正はしない）
  })

  it('再送で actual_cost が内訳合計と一致していれば synced: true と DB の値を返す', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1, ocr())
    expect(r.json).toEqual(expect.objectContaining({ replayed: true, synced: true, newActualCost: 33000 }))
  })

  it('同じ項目への同時登録（別の操作）は両方保存され、合計が正しい', async () => {
    const results = await Promise.all([
      post(I_A1, manual({ idempotency_key: KEY1, amount: 10000 })),
      post(I_A1, manual({ idempotency_key: KEY2, amount: 2500 })),
      post(I_A1, manual({ amount: 300 })),
    ])
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    expect(actualCost(I_A1)).toBe(12800)
  })
})

describe('請求書の編集（PATCH /api/cost-ledger/invoices/[invoiceId]）', () => {
  async function twoInvoices() {
    const a = await post(I_A1, manual({ idempotency_key: KEY1, amount: 20000 }))
    const b = await post(I_A1, manual({ idempotency_key: KEY2, amount: 5000 }))
    return { a: (a.json.invoice as Row).id as string, b: (b.json.invoice as Row).id as string }
  }

  it('金額・日付・備考を変更し、actual_cost を再集計した値を返す', async () => {
    const { a } = await twoInvoices()
    const r = await patchInvoice(a, { amount: 21000, invoice_date: '2026-10-05', note: '  追加分  ' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ newActualCost: 26000, itemId: I_A1, invoiceCount: 2 }))
    expect(r.json.invoice).toEqual(expect.objectContaining({ amount: 21000, invoice_date: '2026-10-05', note: '追加分' }))
    expect(r.json.invoice).not.toHaveProperty('document_sha256')
    expect(actualCost(I_A1)).toBe(26000)
    expect(rpcCalls.at(-1)).toBe('cost_ledger_invoice_update')
  })

  it('許可されない列（台帳項目の付け替え・source など）は送られても無視し、RPC に渡さない', async () => {
    const { a } = await twoInvoices()
    const r = await patchInvoice(a, { amount: 1000, cost_ledger_item_id: I_A2, source: 'ocr', project_id: P_A2 })
    expect(r.status).toBe(200)
    expect(tables.cost_ledger_invoices.find(i => i.id === a)).toEqual(expect.objectContaining({ cost_ledger_item_id: I_A1, source: 'manual' }))
  })

  it.each([
    ['金額 0', { amount: 0 }],
    ['金額が文字列', { amount: '1000' }],
    ['存在しない日付', { invoice_date: '2026-02-30' }],
    ['変更する列がない', { cost_ledger_item_id: I_A2 }],
    ['本文が JSON でない', 'not json'],
  ])('不正な入力は 400（RPC を呼ばない）: %s', async (_label, body) => {
    const { a } = await twoInvoices()
    rpcCalls.length = 0
    const r = await patchInvoice(a, body)
    expect(r.status).toBe(400)
    expect(rpcCalls).toEqual([])
    expect(actualCost(I_A1)).toBe(25000)
  })

  it('請求書 ID が UUID でなければ 400', async () => {
    expect((await patchInvoice('x', { amount: 1 })).status).toBe(400)
  })

  it('他社の請求書・存在しない請求書は 404（他社の情報を返さない）', async () => {
    const other = await patchInvoice(id(301), { amount: 1 })
    expect(other.status).toBe(404)
    expectNoLeak(other.json)
    expect(tables.cost_ledger_invoices.find(i => i.id === id(301))!.amount).toBe(777)
    expect((await patchInvoice(id(999), { amount: 1 })).status).toBe(404)
  })

  it('ロック待ち超過（55P03）は 503 busy。金額も原価も変わらず、再試行で反映される', async () => {
    const { a } = await twoInvoices()
    failNextRpc = '55P03'
    const r = await patchInvoice(a, { amount: 30000 })
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('busy')
    expectNoLeak(r.json)
    expect(actualCost(I_A1)).toBe(25000)
    expect((await patchInvoice(a, { amount: 30000 })).json.newActualCost).toBe(35000)
  })

  it('同じ金額への再送（応答喪失後）は結果が変わらない', async () => {
    const { a } = await twoInvoices()
    await patchInvoice(a, { amount: 30000 })
    const again = await patchInvoice(a, { amount: 30000 })
    expect(again.json.newActualCost).toBe(35000)
  })

  it('未ログインは 401', async () => {
    currentUser = null
    expect((await patchInvoice(id(301), { amount: 1 })).status).toBe(401)
  })
})

describe('請求書の削除（DELETE /api/cost-ledger/invoices/[invoiceId]）', () => {
  it('削除して再集計。最後の1件を削除すると actual_cost は NULL（直接入力に戻る）', async () => {
    const a = ((await post(I_A1, manual({ idempotency_key: KEY1, amount: 20000 }))).json.invoice as Row).id as string
    const b = ((await post(I_A1, manual({ idempotency_key: KEY2, amount: 5000 }))).json.invoice as Row).id as string
    const r1 = await deleteInvoice(a)
    expect(r1.status).toBe(200)
    expect(r1.json).toEqual({ newActualCost: 5000, itemId: I_A1, invoiceCount: 1 })
    const r2 = await deleteInvoice(b)
    expect(r2.json).toEqual({ newActualCost: null, itemId: I_A1, invoiceCount: 0 })
    expect(actualCost(I_A1)).toBeNull()
    // 0件になったので直接入力できる
    expect((await patchItem(I_A1, { actual_cost: 18000 })).status).toBe(200)
  })

  it('削除済み（再送・別画面で削除済み）は 404 で、原価は変わらない', async () => {
    const a = ((await post(I_A1, manual({ amount: 20000 }))).json.invoice as Row).id as string
    await deleteInvoice(a)
    const again = await deleteInvoice(a)
    expect(again.status).toBe(404)
    expect(again.json.code).toBe('not_found')
    expect(actualCost(I_A1)).toBeNull()
  })

  it('他社の請求書は削除できない（404）', async () => {
    const r = await deleteInvoice(id(301))
    expect(r.status).toBe(404)
    expectNoLeak(r.json)
    expect(tables.cost_ledger_invoices.some(i => i.id === id(301))).toBe(true)
  })

  it('RPC の失敗（40P01）は 503 で、請求書は残り原価も変わらない', async () => {
    const a = ((await post(I_A1, manual({ amount: 20000 }))).json.invoice as Row).id as string
    failNextRpc = '40P01'
    const r = await deleteInvoice(a)
    expect(r.status).toBe(503)
    expect(tables.cost_ledger_invoices.some(i => i.id === a)).toBe(true)
    expect(actualCost(I_A1)).toBe(20000)
  })

  it('ID が UUID でなければ 400', async () => {
    expect((await deleteInvoice('x')).status).toBe(400)
  })
})

describe('実績原価の直接編集（PATCH /api/cost-ledger/[id]）', () => {
  it('請求書が0件の項目は従来どおり直接入力できる', async () => {
    const r = await patchItem(I_A1, { actual_cost: 42000 })
    expect(r.status).toBe(200)
    expect(actualCost(I_A1)).toBe(42000)
  })

  it('請求書がある項目は 409 actual_cost_locked で拒否し、値は変わらない', async () => {
    await post(I_A1, manual({ amount: 30000 }))
    const r = await patchItem(I_A1, { actual_cost: 99999 })
    expect(r.status).toBe(409)
    expect(r.json).toEqual(expect.objectContaining({ code: 'actual_cost_locked' }))
    expect(actualCost(I_A1)).toBe(30000)
    // 名前・予算など他の列と一緒に送っても全体を拒否する
    expect((await patchItem(I_A1, { name: '変更', actual_cost: 1 })).status).toBe(409)
    expect(tables.cost_ledger_items.find(i => i.id === I_A1)!.name).toBe('システムバス')
  })

  it('請求書がある項目でも、actual_cost 以外の列は変更できる', async () => {
    await post(I_A1, manual({ amount: 30000 }))
    const r = await patchItem(I_A1, { budget_cost: 28000, note: 'メモ' })
    expect(r.status).toBe(200)
    expect(actualCost(I_A1)).toBe(30000)
  })

  it('請求書の件数を確認できなければ書き込まない（500・安全側）', async () => {
    failInvoiceRead = true
    const r = await patchItem(I_A1, { actual_cost: 1 })
    expect(r.status).toBe(500)
    expectNoLeak(r.json)
    expect(actualCost(I_A1)).toBeNull()
  })

  it('確認と書き込みの間に請求書が登録された競合は、DB のトリガー（未適用 migration）があれば 409 で止まる', async () => {
    await post(I_A1, manual({ amount: 30000 }))
    dbLockTrigger = true
    missNextCount = true   // アプリの確認では 0 件に見えた
    const r = await patchItem(I_A1, { actual_cost: 99999 })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('actual_cost_locked')
    expectNoLeak(r.json)
    expect(actualCost(I_A1)).toBe(30000)
  })

  it('（トリガー未適用の現状）同じ競合ではアプリの確認をすり抜けて書き込まれてしまう — 残るリスクの記録', async () => {
    await post(I_A1, manual({ amount: 30000 }))
    missNextCount = true
    expect((await patchItem(I_A1, { actual_cost: 99999 })).status).toBe(200)
    expect(actualCost(I_A1)).toBe(99999)
  })

  it('他社・存在しない項目は 404', async () => {
    expect((await patchItem(I_B1, { actual_cost: 1 })).status).toBe(404)
    expect(actualCost(I_B1)).toBe(777)
    expect((await patchItem(I_B1, { name: 'x' })).status).toBe(404)
  })

  it('本文が JSON でない・更新する列がない場合は 400', async () => {
    expect((await patchItem(I_A1, 'not json')).status).toBe(400)
    expect((await patchItem(I_A1, { project_id: P_A2 })).status).toBe(400)
  })
})

describe('一覧（GET /api/cost-ledger）の invoice_count（17. 内訳を開いていない行でも判定）', () => {
  async function list() {
    const res = await listRoute.GET(new NextRequest(`http://localhost/api/cost-ledger?project_id=${P_A1}`))
    return { status: res.status, json: await res.json() as { items?: Row[]; error?: string } }
  }

  beforeEach(() => {
    tables.estimate_items = []
    for (const p of tables.projects) Object.assign(p, { contract_amount: null })
  })

  it('各項目に請求書の件数を付けて返す（削除済み項目は含めない）', async () => {
    await post(I_A1, manual({ amount: 1000 }))
    await post(I_A1, manual({ amount: 2000 }))
    const r = await list()
    expect(r.status).toBe(200)
    const byId = Object.fromEntries(r.json.items!.map(i => [i.id, i.invoice_count]))
    expect(byId).toEqual({ [I_A1]: 2, [I_A1_2]: 0 })
  })

  it('再読み込み：請求書を削除すると件数が 0 に戻り、直接入力できる', async () => {
    const a = ((await post(I_A1, manual({ amount: 1000 }))).json.invoice as Row).id as string
    await deleteInvoice(a)
    const r = await list()
    expect(r.json.items!.find(i => i.id === I_A1)!.invoice_count).toBe(0)
  })

  it('件数の読み取りに失敗したら一覧ごと 500（件数不明のまま編集可能な状態にしない）', async () => {
    failInvoiceRead = true
    const r = await list()
    expect(r.status).toBe(500)
    expect(r.json.items).toBeUndefined()
    expectNoLeak(r.json)
  })

  // ── 取得上限（PostgREST max-rows）を超える件数 ──
  const bulk = (itemId: string, from: number, n: number) => {
    for (let k = 0; k < n; k++) {
      tables.cost_ledger_invoices.push({
        id: id(10000 + from + k), cost_ledger_item_id: itemId, project_id: P_A1, amount: 1,
        invoice_date: null, payment_date: null, note: null, source: 'manual', created_at: '2026-10-01T00:00:00Z',
      })
    }
  }

  it('1,000件を超える請求書も数え落とさない（max-rows 1000）', async () => {
    bulk(I_A1, 0, 1500)
    bulk(I_A1_2, 2000, 3)
    const r = await list()
    expect(r.status).toBe(200)
    const byId = Object.fromEntries(r.json.items!.map(i => [i.id, i.invoice_count]))
    expect(byId).toEqual({ [I_A1]: 1500, [I_A1_2]: 3 })
  })

  it('上限で切られた先にしか請求書がない項目を 0件（直接編集できる）と誤認しない', async () => {
    // 1回の読み取りで返る 1000 行がすべて I_A1。I_A1_2 の1件は 1001 行目以降にしかない
    bulk(I_A1, 0, 1000)
    bulk(I_A1_2, 5000, 1)
    const r = await list()
    expect(r.json.items!.find(i => i.id === I_A1_2)!.invoice_count).toBe(1)
    expect(r.json.items!.find(i => i.id === I_A1)!.invoice_count).toBe(1000)
  })

  it('max-rows が1ページの行数より小さい設定でも正しく数える', async () => {
    maxRows = 7
    bulk(I_A1, 0, 25)
    bulk(I_A1_2, 100, 8)
    const r = await list()
    const byId = Object.fromEntries(r.json.items!.map(i => [i.id, i.invoice_count]))
    expect(byId).toEqual({ [I_A1]: 25, [I_A1_2]: 8 })
  })

  it('途中のページの読み取りに失敗したら一覧ごと 500（途中までの件数を返さない）', async () => {
    bulk(I_A1, 0, 1500)
    failInvoiceReadAfter = 1
    const r = await list()
    expect(r.status).toBe(500)
    expect(r.json.items).toBeUndefined()
    expectNoLeak(r.json)
  })
})

describe('GET（15. 再読み込み後の表示）', () => {
  it('登録した請求書が読み取り情報つきで返り、ハッシュ・キーは返さない', async () => {
    await post(I_A1, ocr())
    const res = await GET(new NextRequest(`http://localhost/api/cost-ledger/${I_A1}/invoices`), { params: Promise.resolve({ id: I_A1 }) })
    const list = await res.json() as Row[]
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(expect.objectContaining({ amount: 33000, source: 'ocr', invoice_number: 'INV-001', vendor_name: 'QA設備' }))
    expect(list[0]).not.toHaveProperty('document_sha256')
    expect(list[0]).not.toHaveProperty('idempotency_key')
  })

  it('他社の台帳項目の請求書は返さない', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/cost-ledger/${I_B1}/invoices`), { params: Promise.resolve({ id: I_B1 }) })
    expect(await res.json()).toEqual([])
  })
})
