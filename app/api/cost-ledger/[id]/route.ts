import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { countItemInvoices } from '@/lib/cost-ledger/actual-cost-lock'
import { ACTUAL_COST_LOCKED_MESSAGE, mapCostLedgerDbError } from '@/lib/cost-ledger/rpc-errors'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/cost-ledger/[id]
// 更新可能フィールド: name | budget_cost | completion_cost | actual_cost | note | vendor_name
// actual_cost は業者請求書が0件の項目だけ直接変更できる（請求書がある項目は 409 actual_cost_locked）

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const allowed = ['name', 'budget_cost', 'completion_cost', 'actual_cost', 'note', 'vendor_name']
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  if ('actual_cost' in patch) {
    const count = await countItemInvoices(supabase, id)
    if (count === null) return NextResponse.json({ error: '保存できませんでした。もう一度お試しください。' }, { status: 500 })
    if (count > 0) {
      return NextResponse.json({ error: ACTUAL_COST_LOCKED_MESSAGE, code: 'actual_cost_locked' }, { status: 409 })
    }
  }

  const { data, error } = await supabase
    .from('cost_ledger_items')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, name, quantity, unit, estimate_cost, budget_cost, completion_cost, actual_cost, note, vendor_name, sort_order, source, estimate_item_id')
    .maybeSingle()

  if (error) {
    console.error('[cost-ledger PATCH]', error.code)
    const mapped = mapCostLedgerDbError(error)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}

// DELETE /api/cost-ledger/[id]
// ソフトデリート

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('cost_ledger_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    console.error('[cost-ledger DELETE]', error.code)
    const mapped = mapCostLedgerDbError(error)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }

  return new NextResponse(null, { status: 204 })
}
