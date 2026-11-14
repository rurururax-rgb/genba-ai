/**
 * GET /api/estimate-items/search-past?q=<検索語>&project_id=<開いている案件>&limit=<件数>
 *
 * 自社の過去案件にある見積明細を品名で検索する（読み取りのみ。書き込みはしない）。
 * - getServerClient()（RLS 有効）だけを使う。admin.ts は使わない
 * - 会社の絞り込みは RLS に加えて company_id でも明示する
 * - 削除済みの明細・削除済みの案件の明細・見出し行・メモ行は DB の検索条件で除く
 *   （件数の上限は、有効な明細だけが残った後にかかる。row_type が NULL の古い行は明細として扱う）
 * - 削除済み・別案件の工種の名前は返さない（その場合は未分類として返す。行そのものは除かない）
 * - project_id（開いている案件）を渡すと、その案件の明細は除き、その案件の標準掛け率で計算した
 *   コピー後の売価と変更検知用の fingerprint（copy_preview）を付ける。他社・削除済み・存在しない案件は区別せず 404
 * - お客様向け備考・社内メモは返さない（コピーするかどうかは後続の PR で利用者が選ぶ）
 * - DB のエラー文は返さない（サーバーログのみ）
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isActiveProject, isUuid } from '@/lib/estimate/ownership'
import {
  escapeLikePattern,
  parsePastSearchInput,
  pastItemFingerprint,
  planPastItemPrice,
  type PastCopyPricePreview,
} from '@/lib/estimate/past-copy'
import type { SellingPriceMode } from '@/lib/estimate/pricing'

/**
 * estimate_items → projects の外部キーは 2 本ある（project_id 単独と、(project_id, company_id) の複合）。
 * ヒントなしの埋め込みは PostgREST があいまい（PGRST201）として拒否するため、単独の外部キー名を指定する。
 * 名前は初期スキーマ（20260705000001）の `project_id ... REFERENCES projects(id)` の既定名。
 */
const PROJECT_EMBED = 'projects!estimate_items_project_id_fkey!inner ( id, name, status, created_at, company_id, deleted_at )'

type ItemRow = {
  id: string
  project_id: string
  group_id: string | null
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  selling_price: number | null
  selling_price_mode: SellingPriceMode | null
  vendor_name: string | null
  category: string | null
  created_at: string
  projects: { id: string; name: string; status: string | null; created_at: string | null } | null
}

export type PastEstimateHit = {
  id: string
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  selling_price: number | null
  selling_price_mode: SellingPriceMode
  vendor_name: string | null
  category: string | null
  created_at: string
  project: { id: string; name: string; status: string | null; created_at: string | null }
  group: { id: string; label: string } | null
  /**
   * project_id を渡したときだけ。コピー先案件の標準掛け率で計算したコピー後の売価と、
   * コピー API（POST /api/estimate-items/copy-from-past）に送り返す変更検知用の fingerprint
   */
  copy_preview?: PastCopyPricePreview & { fingerprint: string }
}

const serverError = (tag: string, error: { code?: string | null; message?: string } | null) => {
  console.error(`[estimate-items/search-past ${tag}]`, error?.code, error?.message)
  return NextResponse.json({ error: '検索できませんでした。もう一度お試しください。' }, { status: 500 })
}

export async function GET(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })
  const companyId = membership.company_id as string

  const params = req.nextUrl.searchParams
  const input = parsePastSearchInput(params.get('q'), params.get('limit'))
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })

  // 開いている案件（任意）。渡されたら自社の有効な案件か確かめ、掛け率を読む
  const targetProjectId = params.get('project_id')
  let targetMarkupRate: number | null | undefined
  if (targetProjectId != null && targetProjectId !== '') {
    if (!isUuid(targetProjectId)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    if (!(await isActiveProject(supabase, targetProjectId, companyId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const { data: target, error: targetErr } = await supabase
      .from('projects')
      .select('markup_rate')
      .eq('id', targetProjectId)
      .single()
    if (targetErr) return serverError('target', targetErr)
    targetMarkupRate = (target as { markup_rate?: number | null } | null)?.markup_rate
  }

  // ① 明細を品名で検索。有効な明細だけが残る条件をすべて DB 側でかける（自社・未削除の明細・未削除の案件・明細行）。
  //   要求件数 + 1 件だけ読み、1 件多く取れたら has_more = true
  let q = supabase
    .from('estimate_items')
    .select(`id, project_id, group_id, name, quantity, unit, cost_price, selling_price, selling_price_mode, vendor_name, category, created_at, ${PROJECT_EMBED}`)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .eq('projects.company_id', companyId)
    .is('projects.deleted_at', null)
    // row_type が NULL の古い行は明細（item）として扱う（見積エディタと同じ）
    .or('row_type.is.null,row_type.eq.item')
  for (const term of input.terms) q = q.ilike('name', `%${escapeLikePattern(term)}%`)
  if (targetProjectId) q = q.neq('project_id', targetProjectId)
  const { data: rawItems, error: itemsErr } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(input.limit + 1)
  if (itemsErr) return serverError('items', itemsErr)

  const fetched = (rawItems ?? []) as unknown as ItemRow[]
  const hasMore = fetched.length > input.limit
  const items = fetched.slice(0, input.limit)
  if (items.length === 0) return NextResponse.json({ items: [], has_more: false })

  // ② 工種（自社・未削除・同じ案件のものだけ名前を出す。名前を出さないだけで行は除かない）
  const groupIds = [...new Set(items.flatMap(i => (i.group_id ? [i.group_id] : [])))]
  const groupMap = new Map<string, { id: string; label: string; project_id: string }>()
  if (groupIds.length > 0) {
    const { data: groups, error: groupsErr } = await supabase
      .from('estimate_groups')
      .select('id, label, project_id')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .in('id', groupIds)
    if (groupsErr) return serverError('groups', groupsErr)
    for (const g of (groups ?? []) as Array<{ id: string; label: string; project_id: string }>) groupMap.set(g.id, g)
  }

  const hits: PastEstimateHit[] = []
  for (const i of items) {
    const p = i.projects
    // !inner と案件の条件で必ず入っているはず。入っていなければ念のため返さない（安全側）
    if (!p) continue
    const g = i.group_id ? groupMap.get(i.group_id) : undefined
    const mode: SellingPriceMode = i.selling_price_mode === 'manual' ? 'manual' : 'auto'
    hits.push({
      id:                 i.id,
      name:               i.name,
      quantity:           i.quantity,
      unit:               i.unit,
      cost_price:         i.cost_price,
      selling_price:      i.selling_price,
      selling_price_mode: mode,
      vendor_name:        i.vendor_name,
      category:           i.category,
      created_at:         i.created_at,
      project:            { id: p.id, name: p.name, status: p.status, created_at: p.created_at },
      group:              g && g.project_id === i.project_id ? { id: g.id, label: g.label } : null,
      ...(targetProjectId
        ? {
            copy_preview: {
              ...planPastItemPrice({ ...i, selling_price_mode: mode, row_type: 'item' }, targetMarkupRate),
              fingerprint: pastItemFingerprint({ ...i, selling_price_mode: mode, row_type: 'item' }, targetMarkupRate),
            },
          }
        : {}),
    })
  }

  return NextResponse.json({ items: hits, has_more: hasMore })
}
