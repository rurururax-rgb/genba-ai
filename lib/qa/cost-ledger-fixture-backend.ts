/**
 * CostLedgerTab Browser QA 用のインメモリ Fixture バックエンド（開発環境専用）
 *
 * localhost は本番と同じ Supabase を向いているため、原価台帳の書き込み QA は実 DB では行わない。
 * window.fetch を差し替え、CostLedgerTab が使う /api/cost-ledger・/api/project-billing を
 * sessionStorage 上のデータで応答する。許可していない /api/* は 403 でブロックし、実サーバーへ送らない。
 *
 * 業者請求書（内訳）の登録・AI 読み取りも Fixture で応答する（実際の AI・DB には送らない）。
 *   - AI 読み取りは固定の結果を返し、画像の SHA-256 はブラウザで元のバイト列から計算する
 *   - 登録の検証・似ている請求書の判定は本番 API と同じ lib/cost-ledger/invoice-dedupe を使う
 *   - 一意制約（同じ案件の同じ画像・idempotency_key）は Fixture 内で再現する
 * これは画面の動作確認用で、RLS や DB 制約そのものの検証ではない。
 */

import {
  actualCostMatchesInvoices, findSimilarInvoices, parseInvoiceRequest, sameInvoiceContent, type ExistingInvoice,
} from '@/lib/cost-ledger/invoice-dedupe'

export const COST_FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000000c01'
const STORAGE_KEY = 'ragz-qa-cost-ledger-fixture-v2'

type CostItem = {
  id: string; name: string; quantity: number; unit: string
  estimate_cost: number | null; budget_cost: number | null; completion_cost: number | null; actual_cost: number | null
  note: string | null; vendor_name: string | null; sort_order: number; source: string; estimate_item_id: string | null
}
type FixtureInvoice = ExistingInvoice & {
  payment_date: string | null
  source: string | null
  project_id: string
  document_sha256: string | null
  idempotency_key: string | null
}
/** 次の1回だけ起こす障害（Browser QA で通信エラー・再集計失敗を再現する） */
export type CostFixtureFault = 'lose_next_response' | 'fail_next_sync'
type State = { items: CostItem[]; invoices: FixtureInvoice[]; faults: CostFixtureFault[]; blocked: string[] }

const row = (n: number, p: Partial<CostItem>): CostItem => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `QA-C${n}`, quantity: 1, unit: '式',
  estimate_cost: null, budget_cost: null, completion_cost: null, actual_cost: null,
  note: null, vendor_name: null, sort_order: n, source: 'manual', estimate_item_id: null, ...p,
})

export function createCostSeed(): State {
  return {
    items: [
      row(1, { name: 'QA-C1 システムバス', estimate_cost: 100000, budget_cost: 95000, actual_cost: 90000, vendor_name: 'QA設備' }),
      row(2, { name: 'QA-C2 外壁塗装', estimate_cost: 300000, budget_cost: 280000, vendor_name: 'QA塗装' }),
      row(3, { name: 'QA-C3 足場', estimate_cost: 120000, vendor_name: 'QA足場' }),
    ],
    invoices: [],
    faults: [],
    blocked: [],
  }
}

function load(): State {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as State
  } catch { /* fallthrough */ }
  const s = createCostSeed(); save(s); return s
}
function save(s: State) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}
export function resetCostFixture() { save(createCostSeed()) }
export function armCostFixtureFault(fault: CostFixtureFault) {
  const s = load(); if (!s.faults.includes(fault)) s.faults.push(fault); save(s)
}
function takeFault(s: State, fault: CostFixtureFault) {
  const i = s.faults.indexOf(fault)
  if (i < 0) return false
  s.faults.splice(i, 1); return true
}

