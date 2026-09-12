import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { updateScheduleItem, deleteScheduleItem } from '@/lib/services/schedule'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/schedule-items/[id]
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS で自社データのみアクセス可。さらに存在確認。
  const { data: existing } = await supabase
    .from('schedule_items')
    .select('id')
    .eq('id', id)
    .is('deleted_at', null)
    .single()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json() as {
    name?:              string
    category?:          string | null
    vendor_name?:       string | null
    assignee?:          string | null
    start_date?:        string | null
    end_date?:          string | null
    status?:            string
    memo?:              string | null
    estimate_group_id?: string | null
  }

  try {
    const item = await updateScheduleItem(supabase, id, {
      name:              body.name,
      category:          body.category,
      vendor_name:       body.vendor_name,
      assignee:          body.assignee,
      start_date:        body.start_date,
      end_date:          body.end_date,
      status:            body.status as 'planned' | 'confirmed' | 'in_progress' | 'done' | 'delayed' | undefined,
      memo:              body.memo,
      estimate_group_id: body.estimate_group_id,
    })
    return NextResponse.json(item)
  } catch (err) {
    console.error('[schedule-items PATCH]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}

// DELETE /api/schedule-items/[id]
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS で自社データのみアクセス可
  const { data: existing } = await supabase
    .from('schedule_items')
    .select('id')
    .eq('id', id)
    .is('deleted_at', null)
    .single()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await deleteScheduleItem(supabase, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[schedule-items DELETE]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
