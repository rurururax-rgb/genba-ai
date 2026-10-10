/**
 * InvoiceTab Browser QA 用のインメモリ Fixture バックエンド（開発環境専用）
 *
 * localhost は本番と同じ Supabase を向いているため、請求書の書き込み QA は実 DB では行わない。
 * window.fetch を差し替え、InvoiceTab が使う /api/invoices を sessionStorage 上のデータで応答する。
 * 許可していない /api/* と Supabase への直接通信（見積合計の集計）はブロックし、実サーバーへ送らない。
 * 差し替えは Fixture ページのマウント中だけ（components/qa/InvoiceFixture.tsx が戻す関数を呼ぶ）。
 * これは画面の動作確認用で、API・DB の検証ではない。
 */

export const INVOICE_FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000000e01'
const STORAGE_KEY = 'ragz-qa-invoice-fixture-v1'

type FixtureInvoice = Record<string, unknown> & { id: string; created_at: string }
type State = { invoices: FixtureInvoice[]; blocked: string[] }

function load(): State {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as State
  } catch { /* fallthrough */ }
  const s: State = { invoices: [], blocked: [] }
  save(s)
  return s
}
function save(s: State) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}
export function resetInvoiceFixture() { save({ invoices: [], blocked: [] }) }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 本番 API（app/api/invoices）と同じ列だけを保存する */
const FIELDS = ['invoice_number', 'payment_type', 'customer_name', 'construction_name', 'issued_at', 'payment_due_at', 'items', 'adjustment', 'memo', 'status', 'printed_at'] as const
const pick = (body: Record<string, unknown>) =>
  Object.fromEntries(FIELDS.filter(k => body[k] !== undefined).map(k => [k, body[k]]))

function handle(url: URL, method: string, init: RequestInit | undefined): Response | null {
  const s = load()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const p = url.pathname
  const now = new Date().toISOString()

  if (p === '/api/invoices' && method === 'GET') {
    return json([...s.invoices].sort((a, b) => b.created_at.localeCompare(a.created_at)))
  }
  if (p === '/api/invoices' && method === 'POST') {
    const inv: FixtureInvoice = {
      id: crypto.randomUUID(), project_id: INVOICE_FIXTURE_PROJECT_ID,
      invoice_number: null, payment_type: 'custom', customer_name: null, construction_name: null,
      issued_at: now.slice(0, 10), payment_due_at: null, items: [], adjustment: 0, memo: null, status: 'draft',
      printed_at: null, created_at: now, updated_at: now,
      ...pick(body),
    }
    s.invoices.push(inv); save(s)
    return json(inv, 201)
  }
  const m = p.match(/^\/api\/invoices\/([0-9a-f-]{36})$/)
  if (m) {
    const inv = s.invoices.find(i => i.id === m[1])
    if (!inv) return json({ error: 'not found' }, 404)
    if (method === 'PATCH') { Object.assign(inv, pick(body), { updated_at: now }); save(s); return json(inv) }
    if (method === 'DELETE') { s.invoices = s.invoices.filter(i => i.id !== inv.id); save(s); return json({ ok: true }) }
  }
  return null
}

/** 差し替え中の fetch と元の fetch（未インストールなら null） */
let active: { patched: typeof window.fetch; original: typeof window.fetch; users: number } | null = null

/**
 * window.fetch を差し替え、元に戻す関数を返す（Fixture ページのマウント中だけ有効にする）。
 * 複数回呼ばれた場合は、最後の戻す関数が呼ばれたときに元の fetch に戻す。
 * 本番ビルド・サーバー側では何もしない（false を返す。呼び出し側は画面を出さない）。
 */
export function installInvoiceFixtureBackend(): (() => void) | false {
  if (typeof window === 'undefined') return false
  if (process.env.NODE_ENV === 'production') return false
  if (active) {
    active.users++
    return releaseOnce()
  }
  const original = window.fetch
  const realFetch = original.bind(window)
  const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : null

  const patched: typeof window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req    = input instanceof Request ? input : null
    const url    = new URL(req ? req.url : String(input), window.location.href)
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
    const isApi  = url.origin === window.location.origin && url.pathname.startsWith('/api/')
    const isSupabase = url.origin === supabaseOrigin || url.hostname.endsWith('.supabase.co')
    if (!isApi && !isSupabase) return realFetch(input, init)

    const res = isApi ? handle(url, method, init) : null
    if (res) return res
    const s = load(); s.blocked.push(`${method} ${url.origin === window.location.origin ? url.pathname : url.hostname + url.pathname}`); save(s)
    console.warn('[QA invoice fixture] blocked (never sent to server):', method, url.href)
    return json({ error: 'QA fixture: この操作は Fixture 未対応のためブロックしました' }, 403)
  }
  window.fetch = patched
  active = { patched, original, users: 1 }
  return releaseOnce()
}

/** window.fetch が今この Fixture に差し替わっているか */
export function isInvoiceFixtureBackendActive(): boolean {
  return active !== null && typeof window !== 'undefined' && window.fetch === active.patched
}

function releaseOnce(): () => void {
  let released = false
  return () => {
    if (released || !active) return
    released = true
    if (--active.users > 0) return
    // 他のコードがさらに上書きしていたら、それは壊さない（自分の差し替えのときだけ戻す）
    if (window.fetch === active.patched) window.fetch = active.original
    active = null
  }
}
