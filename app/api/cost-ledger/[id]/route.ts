import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/cost-ledger/[id]
// 更新可能フィールド: name | budget_cost | actual_cost | note

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as Record<string, unknown>

  const allowed = ['name', 'budget_cost', 'completion_cost', 'actual_cost', 'note', 'vendor_name']
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('cost_ledger_items')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, name, quantity, unit, estimate_cost, budget_cost, completion_cost, actual_cost, note, vendor_name, sort_order, source, estimate_item_id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return new NextResponse(null, { status: 204 })
}
