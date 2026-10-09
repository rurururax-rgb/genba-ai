import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isUuid, isSortOrder, isActiveProject } from '@/lib/estimate/ownership'

type GroupOrder = { id: string; sort_order: number }
type ItemOrder  = { id: string; sort_order: number; group_id: string | null }

/** .in() は URL に ID を並べるため、長くなりすぎないよう分けて問い合わせる */
const IN_CHUNK = 100

function isGroupOrder(v: unknown): v is GroupOrder {
  const o = v as GroupOrder
  return typeof o === 'object' && o !== null && isUuid(o.id) && isSortOrder(o.sort_order)
}

function isItemOrder(v: unknown): v is ItemOrder {
  const o = v as ItemOrder
  return typeof o === 'object' && o !== null && isUuid(o.id) && isSortOrder(o.sort_order)
    && (o.group_id === null || isUuid(o.group_id))
}

function hasDuplicateId(rows: { id: string }[]) {
  return new Set(rows.map(r => r.id)).size !== rows.length
}

// POST /api/estimate-items/reorder
// ドラッグ&ドロップ後の並び順を一括保存する。
// groups と items 両方の sort_order を 1リクエストで更新する。
//
// 書き込み前に全件を検証する（1 件でも不正なら 1 件も更新しない）:
//   - 対象の工種・明細がすべて自社のもので削除されていない
//   - 移動先の工種（group_id）も同じ案件のもので削除されていない。null（その他）は可
//   - 対象がすべて同じ 1 つの案件に属し、その案件が削除されていない（案件をまたぐ要求は拒否）
// 更新は 1 件ずつでトランザクションではない。検証後の更新が失敗した・0 件だった場合は
// それまでの更新が残りうるため、クライアントは DB を読み直す（EstimateTab の recoverFromReorderFailure）。
export async function POST(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { groups?: unknown; items?: unknown } | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { groups = [], items = [] } = body
  if (!Array.isArray(groups) || !Array.isArray(items)
    || !groups.every(isGroupOrder) || !items.every(isItemOrder)
    || hasDuplicateId(groups) || hasDuplicateId(items)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  if (groups.length === 0 && items.length === 0) return NextResponse.json({ ok: true })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })
  const companyId = membership.company_id as string

  // ── 検証（ここまで何も書き込まない） ──
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

  const loadActive = async (table: 'estimate_groups' | 'estimate_items', ids: string[]) => {
    const found = new Map<string, string>()  // id → project_id
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await supabase
        .from(table)
        .select('id, project_id')
        .in('id', ids.slice(i, i + IN_CHUNK))
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (error) return null
      for (const r of data ?? []) found.set(r.id as string, r.project_id as string)
    }
    return found
  }

  const itemRows = await loadActive('estimate_items', items.map(i => i.id))
  // 並び替える工種と、明細の移動先の工種
  const groupIds = [...new Set([...groups.map(g => g.id), ...items.flatMap(i => (i.group_id ? [i.group_id] : []))])]
  const groupRows = await loadActive('estimate_groups', groupIds)
  if (!itemRows || !groupRows) return NextResponse.json({ error: 'Failed to verify reorder' }, { status: 500 })
  if (itemRows.size !== items.length || groupRows.size !== groupIds.length) return notFound()

  const projectIds = new Set([...itemRows.values(), ...groupRows.values()])
  if (projectIds.size !== 1) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const [projectId] = projectIds
  if (!(await isActiveProject(supabase, projectId, companyId))) return notFound()

  // ── 書き込み ──
  // 検証後も対象を自社・同じ案件・未削除に絞り、更新できた行を返させる。
  // error が null でも 0 件のこと（検証後に削除された・RLS で見えない等）があるので、1 件更新できたかを確かめる
  const now = new Date().toISOString()
  const notSaved = () => NextResponse.json({ error: 'Reorder was not fully saved' }, { status: 500 })

  for (const g of groups) {
    const { data, error } = await supabase
      .from('estimate_groups')
      .update({ sort_order: g.sort_order, updated_at: now })
      .eq('id', g.id)
      .eq('company_id', companyId)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .select('id')
    if (error || data?.length !== 1) return notSaved()
  }

  for (const item of items) {
    const { data, error } = await supabase
      .from('estimate_items')
      .update({ sort_order: item.sort_order, group_id: item.group_id, updated_at: now })
      .eq('id', item.id)
      .eq('company_id', companyId)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .select('id')
    if (error || data?.length !== 1) return notSaved()
  }

  return NextResponse.json({ ok: true })
}
