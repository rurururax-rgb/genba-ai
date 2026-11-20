/**
 * /qa/estimate（開発環境専用 Fixture）で「過去見積から追加」を Browser QA するための架空の過去明細。
 * 本番 DB・本番データとは無関係。検索・コピーの規則は実 API と同じ lib/estimate/past-copy.ts を使う。
 *
 * QA 用の仕掛け（品名で分かるようにしてある）:
 * - 「QA-P5 金額が変わる明細」: 1 回目のコピーの直前に原価が変わる → 409（新しい金額の確認）
 * - 「QA-P6 結果不明になる明細」: コピーが 500 → 結果不明（再送しない・読み込み直しの案内）
 * - 「QA-P7 削除される明細」    : コピーが 404（コピー元が使えない）
 */

import {
  buildPastItemCopy,
  parsePastCopyRequest,
  parsePastSearchInput,
  pastItemFingerprint,
  planAppendSortOrders,
  planPastItemPrice,
  type PastItemSource,
} from '@/lib/estimate/past-copy'

type PastFixtureItem = PastItemSource & {
  id: string
  created_at: string
  project: { id: string; name: string; status: string; created_at: string }
  group: { id: string; label: string } | null
}

const PROJ_A = { id: '00000000-0000-4000-8000-00000000c001', name: 'QA 架空邸 水まわり改修', status: 'done', created_at: '2026-05-10T00:00:00Z' }
const PROJ_B = { id: '00000000-0000-4000-8000-00000000c002', name: 'QA 架空ビル 内装工事', status: 'done', created_at: '2026-03-02T00:00:00Z' }
const G_SETSUBI = { id: '00000000-0000-4000-8000-00000000c101', label: '住宅設備' }
const G_NAISOU = { id: '00000000-0000-4000-8000-00000000c102', label: '内装' }

