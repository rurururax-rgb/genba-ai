/**
 * EstimateTab Browser QA 用のインメモリ Fixture バックエンド（開発環境専用）
 *
 * 目的:
 *   localhost の Supabase は本番プロジェクトを向いているため、書き込みを伴う Browser QA を
 *   実DBで行ってはいけない。このモジュールは window.fetch を差し替え、EstimateTab が発行する
 *   Supabase REST / Next.js API 呼び出しを sessionStorage 上の Fixture で応答する。
 *
 * 安全設計:
 *   - 許可リストにない API / Supabase REST 呼び出しはすべて 403 でブロックし、実サーバーへ送らない
 *   - Supabase Auth（/auth/v1/）のみ素通し（業務データを書き換えない）
 *   - サーバー側ロジックは実装と同じ規則で再現する
 *       PATCH /api/estimate-items/[id]      … 指定フィールドのみ更新、amount = quantity × selling_price
 *       POST  /api/estimate-items/manual    … 実APIと同じく selling_price_mode / markup_rate_override を返さない
 *       POST  /api/projects/[id]/apply-markup-rate … apply_markup_rate_change() RPC と同じ対象・ROUND
 *       POST  /api/estimate-items/reorder   … groups / items の sort_order・group_id を一括更新
 *       POST/PATCH/DELETE /api/estimate-groups … 工種グループの追加・名称変更・削除
 */

import { MAX_MARKUP_RATE, MIN_MARKUP_RATE } from '@/lib/estimate/pricing'

export const FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000000a01'
// v2: internal_memo（社内メモ）を追加。v1 のデータは破棄して再シードする
const STORAGE_KEY = 'ragz-qa-estimate-fixture-v2'

type FixtureItem = {
  id: string
  name: string
  category: string | null
  quantity: number
  unit: string
  selling_price: number | null
  amount: number | null
  retail_price: number | null
  cost_price: number | null
  vendor_name: string | null
  group_id: string | null
  sort_order: number
  source: string
  line_event_id: string | null
  memo: string | null
  internal_memo: string | null
  row_type: 'item' | 'header' | 'note'
  selling_price_mode: 'auto' | 'manual'
  markup_rate_override: number | null
}

type FixtureState = {
  project: { id: string; markup_rate: number; misc_expense_override: number | null; rounding_discount: number | null }
  groups:  Array<{ id: string; label: string; display_mode: string; sort_order: number }>
  items:   FixtureItem[]
  blocked: string[]
}

const GROUP_ID = '00000000-0000-4000-8000-00000000a001'

function item(n: number, p: Partial<FixtureItem>): FixtureItem {
  const base: FixtureItem = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: '新規項目', category: null, quantity: 1, unit: '式',
    selling_price: null, amount: null, retail_price: null, cost_price: null, vendor_name: null,
    group_id: GROUP_ID, sort_order: n, source: 'manual', line_event_id: null, memo: null, internal_memo: null,
    row_type: 'item', selling_price_mode: 'auto', markup_rate_override: null,
  }
  const r = { ...base, ...p }
  r.amount = r.selling_price != null ? r.quantity * r.selling_price : null
  return r
}

