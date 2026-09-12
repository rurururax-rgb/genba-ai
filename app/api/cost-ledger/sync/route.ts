import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// POST /api/cost-ledger/sync
// estimate_items の差分を cost_ledger_items に反映する
// - 既存行 (estimate_item_id あり): name/quantity/unit/estimate_cost/vendor_name を上書き
//   budget_cost / actual_cost / note は触らない（手動入力値を保持）
// - 見積に追加された行: 新規 INSERT
// - 見積から削除された行: soft-delete

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!member) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json() as { project_id: string }
  if (!body.project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const projectId = body.project_id
  const companyId = member.company_id

  // 現在の見積項目
  const { data: estimateItems, error: estErr } = await supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, cost_price, vendor_name, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')
  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 })

  // 現在の台帳項目（estimate_item_id ありのもの）
  const { data: ledgerItems, error: ledgerErr } = await supabase
    .from('cost_ledger_items')
    .select('id, estimate_item_id, name, quantity, unit, estimate_cost, vendor_name, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .not('estimate_item_id', 'is', null)
  if (ledgerErr) return NextResponse.json({ error: ledgerErr.message }, { status: 500 })

  const estMap  = new Map((estimateItems ?? []).map(e => [e.id, e]))
  const ledMap  = new Map((ledgerItems ?? []).map(l => [l.estimate_item_id as string, l]))

  let added = 0, updated = 0, removed = 0

  // ── 追加 / 更新 ──────────────────────────────────────────
  for (const est of estimateItems ?? []) {
    const estimateCost = est.cost_price != null
      ? est.cost_price * (est.quantity ?? 1)
      : null

    const existing = ledMap.get(est.id)

    if (existing) {
      // 差分があれば更新（budget_cost / actual_cost / note は触らない）
      const changed =
        existing.name          !== est.name           ||
        existing.quantity      !== (est.quantity ?? 1) ||
        existing.unit          !== (est.unit ?? '式')  ||
        existing.estimate_cost !== estimateCost        ||
        existing.vendor_name   !== (est.vendor_name ?? null)

      if (changed) {
        await supabase
          .from('cost_ledger_items')
          .update({
            name:          est.name,
            quantity:      est.quantity ?? 1,
            unit:          est.unit ?? '式',
            estimate_cost: estimateCost,
            vendor_name:   est.vendor_name ?? null,
            sort_order:    est.sort_order ?? 0,
          })
          .eq('id', existing.id)
        updated++
      }
    } else {
      // 台帳に存在しない → 新規追加
      await supabase
        .from('cost_ledger_items')
        .insert({
          project_id:       projectId,
          company_id:       companyId,
          estimate_item_id: est.id,
          name:             est.name,
          quantity:         est.quantity ?? 1,
          unit:             est.unit ?? '式',
          estimate_cost:    estimateCost,
          budget_cost:      null,
          actual_cost:      null,
          vendor_name:      est.vendor_name ?? null,
          sort_order:       est.sort_order ?? 0,
          source:           'from_estimate',
        })
      added++
    }
  }

  // ── 見積から削除された行を soft-delete ─────────────────────
  for (const led of ledgerItems ?? []) {
    if (!estMap.has(led.estimate_item_id as string)) {
      await supabase
        .from('cost_ledger_items')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', led.id)
      removed++
    }
  }

  return NextResponse.json({ added, updated, removed })
}
