import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// DELETE: 1行を論理削除し、同 line_event に紐づく行がなくなったら reflected フラグも戻す
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS により自社データのみアクセス可
  const { data: item } = await supabase
    .from('estimate_items')
    .select('id, line_event_id')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase
    .from('estimate_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // この line_event に紐づく未削除の行が残っていないか確認
  let reflected_cleared = false
  if (item.line_event_id) {
    const { count } = await supabase
      .from('estimate_items')
      .select('id', { count: 'exact', head: true })
      .eq('line_event_id', item.line_event_id)
      .is('deleted_at', null)

    if ((count ?? 0) === 0) {
      await supabase
        .from('line_events')
        .update({ reflected_to_estimate: false })
        .eq('id', item.line_event_id)
      reflected_cleared = true
    }
  }

  return NextResponse.json({ ok: true, reflected_cleared, line_event_id: item.line_event_id })
}

// PATCH: 項目フィールドを更新（amount は GENERATED ALWAYS AS で DB が自動再計算）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await req.json()) as {
    quantity?:      number
    selling_price?: number | null
    retail_price?:  number | null
    name?:          string
    unit?:          string
    memo?:          string | null
    cost_price?:    number | null
    vendor_name?:   string | null
    category?:      string | null
    row_type?:      'item' | 'header' | 'note'
  }
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.quantity      !== undefined) patch.quantity      = body.quantity
  if (body.selling_price !== undefined) patch.selling_price = body.selling_price
  if (body.retail_price  !== undefined) patch.retail_price  = body.retail_price
  if (body.name          !== undefined) patch.name          = body.name
  if (body.unit          !== undefined) patch.unit          = body.unit
  if (body.memo          !== undefined) patch.memo          = body.memo
  if (body.cost_price    !== undefined) patch.cost_price    = body.cost_price
  if (body.vendor_name   !== undefined) patch.vendor_name   = body.vendor_name
  if (body.category      !== undefined) patch.category      = body.category
  if (body.row_type      !== undefined) patch.row_type      = body.row_type

  const { data, error } = await supabase
    .from('estimate_items')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, name, quantity, unit, selling_price, amount, retail_price, cost_price, vendor_name, category, source, line_event_id, memo, row_type')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