/** Scenario QA 用の初期データ（本番データとは無関係） */
export function createSeed(): FixtureState {
  return {
    project: { id: FIXTURE_PROJECT_ID, markup_rate: 1.45, misc_expense_override: null, rounding_discount: 0 },
    groups:  [{ id: GROUP_ID, label: '内装', display_mode: 'detail', sort_order: 0 }],
    items: [
      // S1: 原価100,000 AUTO → 145,000 / 31.0%
      item(1, { name: 'QA-1 システムバス', category: '設備機器', cost_price: 100000, selling_price: 145000, vendor_name: 'QA設備', memo: '型番 QA-100' }),
      // 旧UIで「個別1.60 / 31.0%」と矛盾表示していたケース（MANUAL + 未反映 override）
      item(2, { name: 'QA-2 既設デッキ撤去処分', cost_price: 20000, selling_price: 29000, selling_price_mode: 'manual', markup_rate_override: 1.6, vendor_name: 'QA解体' }),
      // 「32万」確認用（原価 320,000 は必ず 320,000 と表示されること）
      item(3, { name: 'QA-3 ダイキンエアコン S806ATAP', unit: '台', cost_price: 320000, selling_price: 464000, retail_price: 520000, vendor_name: 'QA電工', memo: 'S806ATAP' }),
      // S6: 原価NULL・売価NULL（AUTO）
      item(4, { name: 'QA-4 新規項目（原価未入力）' }),
      // 原価NULL・売価のみ手入力
      item(5, { name: 'QA-5 諸材料（売価のみ）', cost_price: null, selling_price: 50000, selling_price_mode: 'manual' }),
      // AUTO + override（案件標準変更の対象外）
      item(6, { name: 'QA-6 庭石ハツリ', cost_price: 60000, selling_price: 72000, markup_rate_override: 1.2, vendor_name: 'QA土木' }),
      item(7, { name: 'QA-7 クロス施工', quantity: 42, unit: '㎡', cost_price: 1000, selling_price: 1450, vendor_name: 'QA内装' }),
      // 備考シナリオ（お客様向け備考 / 社内メモ）
      //   N1: 両方あり  N2: お客様向けのみ  N3: 社内メモのみ  N4: 両方なし
      item(8,  { name: 'QA-N1 外壁塗装', cost_price: 300000, selling_price: 435000, vendor_name: 'QA塗装',
                 memo: '工事期間中は駐車スペースをお借りします', internal_memo: '見積No. ABC-123' }),
      item(9,  { name: 'QA-N2 雨樋交換', cost_price: 50000, selling_price: 72500, vendor_name: 'QA板金',
                 memo: '既存雨樋は撤去処分いたします' }),
      item(10, { name: 'QA-N3 足場', cost_price: 120000, selling_price: 174000, vendor_name: 'QA足場',
                 internal_memo: '仕入先管理番号 SK-0912 / 田中さん確認済' }),
      item(11, { name: 'QA-N4 養生', cost_price: 20000, selling_price: 29000 }),
    ],
    blocked: [],
  }
}

function load(): FixtureState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as FixtureState
  } catch { /* fallthrough */ }
  const s = createSeed(); save(s); return s
}
function save(s: FixtureState) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

export function resetFixture() { save(createSeed()) }
export function readFixture(): FixtureState { return load() }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function omit<T extends object>(obj: T, keys: Array<keyof T>): Partial<T> {
  const r: Partial<T> = { ...obj }
  for (const k of keys) delete r[k]
  return r
}

/** Postgres ROUND(numeric) と同じ（0.5 は 0 から遠い方向へ） */
const pgRound = (x: number) => Math.sign(x) * Math.round(Math.abs(x))

const ITEM_PATCH_FIELDS = [
  'quantity', 'selling_price', 'retail_price', 'name', 'unit', 'memo', 'cost_price',
  'vendor_name', 'category', 'row_type', 'selling_price_mode', 'markup_rate_override', 'internal_memo',
] as const