/** Fixture の AI 読み取り結果（実際の AI には送らない） */
export const FIXTURE_EXTRACT = {
  vendor_name: 'QA設備', invoice_number: 'QA-INV-001', total_amount: 33000,
  invoice_date: '2026-10-01', payment_due_date: '2026-10-31',
  items: [{ name: 'QA 給湯器部材', amount: 30000 }, { name: '消費税', amount: 3000 }],
  raw_warning: null,
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const INVOICE_FIELDS = ['id', 'cost_ledger_item_id', 'amount', 'invoice_date', 'payment_date', 'note', 'source', 'vendor_name', 'invoice_number', 'created_at'] as const
const publicInvoice = (inv: FixtureInvoice) => Object.fromEntries(INVOICE_FIELDS.map(k => [k, inv[k]]))

/** 本番 API（app/api/cost-ledger/[id]/invoices POST）と同じ順序で判定する */
function postInvoice(s: State, item: CostItem, raw: unknown): { res: Response; loseResponse?: boolean } {
  const parsed = parseInvoiceRequest(raw)
  if (!parsed.ok) return { res: json({ error: parsed.error }, 400) }
  const b = parsed.value
  const nameOf = (id: string) => s.items.find(i => i.id === id)?.name ?? null

  if (b.idempotency_key) {
    const ex = s.invoices.find(i => i.idempotency_key === b.idempotency_key)
    if (ex) {
      if (!sameInvoiceContent(ex, item.id, b)) return { res: json({ error: '同じ登録操作で別の内容が送られました。画面を再読み込みしてください。', code: 'idempotency_conflict' }, 409) }
      // 書き込まずに actual_cost と内訳合計の一致を確かめる（初回の再集計失敗を見逃さない）
      const ok = actualCostMatchesInvoices(item.actual_cost, s.invoices.filter(i => i.cost_ledger_item_id === item.id).map(i => i.amount))
      return { res: json({ invoice: publicInvoice(ex), newActualCost: ok ? item.actual_cost : null, replayed: true, synced: ok }) }
    }
  }
  if (b.source === 'ocr') {
    const dup = s.invoices.find(i => i.project_id === COST_FIXTURE_PROJECT_ID && i.source === 'ocr' && i.document_sha256 === b.document_sha256)
    if (dup) {
      return { res: json({
        error: 'この請求書は登録済みです', code: 'duplicate_document',
        existing: { cost_ledger_item_id: dup.cost_ledger_item_id, item_name: nameOf(dup.cost_ledger_item_id), amount: dup.amount, invoice_date: dup.invoice_date, created_at: dup.created_at },
      }, 409) }
    }
    if (!b.confirm_similar) {
      const similar = findSimilarInvoices(b, s.invoices).map(x => ({
        id: x.id, cost_ledger_item_id: x.cost_ledger_item_id, item_name: nameOf(x.cost_ledger_item_id), amount: x.amount,
        invoice_date: x.invoice_date, vendor_name: x.vendor_name, invoice_number: x.invoice_number, created_at: x.created_at, reason: x.reason,
      }))
      if (similar.length) return { res: json({ error: '以前の請求書と似ています', code: 'similar_invoice', similar }, 409) }
    }
  }

  const inv: FixtureInvoice = {
    id: crypto.randomUUID(), cost_ledger_item_id: item.id, project_id: COST_FIXTURE_PROJECT_ID,
    amount: b.amount, invoice_date: b.invoice_date, payment_date: b.payment_date, note: b.note,
    source: b.source, vendor_name: b.vendor_name, invoice_number: b.invoice_number,
    document_sha256: b.document_sha256, idempotency_key: b.idempotency_key, created_at: new Date().toISOString(),
  }
  s.invoices.push(inv)
  const loseResponse = takeFault(s, 'lose_next_response')
  if (takeFault(s, 'fail_next_sync')) {
    return { res: json({ invoice: publicInvoice(inv), newActualCost: null, replayed: false, synced: false }), loseResponse }
  }
  item.actual_cost = s.invoices.filter(i => i.cost_ledger_item_id === item.id).reduce((a, i) => a + Number(i.amount), 0)
  return { res: json({ invoice: publicInvoice(inv), newActualCost: item.actual_cost, replayed: false, synced: true }), loseResponse }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const sum = (items: CostItem[], key: 'estimate_cost' | 'budget_cost' | 'completion_cost' | 'actual_cost') =>
  items.reduce((a, i) => a + (i[key] ?? 0), 0)

function summaryOf(items: CostItem[]) {
  const revenue = Math.round(sum(items, 'estimate_cost') * 1.45)
  return {
    estimate_revenue: revenue, estimate_cost_total: sum(items, 'estimate_cost'),
    contract_amount: revenue, base_contract_amount: revenue,
    additional_amount_1: null, additional_amount_2: null, additional_amount_3: null,
    budget_cost_total: sum(items, 'budget_cost'), completion_cost_total: sum(items, 'completion_cost'), actual_cost_total: sum(items, 'actual_cost'),
    has_budget_data: items.some(i => i.budget_cost != null), has_completion_data: items.some(i => i.completion_cost != null), has_actual_data: items.some(i => i.actual_cost != null),
  }
}

const PATCH_FIELDS = ['name', 'budget_cost', 'completion_cost', 'actual_cost', 'note', 'vendor_name'] as const

function handle(url: URL, method: string, init: RequestInit | undefined): Response | null {
  const s = load()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const p = url.pathname
  let m: RegExpMatchArray | null

  if (p === '/api/cost-ledger' && method === 'GET') {
    const items = [...s.items].sort((a, b) => a.sort_order - b.sort_order)
    return json({ items, vendorSelling: {}, summary: summaryOf(items) })
  }
  if (p === '/api/cost-ledger' && method === 'POST') {
    const n = Math.max(0, ...s.items.map(i => Number(i.id.slice(-12)))) + 1
    const it = row(n, { name: '新規項目', sort_order: Number(body.sort_order ?? n) })
    s.items.push(it); save(s)
    return json(it)
  }
  if ((m = p.match(/^\/api\/cost-ledger\/([0-9a-f-]{36})$/))) {
    const it = s.items.find(i => i.id === m![1])
    if (!it) return json({ error: 'not found' }, 404)
    if (method === 'PATCH') {
      for (const f of PATCH_FIELDS) if (body[f] !== undefined) (it as Record<string, unknown>)[f] = body[f]
      save(s); return json(it)
    }
    if (method === 'DELETE') { s.items = s.items.filter(i => i.id !== it.id); save(s); return json({ ok: true }) }
  }
  if ((m = p.match(/^\/api\/cost-ledger\/([0-9a-f-]{36})\/invoices$/))) {
    const it = s.items.find(i => i.id === m![1])
    if (method === 'GET') {
      return json(s.invoices.filter(i => i.cost_ledger_item_id === m![1]).map(publicInvoice))
    }
    if (method === 'POST') {
      if (!it) return json({ error: 'Item not found or no access' }, 404)
      const { res, loseResponse } = postInvoice(s, it, body)
      save(s)
      // 保存後に応答が届かなかった状況を再現する（fetch が throw する）
      if (loseResponse) throw new TypeError('QA fixture: response lost after save')
      return res
    }
  }
  if ((m = p.match(/^\/api\/cost-ledger\/invoices\/([0-9a-f-]{36})$/))) {
    const inv = s.invoices.find(i => i.id === m![1])
    if (!inv) return json({ error: 'not found' }, 404)
    const it = s.items.find(i => i.id === inv.cost_ledger_item_id)
    const recalc = () => {
      const rest = s.invoices.filter(i => i.cost_ledger_item_id === inv.cost_ledger_item_id)
      if (it) it.actual_cost = rest.length ? rest.reduce((a, i) => a + Number(i.amount), 0) : null
      return it?.actual_cost ?? null
    }
    if (method === 'PATCH') {
      if (typeof body.amount === 'number') inv.amount = body.amount
      const newActualCost = recalc(); save(s)
      return json({ invoice: publicInvoice(inv), newActualCost })
    }
    if (method === 'DELETE') {
      s.invoices = s.invoices.filter(i => i.id !== inv.id)
      const newActualCost = recalc(); save(s)
      return json({ newActualCost, itemId: inv.cost_ledger_item_id })
    }
  }
  if (p === '/api/project-billing' && method === 'GET') return json([])
  return null
}

async function handleExtract(init: RequestInit | undefined): Promise<Response> {
  const file = init?.body instanceof FormData ? init.body.get('file') : null
  if (!(file instanceof File)) return json({ error: 'No file provided' }, 400)
  // 実際の API と同じく、読み取りには少し時間がかかる（読み取り中の画像変更の QA 用）
  await new Promise(r => setTimeout(r, 800))
  return json({ ...FIXTURE_EXTRACT, document_sha256: await sha256Hex(file) })
}

let installed = false

export function installCostLedgerFixtureBackend() {
  if (installed || typeof window === 'undefined') return
  if (process.env.NODE_ENV === 'production') return
  installed = true
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req    = input instanceof Request ? input : null
    const url    = new URL(req ? req.url : String(input), window.location.href)
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
    const isApi  = url.origin === window.location.origin && url.pathname.startsWith('/api/')
    if (!isApi) return realFetch(input, init)

    if (url.pathname === '/api/ai/extract-vendor-invoice' && method === 'POST') {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return handleExtract(init)
    }
    const res = handle(url, method, init)
    if (res) return res
    const s = load(); s.blocked.push(`${method} ${url.pathname}`); save(s)
    console.warn('[QA cost-ledger fixture] blocked (never sent to server):', method, url.href)
    return json({ error: 'QA fixture: この操作は Fixture 未対応のためブロックしました' }, 403)
  }
}
