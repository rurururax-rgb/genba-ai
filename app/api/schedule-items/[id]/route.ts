import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { updateScheduleItem, deleteScheduleItem } from '@/lib/services/schedule'
import { checkOptionalGroup, isActiveProject } from '@/lib/estimate/ownership'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/schedule-items/[id]
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })

  // 更新対象は DB の行で確かめる（RLS に加え、会社・案件が自社の有効なものか）。他社・削除済み・存在しないは区別せず 404
  const { data: existing } = await supabase
    .from('schedule_items')
    .select('id, project_id, company_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (
    !existing || existing.company_id !== membership.company_id
    || !(await isActiveProject(supabase, existing.project_id, membership.company_id))
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json() as {
    name?:              string
    category?:          string | null
    vendor_name?:       string | null
    assignee?:          string | null
    start_date?:        string | null
    end_date?:          string | null
    start_period?:      'am' | 'pm'
    end_period?:        'am' | 'pm'
    status?:            string
    memo?:              string | null
    estimate_group_id?: string | null
  }

  // 工種の変更先は、この工程と同じ会社・同じ案件の有効な工種だけ（null は紐付け解除・省略は変更なし）
  const group = await checkOptionalGroup(supabase, body.estimate_group_id, existing.project_id, membership.company_id)
  if (group === 'invalid') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (group === 'not_found') return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  try {
    const item = await updateScheduleItem(supabase, id, {
      name:              body.name,
      category:          body.category,
      vendor_name:       body.vendor_name,
      assignee:          body.assignee,
      start_date:        body.start_date,
      end_date:          body.end_date,
      start_period:      body.start_period,
      end_period:        body.end_period,
      status:            body.status as 'planned' | 'confirmed' | 'in_progress' | 'done' | 'delayed' | undefined,
      memo:              body.memo,
      estimate_group_id: body.estimate_group_id,
    })
    return NextResponse.json(item)
  } catch (err) {
    // DB のエラー文はログにだけ残し、利用者には固定文言を返す
    console.error('[schedule-items PATCH]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: '保存できませんでした。もう一度お試しください。' }, { status: 500 })
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
