import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// ──────────────────────────────────────────────────────────
// GET /api/cost-ledger?project_id=xxx
// 原価台帳アイテム一覧 + 粗利サマリを返す
// ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 原価台帳アイテム
  const { data: items, error: itemsErr } = await supabase
    .from('cost_ledger_items')
    .select('id, name, quantity, unit, estimate_cost, budget_cost, completion_cost, actual_cost, note, vendor_name, sort_order, source, estimate_item_id')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })

  // 見積サマリ（粗利ウィジェット用 + 業者別売上額計算用）
  const { data: estimateItems, error: estErr } = await supabase
    .from('estimate_items')
    .select('selling_price, quantity, cost_price, amount, vendor_name')
    .eq('project_id', projectId)
    .is('deleted_at', null)

  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 })

  // プロジェクトの契約金額・追加金額
  const { data: project } = await supabase
    .from('projects')
    .select('contract_amount, additional_amount_1, additional_amount_2, additional_amount_3')
    .eq('id', projectId)
    .single()

  const estimateRevenue = (estimateItems ?? []).reduce((s, i) => s + (i.amount ?? 0), 0)
  const estimateCostTotal = (estimateItems ?? []).reduce((s, i) => {
    if (i.cost_price == null) return s
    return s + i.cost_price * (i.quantity ?? 1)
  }, 0)

  const baseContract      = project?.contract_amount ?? estimateRevenue
  const additionalAmount  =
    (project?.additional_amount_1 ?? 0) +
    (project?.additional_amount_2 ?? 0) +
    (project?.additional_amount_3 ?? 0)
  const contractAmount    = baseContract + additionalAmount

  const budgetItems     = (items ?? []).filter(i => i.budget_cost     != null)
  const completionItems = (items ?? []).filter(i => i.completion_cost != null)
  const actualItems     = (items ?? []).filter(i => i.actual_cost     != null)
  const budgetCostTotal     = budgetItems.reduce((s, i) => s + (i.budget_cost ?? 0), 0)
  const completionCostTotal = completionItems.reduce((s, i) => s + ((i.completion_cost as number) ?? 0), 0)
  const actualCostTotal     = actualItems.reduce((s, i) => s + (i.actual_cost ?? 0), 0)

  // 業者別売上額（estimate_items.selling_price × quantity を vendor_name でグループ集計）
  const vendorSelling: Record<string, number> = {}
  for (const item of estimateItems ?? []) {
    const key = (item.vendor_name as string | null)?.trim() || '（業者未設定）'
    const selling = item.selling_price != null
      ? (item.selling_price as number) * ((item.quantity as number) ?? 1)
      : 0
    vendorSelling[key] = (vendorSelling[key] ?? 0) + selling
  }

  return NextResponse.json({
    items: items ?? [],
    vendorSelling,
    summary: {
      estimate_revenue:      estimateRevenue,
      estimate_cost_total:   estimateCostTotal,
      contract_amount:       contractAmount,
      base_contract_amount:  baseContract,
      additional_amount_1:   project?.additional_amount_1 ?? null,
      additional_amount_2:   project?.additional_amount_2 ?? null,
      additional_amount_3:   project?.additional_amount_3 ?? null,
      budget_cost_total:     budgetCostTotal,
      completion_cost_total: completionCostTotal,
      actual_cost_total:     actualCostTotal,
      has_budget_data:       budgetItems.length > 0,
      has_completion_data:   completionItems.length > 0,
      has_actual_data:       actualItems.length > 0,
    },
  })
}

// ──────────────────────────────────────────────────────────
// POST /api/cost-ledger — 手動で1行追加
// ──────────────────────────────────────────────────────────

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

  const body = await req.json() as { project_id: string; sort_order?: number; vendor_name?: string }
  if (!body.project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('cost_ledger_items')
    .insert({
      project_id:  body.project_id,
      company_id:  membership.company_id,
      name:        '新規項目',
      quantity:    1,
      unit:        '式',
      sort_order:  body.sort_order ?? 0,
      source:      'manual',
      vendor_name: body.vendor_name ?? null,
    })
    .select('id, name, quantity, unit, estimate_cost, budget_cost, completion_cost, actual_cost, note, vendor_name, sort_order, source, estimate_item_id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
