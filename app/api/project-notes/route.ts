import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isActiveProject } from '@/lib/estimate/ownership'

// GET /api/project-notes?project_id=xxx
export async function GET(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('project_notes')
    .select('id, content, source, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// POST /api/project-notes
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { project_id: string; content: string }
    const { project_id, content } = body

    if (!project_id || !content?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = await getServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .single()
    if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })
    // 他社・存在しない・削除済みの案件は区別せず 404（RLS は company_id しか見ないため書き込み前に確かめる）
    if (!(await isActiveProject(supabase, project_id, membership.company_id))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('project_notes')
      .insert({
        project_id,
        company_id: membership.company_id,
        source: 'web',
        content: content.trim(),
      })
      .select('id, content, created_at')
      .single()

    if (error) {
      console.error('[project-notes] insert error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[project-notes] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
