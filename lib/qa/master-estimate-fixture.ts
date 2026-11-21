/**
 * /qa/estimate（開発環境専用 Fixture）で「資材マスターから追加」を Browser QA するための架空の資材マスター。
 * 本番 DB・本番データとは無関係。検索・追加の規則は実 API と同じ lib/estimate/master-copy.ts を使う。
 *
 * QA 用の仕掛け（品名で分かるようにしてある）:
 * - 「QA-M4 金額が変わる資材」 : 1 回目の追加の直前に原価が変わる → 409（いまの内容の確認）
 * - 「QA-M5 結果不明になる資材」: 追加が 500 → 結果不明（再送しない・読み込み直しの案内）
 * - 「QA-M6 削除される資材」    : 追加が 404（資材マスターから削除された）
 */

import {
  buildMasterItemRow,
  masterItemFingerprint,
  parseMasterAddRequest,
  parseMasterSearchInput,
  planMasterItemPrice,
  resolveMarkupRate,
  type MasterItemSource,
} from '@/lib/estimate/master-copy'
import { planAppendSortOrders } from '@/lib/estimate/past-copy'

type MasterFixtureItem = MasterItemSource & { id: string; usage_count: number }

const mid = (n: number) => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, '0')}`

const MASTER: MasterFixtureItem[] = [
  { id: mid(1), name: 'QA-M1 ユニットバス 1616', spec: 'QA-HTV1616 / 架空メーカー', unit: '台', cost_price: 600000, selling_price: 900000, category: '設備', usage_count: 12 },
  { id: mid(2), name: 'QA-M2 クロス張替（量産品）', spec: null, unit: '㎡', cost_price: 1000, selling_price: null, category: '内装', usage_count: 8 },
  { id: mid(3), name: 'QA-M3 諸経費', spec: null, unit: '式', cost_price: null, selling_price: null, category: null, usage_count: 5 },
  { id: mid(4), name: 'QA-M4 金額が変わる資材（給湯器）', spec: 'QA-GT2460', unit: '台', cost_price: 180000, selling_price: null, category: '設備', usage_count: 3 },
  { id: mid(5), name: 'QA-M5 結果不明になる資材（換気扇）', spec: null, unit: '台', cost_price: 30000, selling_price: 45000, category: '設備', usage_count: 2 },
  { id: mid(6), name: 'QA-M6 削除される資材（照明）', spec: null, unit: '台', cost_price: 20000, selling_price: null, category: '電気', usage_count: 1 },
]

/** M4 の原価を 1 回だけ変える（ページを読み込み直すと元に戻る） */
let m4Changed = false
const current = (it: MasterFixtureItem): MasterFixtureItem =>
  it.id === mid(4) && m4Changed ? { ...it, cost_price: 195000 } : it

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type FixtureLike = {
  project: { id: string; markup_rate: number }
  groups: Array<{ id: string }>
  items: Array<{ id: string; group_id: string | null; sort_order: number }>
}

function toHit(it: MasterFixtureItem, rate: number) {
  return {
    id: it.id, name: it.name, spec: it.spec, unit: it.unit, cost_price: it.cost_price, selling_price: it.selling_price, category: it.category,
    preview: { ...planMasterItemPrice(it, rate), fingerprint: masterItemFingerprint(it, rate) },
  }
}

export function handleMasterEstimateFixture(
  url: URL,
  method: string,
  body: Record<string, unknown>,
  s: FixtureLike,
  addItem: (row: ReturnType<typeof buildMasterItemRow>) => void,
  save: () => void,
): Response | null {
  const p = url.pathname
  if (p === '/api/estimate-items/search-master' && method === 'GET') {
    const input = parseMasterSearchInput(url.searchParams.get('q'), url.searchParams.get('limit'))
    if (!input.ok) return json({ error: input.error }, 400)
    if (url.searchParams.get('project_id') !== s.project.id) return json({ error: 'Project not found' }, 404)
    const hits = MASTER.map(current)
      .filter(it => input.terms.every(t => it.name.toLowerCase().includes(t.toLowerCase())))
      .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name))
    return json({
      items: hits.slice(0, input.limit).map(it => toHit(it, s.project.markup_rate)),
      has_more: hits.length > input.limit,
      markup_rate: resolveMarkupRate(s.project.markup_rate),
    })
  }

  if (p === '/api/estimate-items/add-from-master' && method === 'POST') {
    const parsed = parseMasterAddRequest(body)
    if (!parsed.ok) return json({ error: parsed.error }, 400)
    const req = parsed.value
    if (req.projectId !== s.project.id) return json({ error: 'Project not found' }, 404)
    if (req.groupId && !s.groups.some(g => g.id === req.groupId)) return json({ error: 'Group not found' }, 404)
    if (req.masterItemId === mid(5)) return json({ error: 'QA: 結果不明の再現（500）' }, 500)
    const found = MASTER.find(it => it.id === req.masterItemId)
    if (!found || found.id === mid(6)) {
      return json({ error: 'この資材は資材マスターから削除されたか、見つかりません。検索し直してください。', reason: 'master_not_found' }, 404)
    }
    if (found.id === mid(4) && !m4Changed) m4Changed = true
    const it = current(found)
    const fp = masterItemFingerprint(it, s.project.markup_rate)
    if (fp !== req.fingerprint) {
      return json({ error: '資材マスターの内容か、案件の掛け率が変わりました。内容を確認してからもう一度追加してください。', item: toHit(it, s.project.markup_rate) }, 409)
    }
    const inGroup = s.items.filter(i => i.group_id === req.groupId)
    const orders = planAppendSortOrders(inGroup.length ? Math.max(...inGroup.map(i => i.sort_order)) : null, 1)
    if (!orders) return json({ error: 'この工種の並び順に空きがありません。' }, 409)
    addItem(buildMasterItemRow(it, req, {
      projectId: s.project.id, companyId: 'qa-fixture', groupId: req.groupId, sortOrder: orders[0], projectMarkupRate: s.project.markup_rate,
    }))
    save()
    return json({ item: { id: 'qa' } }, 201)
  }
  return null
}
