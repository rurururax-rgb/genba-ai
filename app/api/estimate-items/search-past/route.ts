/**
 * GET /api/estimate-items/search-past?q=<検索語>&project_id=<開いている案件>&limit=<件数>
 *
 * 自社の過去案件にある見積明細を品名で検索する（読み取りのみ。書き込みはしない）。
 * - getServerClient()（RLS 有効）だけを使う。admin.ts は使わない
 * - 会社の絞り込みは RLS に加えて company_id でも明示する
 * - 削除済みの明細・削除済みの案件の明細は返さない。見出し・メモ行は返さない
 * - 削除済み・別案件の工種の名前は返さない（その場合は未分類として返す）
 * - project_id（開いている案件）を渡すと、その案件の明細は除き、その案件の標準掛け率で計算した
 *   コピー後の売価（copy_preview）を付ける。他社・削除済み・存在しない案件は区別せず 404
 * - お客様向け備考・社内メモは返さない（コピーするかどうかは後続の PR で利用者が選ぶ）
 * - DB のエラー文は返さない（サーバーログのみ）
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isActiveProject, isUuid } from '@/lib/estimate/ownership'
import {
  escapeLikePattern,
  normalizeRowType,
  parsePastSearchInput,
  planPastItemPrice,
  type PastCopyPricePreview,
} from '@/lib/estimate/past-copy'
import type { SellingPriceMode } from '@/lib/estimate/pricing'

/** 削除済み案件・見出し行を後で除くため、要求件数より多めに読む（上限あり） */
const OVERFETCH_FACTOR = 3
const OVERFETCH_MAX = 90

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
  row_type: string | null
  created_at: string
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
  /** project_id を渡したときだけ。コピー先案件の標準掛け率で計算したコピー後の売価 */
  copy_preview?: PastCopyPricePreview
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

  // ① 明細を品名で検索（自社・未削除。新しい順）
  let q = supabase
    .from('estimate_items')
    .select('id, project_id, group_id, name, quantity, unit, cost_price, selling_price, selling_price_mode, vendor_name, category, row_type, created_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
  for (const term of input.terms) q = q.ilike('name', `%${escapeLikePattern(term)}%`)
  if (targetProjectId) q = q.neq('project_id', targetProjectId)
  const fetchLimit = Math.min(input.limit * OVERFETCH_FACTOR, OVERFETCH_MAX)
  const { data: rawItems, error: itemsErr } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(fetchLimit)
  if (itemsErr) return serverError('items', itemsErr)

  // row_type が NULL の古い行は明細（item）として扱う（見積エディタと同じ）
  const items = ((rawItems ?? []) as ItemRow[]).filter(i => normalizeRowType(i.row_type) === 'item')
  if (items.length === 0) return NextResponse.json({ items: [], has_more: false })

  // ② 案件（自社・未削除）。削除済み案件の明細は除く
  const projectIds = [...new Set(items.map(i => i.project_id))]
  const { data: projects, error: projectsErr } = await supabase
    .from('projects')
    .select('id, name, status, created_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .in('id', projectIds)
  if (projectsErr) return serverError('projects', projectsErr)
  const projectMap = new Map(
    ((projects ?? []) as Array<{ id: string; name: string; status: string | null; created_at: string | null }>)
      .map(p => [p.id, p]),
  )

  // ③ 工種（自社・未削除・同じ案件のものだけ名前を出す）
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

  const visible = items.filter(i => projectMap.has(i.project_id))
  const hits: PastEstimateHit[] = visible.slice(0, input.limit).map(i => {
    const p = projectMap.get(i.project_id)!
    const g = i.group_id ? groupMap.get(i.group_id) : undefined
    const mode: SellingPriceMode = i.selling_price_mode === 'manual' ? 'manual' : 'auto'
    return {
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
        ? { copy_preview: planPastItemPrice({ ...i, selling_price_mode: mode, row_type: 'item' }, targetMarkupRate) }
        : {}),
    }
  })

  // 多めに読んだ分が上限に達している、または絞り込み後に要求件数より多い → まだ続きがある可能性
  const hasMore = visible.length > input.limit || (rawItems?.length ?? 0) >= fetchLimit
  return NextResponse.json({ items: hits, has_more: hasMore })
}
