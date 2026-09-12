import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { syncActualCost } from '../../[id]/invoices/route'

type Params = { params: Promise<{ invoiceId: string }> }

// ─────────────────────────────────────────────
// PATCH /api/cost-ledger/invoices/[invoiceId]
// 内訳を更新し、親の actual_cost を再集計する
// ─────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { invoiceId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 既存レコードを取得（RLS + 親アイテムID取得のため）
  const { data: existing } = await supabase
    .from('cost_ledger_invoices')
    .select('id, cost_ledger_item_id')
    .eq('id', invoiceId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json() as { amount?: number; invoice_date?: string | null; payment_date?: string | null; note?: string | null }
  const patch: Record<string, unknown> = {}
  if (body.amount       !== undefined) patch.amount       = body.amount
  if (body.invoice_date !== undefined) patch.invoice_date = body.invoice_date
  if (body.payment_date !== undefined) patch.payment_date = body.payment_date
  if (body.note         !== undefined) patch.note         = body.note

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  const { data: invoice, error } = await supabase
    .from('cost_ledger_invoices')
    .update(patch)
    .eq('id', invoiceId)
    .select('id, cost_ledger_item_id, amount, invoice_date, payment_date, note, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const newActualCost = await syncActualCost(supabase, existing.cost_ledger_item_id)

  return NextResponse.json({ invoice, newActualCost })
}

// ─────────────────────────────────────────────
// DELETE /api/cost-ledger/invoices/[invoiceId]
// 内訳を削除し、親の actual_cost を再集計する
// ─────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { invoiceId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: existing } = await supabase
    .from('cost_ledger_invoices')
    .select('id, cost_ledger_item_id')
    .eq('id', invoiceId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase
    .from('cost_ledger_invoices')
    .delete()
    .eq('id', invoiceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 内訳が0件になった場合は actual_cost を null に戻す
  const { data: remaining } = await supabase
    .from('cost_ledger_invoices')
    .select('id')
    .eq('cost_ledger_item_id', existing.cost_ledger_item_id)

  let newActualCost: number | null
  if ((remaining ?? []).length === 0) {
    // 内訳が全件削除されたら direct 入力モードへ戻す（null）
    await supabase
      .from('cost_ledger_items')
      .update({ actual_cost: null, updated_at: new Date().toISOString() })
      .eq('id', existing.cost_ledger_item_id)
    newActualCost = null
  } else {
    newActualCost = await syncActualCost(supabase, existing.cost_ledger_item_id)
  }

  return NextResponse.json({ newActualCost, itemId: existing.cost_ledger_item_id })
}
