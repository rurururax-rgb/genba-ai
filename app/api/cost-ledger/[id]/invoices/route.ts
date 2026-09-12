import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

// ─────────────────────────────────────────────
// GET /api/cost-ledger/[id]/invoices
// 指定アイテムの内訳一覧を返す
// ─────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('cost_ledger_invoices')
    .select('id, cost_ledger_item_id, amount, invoice_date, payment_date, note, created_at')
    .eq('cost_ledger_item_id', id)
    .order('created_at')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// ─────────────────────────────────────────────
// POST /api/cost-ledger/[id]/invoices
// 内訳を1件追加し、親の actual_cost を再集計する
// ─────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: Params) {
  const { id: itemId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS チェック: 自社アイテムか確認
  const { data: item } = await supabase
    .from('cost_ledger_items')
    .select('id')
    .eq('id', itemId)
    .is('deleted_at', null)
    .single()
  if (!item) return NextResponse.json({ error: 'Item not found or no access' }, { status: 404 })

  const body = await req.json() as { amount: number; invoice_date?: string; payment_date?: string; note?: string }
  if (!body.amount || isNaN(body.amount)) {
    return NextResponse.json({ error: 'amount required' }, { status: 400 })
  }

  const { data: invoice, error } = await supabase
    .from('cost_ledger_invoices')
    .insert({
      cost_ledger_item_id: itemId,
      amount:        body.amount,
      invoice_date:  body.invoice_date  ?? null,
      payment_date:  body.payment_date  ?? null,
      note:          body.note          ?? null,
    })
    .select('id, cost_ledger_item_id, amount, invoice_date, payment_date, note, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 親の actual_cost を再集計
  const newActualCost = await syncActualCost(supabase, itemId)

  return NextResponse.json({ invoice, newActualCost })
}

// ─────────────────────────────────────────────
// ヘルパー: 内訳合計を集計して actual_cost を更新
// ─────────────────────────────────────────────

export async function syncActualCost(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  itemId: string,
): Promise<number> {
  const { data: rows } = await supabase
    .from('cost_ledger_invoices')
    .select('amount')
    .eq('cost_ledger_item_id', itemId)

  const total = (rows ?? []).reduce((s: number, r: { amount: number }) => s + (r.amount ?? 0), 0)

  await supabase
    .from('cost_ledger_items')
    .update({ actual_cost: total, updated_at: new Date().toISOString() })
    .eq('id', itemId)

  return total
}
