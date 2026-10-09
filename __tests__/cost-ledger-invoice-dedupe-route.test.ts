import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/cost-ledger/[id]/invoices の二重登録防止（P1-1 / PR #30）。
 * Supabase はメモリ上の偽クライアントで置き換える。
 *   - RLS: cost_ledger_items / projects は自社 company_id の行、cost_ledger_invoices は親の台帳項目が見える行だけ
 *   - migration 20261010000001 の一意制約（同じ案件 × 同じ画像の OCR、idempotency_key）と CHECK 制約を再現する
 * 実 DB の RLS・制約そのものの検証ではない（それは migration の PGlite 検証と本番適用後の確認 SQL で行った）。
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
let failNextActualCostUpdate: boolean
let failInvoiceRead: boolean
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
  failNextActualCostUpdate = false
  failInvoiceRead = false
  missNextKeyLookup = false
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
    if (table === 'cost_ledger_items' && 'actual_cost' in payload! && failNextActualCostUpdate) {
      failNextActualCostUpdate = false
      return (writeResult = { rows: [], error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    }
    const rows = visible(table).filter(r => filters.every(f => f(r)))
    for (const r of rows) Object.assign(r, payload)
    return (writeResult = { rows, error: null })
  }

  const run = () => {
    if (mode !== 'select') {
      const w = doWrite()
      return { data: w.error ? null : w.rows.map(r => pick(r, cols)), error: w.error }
    }
    if (table === 'cost_ledger_invoices' && failInvoiceRead) return { data: null, error: { code: '57014', message: 'timeout' } }
    if (table === 'cost_ledger_invoices' && byKey && missNextKeyLookup) {
      missNextKeyLookup = false
      return { data: [], error: null }
    }
    return { data: visible(table).filter(r => filters.every(f => f(r))).map(r => pick(r, cols)), error: null }
  }
  const one = (strict: boolean) => {
    const { data, error } = run()
    if (error) return Promise.resolve({ data: null, error })
    if (data!.length === 1) return Promise.resolve({ data: data![0], error: null })
    if (data!.length === 0 && !strict) return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not exactly one row' } })
  }
  const q = {
    select: (c?: string) => { cols = c ?? null; return q },
    eq: (col: string, v: unknown) => { if (col === 'idempotency_key') byKey = true; filters.push(r => r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    in: (col: string, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return q },
    order: () => q,
    single: () => one(true),
    maybeSingle: () => one(false),
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
    insert: (row: Row) => { mode = 'insert'; payload = row; return q },
    update: (row: Row) => { mode = 'update'; payload = row; return q },
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
    from,
  }),
}))

const { POST, GET } = await import('@/app/api/cost-ledger/[id]/invoices/route')

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

beforeEach(() => {
  currentUser = ME
  seq = 0
  seed()
})

describe('OCR 登録', () => {
  it('1. 初回の OCR 登録ができ、project_id は親の台帳項目から保存される', async () => {
    const r = await post(I_A1, { ...ocr(), project_id: P_A2 /* 本文の project_id は使わない */ })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ newActualCost: 33000, replayed: false, synced: true }))
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

describe('actual_cost の再集計（16）', () => {
  it('保存後の再集計に失敗しても登録失敗にしない（synced: false・newActualCost: null）', async () => {
    failNextActualCostUpdate = true
    const r = await post(I_A1, ocr())
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ synced: false, newActualCost: null, replayed: false }))
    expect(invoiceCount()).toBe(2)
    // 再送しても二重にならない（保存済みとして返る）
    const again = await post(I_A1, ocr())
    expect(again.json.replayed).toBe(true)
    expect(invoiceCount()).toBe(2)
  })

  it('再集計失敗 → 応答喪失 → 同じキーで再送：請求は1件のまま、古い actual_cost を正常反映と表示しない', async () => {
    // 1・2. 初回 INSERT は成功、actual_cost の再集計は失敗（actual_cost は古いまま null）
    failNextActualCostUpdate = true
    await post(I_A1, manual({ idempotency_key: KEY1, amount: 50000 }))   // 3. この応答は届かなかったとする
    expect(actualCost(I_A1)).toBeNull()
    // 3. 同じキーで再送
    const retry = await post(I_A1, manual({ idempotency_key: KEY1, amount: 50000 }))
    expect(retry.status).toBe(200)
    // 4. 請求書は1件のみ・原価を二重加算しない（再送では書き込まない）
    expect(tables.cost_ledger_invoices.filter(i => i.cost_ledger_item_id === I_A1)).toHaveLength(1)
    expect(actualCost(I_A1)).toBeNull()
    // 5. 「保存済み」だが「原価合計も正常」とは言わない
    expect(retry.json).toEqual(expect.objectContaining({ replayed: true, synced: false, newActualCost: null }))
  })

  it('再送時に actual_cost が古い値（見積原価など）のままでも synced: true にしない', async () => {
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 100000   // 初期化時の見積原価
    failNextActualCostUpdate = true
    await post(I_A1, ocr())
    const retry = await post(I_A1, ocr())
    expect(retry.json).toEqual(expect.objectContaining({ replayed: true, synced: false, newActualCost: null }))
    expect(actualCost(I_A1)).toBe(100000)
  })

  it('登録しなかった場合（重複）は再集計しない', async () => {
    await post(I_A1, ocr())
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 12345   // 手入力の値とする
    await post(I_A1, ocr({ idempotency_key: KEY2 }))
    expect(actualCost(I_A1)).toBe(12345)
  })

  it('再送（replayed）では再集計しない。内訳合計と一致しない actual_cost は synced: false', async () => {
    await post(I_A1, ocr())
    tables.cost_ledger_items.find(i => i.id === I_A1)!.actual_cost = 12345
    const r = await post(I_A1, ocr())
    expect(r.json).toEqual(expect.objectContaining({ replayed: true, synced: false, newActualCost: null }))
    expect(actualCost(I_A1)).toBe(12345)   // 書き換えない
  })

  it('再送で actual_cost が内訳合計と一致していれば synced: true と DB の値を返す', async () => {
    await post(I_A1, ocr())
    const r = await post(I_A1, ocr())
    expect(r.json).toEqual(expect.objectContaining({ replayed: true, synced: true, newActualCost: 33000 }))
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
