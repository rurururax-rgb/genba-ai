import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { reorderScheduleItems } from '@/lib/services/schedule'

// POST /api/schedule-items/reorder
export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as { ordered_ids: string[] }
  if (!Array.isArray(body.ordered_ids) || body.ordered_ids.length === 0) {
    return NextResponse.json({ error: 'ordered_ids is required' }, { status: 400 })
  }

  // RLS で自社データのみアクセス可。最初の ID で案件所属を確認する。
  const { data: firstItem } = await supabase
    .from('schedule_items')
    .select('id')
    .in('id', body.ordered_ids)
    .is('deleted_at', null)
  if (!firstItem || firstItem.length !== body.ordered_ids.length) {
    return NextResponse.json({ error: 'Some items not found or not accessible' }, { status: 404 })
  }

  try {
    await reorderScheduleItems(supabase, body.ordered_ids)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[schedule-items/reorder POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