async function handle(url: URL, method: string, init: RequestInit | undefined, accept: string): Promise<Response | null> {
  const s = load()
  // JSON 以外（FormData 等：OCR のファイル送信）は本文を解釈しない
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}

  // ── Supabase REST（読み取りのみ） ──
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.slice('/rest/v1/'.length)
    if (method !== 'GET') return null
    if (table === 'projects') {
      const obj = { markup_rate: s.project.markup_rate, misc_expense_override: s.project.misc_expense_override, rounding_discount: s.project.rounding_discount }
      return json(accept.includes('vnd.pgrst.object') ? obj : [obj])
    }
    if (table === 'estimate_groups') return json([...s.groups].sort((a, b) => a.sort_order - b.sort_order))
    if (table === 'estimate_items')  return json([...s.items].sort((a, b) => a.sort_order - b.sort_order))
    return null
  }

  // ── Next.js API ──
  const p = url.pathname
  let m: RegExpMatchArray | null
  if ((m = p.match(/^\/api\/estimate-items\/([0-9a-f-]{36})$/))) {
    const it = s.items.find(i => i.id === m![1])
    if (!it) return json({ error: 'not found' }, 404)
    if (method === 'PATCH') {
      for (const f of ITEM_PATCH_FIELDS) if (body[f] !== undefined) (it as Record<string, unknown>)[f] = body[f]
      it.amount = it.selling_price != null ? it.quantity * it.selling_price : null
      save(s)
      return json(omit(it, ['group_id', 'sort_order']))
    }
    if (method === 'DELETE') { s.items = s.items.filter(i => i.id !== it.id); save(s); return json({ ok: true }) }
    return null
  }
  if (p === '/api/estimate-items/manual' && method === 'POST') {
    const n = Math.max(0, ...s.items.map(i => Number(i.id.slice(-12)))) + 1
    const it = item(n, {
      name: String(body.name ?? '').trim() || (body.row_type && body.row_type !== 'item' ? '' : '新規項目'),
      quantity: Number(body.quantity ?? 1), unit: String(body.unit ?? '式'),
      group_id: (body.group_id as string | null) ?? null, sort_order: Number(body.sort_order ?? 0),
      row_type: (body.row_type as FixtureItem['row_type']) ?? 'item',
    })
    s.items.push(it); save(s)
    // 実APIの select と同じ列だけ返す（selling_price_mode / markup_rate_override / retail_price は返らない）
    return json(omit(it, ['selling_price_mode', 'markup_rate_override', 'retail_price']))
  }
  // 並び替え・行間 ＋ の振り直し（実APIと同じく groups / items の sort_order・group_id を更新）
  // window.__QA_FAIL_REORDER = true で失敗（500）を再現できる
  if (p === '/api/estimate-items/reorder' && method === 'POST') {
    if ((window as unknown as { __QA_FAIL_REORDER?: boolean }).__QA_FAIL_REORDER) return json({ error: 'QA: reorder failed' }, 500)
    for (const g of (body.groups as Array<{ id: string; sort_order: number }> | undefined) ?? []) {
      const t = s.groups.find(x => x.id === g.id); if (t) t.sort_order = g.sort_order
    }
    for (const u of (body.items as Array<{ id: string; sort_order: number; group_id: string | null }> | undefined) ?? []) {
      const t = s.items.find(x => x.id === u.id); if (t) { t.sort_order = u.sort_order; t.group_id = u.group_id }
    }
    save(s)
    return json({ ok: true })
  }
  // 工種グループの追加・名称変更・削除
  if (p === '/api/estimate-groups' && method === 'POST') {
    const n = s.groups.length + 1
    const g = { id: `00000000-0000-4000-8000-00000000b${String(n).padStart(3, '0')}`, label: String(body.label ?? ''), display_mode: 'detail', sort_order: Number(body.sort_order ?? 0) }
    s.groups.push(g); save(s)
    return json(g)
  }
  if ((m = p.match(/^\/api\/estimate-groups\/([0-9a-f-]{36})$/))) {
    const g = s.groups.find(x => x.id === m![1])
    if (!g) return json({ error: 'not found' }, 404)
    if (method === 'PATCH') {
      if (body.label !== undefined) g.label = String(body.label)
      if (body.display_mode !== undefined) g.display_mode = String(body.display_mode)
      save(s); return json(g)
    }
    if (method === 'DELETE') {
      s.groups = s.groups.filter(x => x.id !== g.id)
      s.items  = s.items.filter(i => i.group_id !== g.id)
      save(s); return json({ ok: true })
    }
    return null
  }
  // OCR / AI 読み取りの代替（Claude Vision は呼ばない）。元見積書の備考欄に社内情報が入っているケースを再現
  if (p === '/api/ai/extract-estimate' && method === 'POST') {
    const items = [
      { name: 'QA-OCR 給湯器 GT-2460', quantity: 1, unit: '台', cost_price: 180000, vendor_name: 'QA設備商事', note: '見積No. 12345' },
      { name: 'QA-OCR 配管工事',       quantity: 1, unit: '式', cost_price: 40000,  vendor_name: 'QA設備商事', note: '担当 佐藤 / 社内確認済' },
    ]
    return json({ files: [{ fileName: 'qa.png', supplier: 'QA設備商事', document_type: '御見積書', items, subtotal: 220000, raw_warning: null }], items })
  }
  // 実 API と同じ規則：取込の備考は internal_memo（社内メモ）のみ。memo（お客様向け備考）には入れない
  if (p === '/api/estimate-items/import' && method === 'POST') {
    const rows = (body.items as Array<Record<string, unknown>>) ?? []
    let n = Math.max(0, ...s.items.map(i => Number(i.id.slice(-12))))
    const base = typeof body.sort_order === 'number' ? body.sort_order : Math.max(-1, ...s.items.map(i => i.sort_order)) + 1
    rows.forEach((r, i) => {
      const cost = typeof r.cost_price === 'number' ? r.cost_price : null
      const selling = cost != null && cost > 0 ? pgRound(cost * s.project.markup_rate) : null
      const note = String((r.internal_memo ?? r.memo ?? '') as string).trim() || null
      s.items.push(item(++n, {
        name: String(r.name ?? ''), quantity: Number(r.quantity ?? 1), unit: String(r.unit ?? '式'),
        cost_price: cost, selling_price: selling, vendor_name: (r.vendor_name as string | null) ?? null,
        group_id: (body.group_id as string | null) ?? GROUP_ID, sort_order: base + i, source: 'import',
        memo: null, internal_memo: note,
      }))
    })
    save(s)
    return json({ created: rows.length })
  }
  if (p === `/api/projects/${FIXTURE_PROJECT_ID}/apply-markup-rate` && method === 'POST') {
    const rate = Number(body.new_rate)
    if (!Number.isFinite(rate) || rate < MIN_MARKUP_RATE || rate > MAX_MARKUP_RATE)
      return json({ error: '掛け率は 0.01〜9.99 の範囲で入力してください。' }, 400)
    s.project.markup_rate = rate
    for (const it of s.items) {
      if (it.selling_price_mode === 'auto' && it.markup_rate_override == null && it.cost_price != null) {
        it.selling_price = pgRound(it.cost_price * rate)
        it.amount = it.quantity * it.selling_price
      }
    }
    save(s)
    return json({ ok: true })
  }
  if (p === `/api/projects/${FIXTURE_PROJECT_ID}` && method === 'PATCH') {
    if (body.misc_expense_override !== undefined) s.project.misc_expense_override = body.misc_expense_override as number | null
    if (body.rounding_discount     !== undefined) s.project.rounding_discount     = body.rounding_discount as number | null
    save(s); return json({ ok: true })
  }
  if (p === '/api/estimate-revisions' && method === 'GET') return json([])
  return null
}