const pid = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`
const base = { unit: '式', quantity: 1, vendor_name: 'QA業者', category: null, row_type: 'item' as const, markup_rate_override: null }

const PAST: PastFixtureItem[] = [
  { ...base, id: pid(1), name: 'QA-P1 システムキッチン交換', quantity: 1, unit: '台', cost_price: 400000, selling_price: 580000, selling_price_mode: 'auto', created_at: '2026-05-20T01:00:00Z', project: PROJ_A, group: G_SETSUBI },
  { ...base, id: pid(2), name: 'QA-P2 キッチン撤去処分（サービス）', cost_price: 30000, selling_price: 0, selling_price_mode: 'manual', created_at: '2026-05-19T01:00:00Z', project: PROJ_A, group: G_SETSUBI },
  { ...base, id: pid(3), name: 'QA-P3 キッチンパネル張り', unit: '㎡', quantity: 6, cost_price: null, selling_price: 12000, selling_price_mode: 'auto', created_at: '2026-05-18T01:00:00Z', project: PROJ_A, group: null },
  { ...base, id: pid(4), name: 'QA-P4 床フローリング張替', unit: '㎡', quantity: 20, cost_price: 6000, selling_price: 9000, selling_price_mode: 'manual', created_at: '2026-03-05T01:00:00Z', project: PROJ_B, group: G_NAISOU },
  { ...base, id: pid(5), name: 'QA-P5 金額が変わる明細（キッチン水栓）', cost_price: 40000, selling_price: 58000, selling_price_mode: 'auto', created_at: '2026-05-17T01:00:00Z', project: PROJ_A, group: G_SETSUBI },
  { ...base, id: pid(6), name: 'QA-P6 結果不明になる明細（キッチン換気扇）', cost_price: 50000, selling_price: 72500, selling_price_mode: 'auto', created_at: '2026-05-16T01:00:00Z', project: PROJ_A, group: G_SETSUBI },
  { ...base, id: pid(7), name: 'QA-P7 削除される明細（キッチン照明）', cost_price: 20000, selling_price: 29000, selling_price_mode: 'auto', created_at: '2026-05-15T01:00:00Z', project: PROJ_A, group: G_SETSUBI },
]

/** P5 の原価を 1 回だけ変える（ページを読み込み直すと元に戻る） */
let p5Changed = false

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type FixtureLike = {
  project: { id: string; markup_rate: number }
  groups: Array<{ id: string }>
  items: Array<{ id: string; group_id: string | null; sort_order: number }>
}

function current(it: PastFixtureItem): PastFixtureItem {
  return it.id === pid(5) && p5Changed ? { ...it, cost_price: 48000 } : it
}

export function handlePastEstimateFixture(
  url: URL,
  method: string,
  body: Record<string, unknown>,
  s: FixtureLike,
  /** buildPastItemCopy の行を Fixture の明細として追加する */
  addItem: (row: ReturnType<typeof buildPastItemCopy>['row']) => void,
  save: () => void,
): Response | null {
  const p = url.pathname
  if (p === '/api/estimate-items/search-past' && method === 'GET') {
    const input = parsePastSearchInput(url.searchParams.get('q'), url.searchParams.get('limit'))
    if (!input.ok) return json({ error: input.error }, 400)
    if (url.searchParams.get('project_id') !== s.project.id) return json({ error: 'Project not found' }, 404)
    const hits = PAST.map(current)
      .filter(it => input.terms.every(t => it.name.toLowerCase().includes(t.toLowerCase())))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const page = hits.slice(0, input.limit)
    return json({
      items: page.map(it => ({
        id: it.id, name: it.name, quantity: it.quantity, unit: it.unit, cost_price: it.cost_price,
        selling_price: it.selling_price, selling_price_mode: it.selling_price_mode, vendor_name: it.vendor_name,
        category: it.category, created_at: it.created_at, project: it.project, group: it.group,
        copy_preview: { ...planPastItemPrice(it, s.project.markup_rate), fingerprint: pastItemFingerprint(it, s.project.markup_rate) },
      })),
      has_more: hits.length > input.limit,
    })
  }

  if (p === '/api/estimate-items/copy-from-past' && method === 'POST') {
    const parsed = parsePastCopyRequest(body)
    if (!parsed.ok) return json({ error: parsed.error }, 400)
    const req = parsed.value
    if (req.projectId !== s.project.id) return json({ error: 'Project not found' }, 404)
    if (req.groupId && !s.groups.some(g => g.id === req.groupId)) return json({ error: 'Group not found' }, 404)

    const ids = req.items.map(i => i.sourceItemId)
    if (ids.includes(pid(6))) return json({ error: 'QA: 結果不明の再現（500）' }, 500)
    const missing = ids.filter(id => id === pid(7) || !PAST.some(it => it.id === id))
    if (missing.length) return json({ error: 'コピーできない明細が含まれています。検索し直してください。', missing_source_item_ids: missing }, 404)

    // P5 は「確認したあとに原価が変わった」を再現する（1 回目だけ）
    if (ids.includes(pid(5)) && !p5Changed) p5Changed = true
    const sources = new Map(PAST.map(current).map(it => [it.id, it]))
    const changed = req.items.flatMap(({ sourceItemId, fingerprint }) => {
      const it = sources.get(sourceItemId)!
      const fp = pastItemFingerprint(it, s.project.markup_rate)
      return fp === fingerprint ? [] : [{
        source_item_id: sourceItemId,
        copy_preview: { ...planPastItemPrice(it, s.project.markup_rate), fingerprint: fp },
        item: {
          name: it.name, quantity: it.quantity, unit: it.unit, cost_price: it.cost_price, selling_price: it.selling_price,
          selling_price_mode: it.selling_price_mode, vendor_name: it.vendor_name ?? null, category: it.category ?? null,
        },
      }]
    })
    if (changed.length) return json({ error: '確認後に明細の内容または案件の掛け率が変わりました。', changed }, 409)

    const inGroup = s.items.filter(i => i.group_id === req.groupId)
    const max = inGroup.length ? Math.max(...inGroup.map(i => i.sort_order)) : null
    const orders = planAppendSortOrders(max, req.items.length)
    if (!orders) return json({ error: 'この工種の並び順に空きがありません。' }, 409)
    req.items.forEach(({ sourceItemId }, idx) => {
      const { row } = buildPastItemCopy(sources.get(sourceItemId)!, {
        projectId: s.project.id, companyId: 'qa-fixture', groupId: req.groupId, sortOrder: orders[idx], projectMarkupRate: s.project.markup_rate,
      })
      addItem(row)
    })
    save()
    return json({ inserted_count: req.items.length, items: [] }, 201)
  }
  return null
}
