/**
 * CostLedgerTab Browser QA 用のインメモリ Fixture バックエンド（開発環境専用）
 *
 * localhost は本番と同じ Supabase を向いているため、原価台帳の書き込み QA は実 DB では行わない。
 * window.fetch を差し替え、CostLedgerTab が使う /api/cost-ledger・/api/project-billing を
 * sessionStorage 上のデータで応答する。許可していない /api/* は 403 でブロックし、実サーバーへ送らない。
 */

export const COST_FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000000c01'
const STORAGE_KEY = 'ragz-qa-cost-ledger-fixture-v1'

type CostItem = {
  id: string; name: string; quantity: number; unit: string
  estimate_cost: number | null; budget_cost: number | null; completion_cost: number | null; actual_cost: number | null
  note: string | null; vendor_name: string | null; sort_order: number; source: string; estimate_item_id: string | null
}
type State = { items: CostItem[]; blocked: string[] }

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
  if (p === '/api/project-billing' && method === 'GET') return json([])
  return null
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

    const res = handle(url, method, init)
    if (res) return res
    const s = load(); s.blocked.push(`${method} ${url.pathname}`); save(s)
    console.warn('[QA cost-ledger fixture] blocked (never sent to server):', method, url.href)
    return json({ error: 'QA fixture: この操作は Fixture 未対応のためブロックしました' }, 403)
  }
}
