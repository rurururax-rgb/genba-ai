import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// POST /api/cost-ledger/init
// estimate_items を cost_ledger_items へ一括コピーして台帳を初期化する

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json() as { project_id: string }
  if (!body.project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const projectId = body.project_id
  const companyId = membership.company_id

  // 既存の台帳アイテムがある場合はスキップ（初期化済み）
  const { count } = await supabase
    .from('cost_ledger_items')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .is('deleted_at', null)

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: '台帳はすでに初期化済みです。既存の行を削除してから再試行してください。' },
      { status: 409 }
    )
  }

  // 見積アイテムを取得
  const { data: estimateItems, error: estErr } = await supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, cost_price, vendor_name, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 })
  if (!estimateItems || estimateItems.length === 0) {
    return NextResponse.json(
      { error: '見積エディタに項目がありません。先に見積を作成してください。' },
      { status: 422 }
    )
  }

  // cost_ledger_items を生成
  // estimate_cost = cost_price × quantity（スナップショット・変更不可）
  // budget_cost   = estimate_cost と同値でスタート（編集可能）
  // actual_cost   = estimate_cost（取り込み時の原価を初期値として引き継ぎ）
  const rows = estimateItems.map(item => {
    const estimateCost = item.cost_price != null
      ? item.cost_price * (item.quantity ?? 1)
      : null

    return {
      project_id:       projectId,
      company_id:       companyId,
      estimate_item_id: item.id,
      name:             item.name,
      quantity:         item.quantity ?? 1,
      unit:             item.unit ?? '式',
      estimate_cost:    estimateCost,
      budget_cost:      estimateCost,
      actual_cost:      estimateCost,
      vendor_name:      item.vendor_name ?? null,
      sort_order:       item.sort_order ?? 0,
      source:           'from_estimate',
    }
  })

  const { data, error } = await supabase
    .from('cost_ledger_items')
    .insert(rows)
    .select('id, name, quantity, unit, estimate_cost, budget_cost, actual_cost, vendor_name, note, sort_order, source, estimate_item_id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ items: data }, { status: 201 })
}