let installed = false

/** window.fetch を差し替える。開発環境の QA ページからのみ呼ぶこと */
export function installEstimateFixtureBackend() {
  if (installed || typeof window === 'undefined') return
  // 本番ビルドでは何もしない（ページ側でも notFound() 済み）
  if (process.env.NODE_ENV === 'production') return
  installed = true
  const realFetch = window.fetch.bind(window)
  const supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req    = input instanceof Request ? input : null
    const url    = new URL(req ? req.url : String(input), window.location.href)
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
    const accept = new Headers(init?.headers ?? req?.headers).get('Accept') ?? ''

    const isSupabase = url.origin === supabaseOrigin
    const isApi      = url.origin === window.location.origin && url.pathname.startsWith('/api/')

    // 業務データに触れない通信は素通し（Next.js の静的資産・HMR・Supabase Auth）
    if (!isSupabase && !isApi) return realFetch(input, init)
    if (isSupabase && url.pathname.startsWith('/auth/v1/')) return realFetch(input, init)

    const res = await handle(url, method, init, accept)
    if (res) return res

    const s = load(); s.blocked.push(`${method} ${url.pathname}`); save(s)
    console.warn('[QA fixture] blocked (never sent to server):', method, url.href)
    return json({ error: 'QA fixture: この操作は Fixture 未対応のためブロックしました' }, 403)
  }
}
