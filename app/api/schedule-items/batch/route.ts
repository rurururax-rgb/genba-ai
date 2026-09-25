import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { batchAdoptScheduleItems } from '@/lib/services/schedule-batch'
import type { BatchDraftItem } from '@/lib/services/schedule-batch'

// POST /api/schedule-items/batch
// AI工程案を一括採用する。全件成功または全件失敗を保証。
export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })

  const body = await request.json() as {
    project_id?: string
    draft_id?:   string
    items?:      BatchDraftItem[]
  }

  if (!body.project_id || !body.draft_id) {
    return NextResponse.json({ error: 'project_id and draft_id are required' }, { status: 400 })
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'items must be a non-empty array' }, { status: 400 })
  }

  // 案件の存在・自社所属確認（IDOR 防止）
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', body.project_id)
    .eq('company_id', membership.company_id)
    .is('deleted_at', null)
    .single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const result = await batchAdoptScheduleItems(supabase, {
    project_id: body.project_id,
    company_id: membership.company_id,
    draft_id:   body.draft_id,
    items:      body.items,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ ok: true, inserted: result.inserted }, { status: 201 })
}
