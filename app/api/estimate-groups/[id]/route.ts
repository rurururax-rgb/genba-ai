import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/estimate-groups/[id]  — label / display_mode / sort_order の更新
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await req.json() as { label?: string; display_mode?: string; sort_order?: number }

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.label        !== undefined) updates.label        = body.label
  if (body.display_mode !== undefined) updates.display_mode = body.display_mode
  if (body.sort_order   !== undefined) updates.sort_order   = body.sort_order

  const { data, error } = await supabase
    .from('estimate_groups')
    .update(updates)
    .eq('id', id)
    .select('id, label, display_mode, sort_order')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/estimate-groups/[id]  — soft delete、所属 items の group_id は NULL に
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 所属項目の group_id を NULL にしてからグループを soft delete
  await supabase.from('estimate_items').update({ group_id: null }).eq('group_id', id)

  const { error } = await supabase
    .from('estimate_groups')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
