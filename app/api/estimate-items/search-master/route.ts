/**
 * GET /api/estimate-items/search-master?project_id=<開いている案件>&q=<検索語>&limit=<件数>
 *
 * 自社の資材マスター（company_estimate_items）を品名で検索する（読み取りのみ。書き込みはしない）。
 * 「資材マスターから追加」画面が使う。資材マスター画面の GET /api/material-master は変えない。
 *
 * - getServerClient()（RLS 有効）だけを使う。admin.ts は使わない
 * - 会社の絞り込みは RLS に加えて company_id でも明示する
 * - project_id（必須）は自社の有効な案件か確かめ、その案件の標準掛け率で計算した初期の売価と、
 *   追加 API に送り返す変更検知用の fingerprint（preview）を付ける。他社・削除済み・存在しない案件は区別せず 404
 * - 検索語が空なら、よく使う順の一覧を返す。語は空白区切りで AND（品名の部分一致。% _ \ はエスケープ）
 * - URL・メモは返さない（この画面では使わない）
 * - DB のエラー文は返さない（サーバーログのみ）
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isActiveProject, isUuid } from '@/lib/estimate/ownership'
import { escapeLikePattern } from '@/lib/estimate/past-copy'
import {
  masterItemFingerprint,
  parseMasterSearchInput,
  planMasterItemPrice,
  resolveMarkupRate,
  type MasterPricePreview,
} from '@/lib/estimate/master-copy'

type MasterRow = {
  id: string
  name: string
  spec: string | null
  unit: string | null
  cost_price: number | null
  selling_price: number | null
  category: string | null
}

export type MasterItemHit = MasterRow & {
  /** この案件で追加するときの初期値と、追加 API に送り返す変更検知用の fingerprint */
  preview: MasterPricePreview & { fingerprint: string }
}

const serverError = (tag: string, error: { code?: string | null; message?: string } | null) => {
  console.error(`[estimate-items/search-master ${tag}]`, error?.code, error?.message)
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
  const input = parseMasterSearchInput(params.get('q'), params.get('limit'))
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })

  const projectId = params.get('project_id')
  if (!isUuid(projectId)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (!(await isActiveProject(supabase, projectId, companyId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .select('markup_rate')
    .eq('id', projectId)
    .single()
  if (projectErr) return serverError('project', projectErr)
  const markupRate = (project as { markup_rate?: number | null } | null)?.markup_rate

  // 要求件数 + 1 件だけ読み、1 件多く取れたら has_more = true
  let q = supabase
    .from('company_estimate_items')
    .select('id, name, spec, unit, cost_price, selling_price, category')
    .eq('company_id', companyId)
  for (const term of input.terms) q = q.ilike('name', `%${escapeLikePattern(term)}%`)
  const { data, error } = await q
    .order('usage_count', { ascending: false })
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .limit(input.limit + 1)
  if (error) return serverError('items', error)

  const fetched = (data ?? []) as MasterRow[]
  const items: MasterItemHit[] = fetched.slice(0, input.limit).map(m => ({
    id:            m.id,
    name:          m.name,
    spec:          m.spec,
    unit:          m.unit,
    cost_price:    m.cost_price,
    selling_price: m.selling_price,
    category:      m.category,
    preview:       { ...planMasterItemPrice(m, markupRate), fingerprint: masterItemFingerprint(m, markupRate) },
  }))
  return NextResponse.json({ items, has_more: fetched.length > input.limit, markup_rate: resolveMarkupRate(markupRate) })
}
