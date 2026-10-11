import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { getProjectSchedule, createScheduleItem } from '@/lib/services/schedule'
import { checkOptionalGroup } from '@/lib/estimate/ownership'

// GET /api/schedule-items?project_id=xxx
export async function GET(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  // RLS により自社案件以外は自動拒否される
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const items = await getProjectSchedule(supabase, projectId)
    return NextResponse.json(items)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}

// POST /api/schedule-items
export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    project_id:        string
    name:              string
    category?:         string | null
    vendor_name?:      string | null
    assignee?:         string | null
    start_date?:       string | null
    end_date?:         string | null
    start_period?:     'am' | 'pm'
    end_period?:       'am' | 'pm'
    status?:           string
    memo?:             string | null
    estimate_group_id?: string | null
  }

  if (!body.project_id || !body.name?.trim()) {
    return NextResponse.json({ error: 'project_id and name are required' }, { status: 400 })
  }

  // 所属会社の取得（company_id はサーバー側で解決。クライアント入力を信用しない）
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })

  // 案件の存在・自社所属確認（IDOR 防止）
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', body.project_id)
    .eq('company_id', membership.company_id)
    .is('deleted_at', null)
    .single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // 見積の工種は同じ会社・この案件の有効なものだけ（null・省略は紐付けなし）。
  // estimate_groups の RLS は company_id しか見ず、外部キー検査は RLS を通らないため書き込み前に確かめる
  const group = await checkOptionalGroup(supabase, body.estimate_group_id, body.project_id, membership.company_id)
  if (group === 'invalid') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (group === 'not_found') return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  try {
    const item = await createScheduleItem(supabase, body.project_id, membership.company_id, {
      name:              body.name,
      category:          body.category,
      vendor_name:       body.vendor_name,
      assignee:          body.assignee,
      start_date:        body.start_date,
      end_date:          body.end_date,
      start_period:      body.start_period ?? 'am',
      end_period:        body.end_period ?? 'pm',
      status:            (body.status ?? 'planned') as 'planned' | 'confirmed' | 'in_progress' | 'done' | 'delayed',
      memo:              body.memo,
      estimate_group_id: body.estimate_group_id,
    })
    return NextResponse.json(item, { status: 201 })
  } catch (err) {
    // DB のエラー文はログにだけ残し、利用者には固定文言を返す
    console.error('[schedule-items POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: '保存できませんでした。もう一度お試しください。' }, { status: 500 })
  }
}
