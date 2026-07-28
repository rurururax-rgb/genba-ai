import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: anchorEventId } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members').select('company_id').eq('user_id', user.id).single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const formData = await request.formData()
  const noteType  = formData.get('note_type') as string
  const projectId = formData.get('project_id') as string | null

  // ── テキスト追記 ──
  if (noteType === 'text') {
    const content = (formData.get('content') as string | null)?.trim()
    if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 })

    const { data, error } = await supabase
      .from('line_event_notes')
      .insert({
        anchor_event_id: anchorEventId,
        company_id:      membership.company_id,
        project_id:      projectId || null,
        note_type:       'text',
        content,
      })
      .select('id,anchor_event_id,note_type,content,storage_path,created_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  // ── 写真追記 ──
  if (noteType === 'photo') {
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'file is required' }, { status: 400 })

    const noteId      = crypto.randomUUID()
    const ext         = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const storagePath = `${membership.company_id}/${projectId ?? '_unassigned'}/note-photos/${noteId}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from('genba-ai')
      .upload(storagePath, await file.arrayBuffer(), { contentType: file.type })

    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

    const { data, error } = await supabase
      .from('line_event_notes')
      .insert({
        id:              noteId,
        anchor_event_id: anchorEventId,
        company_id:      membership.company_id,
        project_id:      projectId || null,
        note_type:       'photo',
        storage_path:    storagePath,
      })
      .select('id,anchor_event_id,note_type,content,storage_path,created_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  return NextResponse.json({ error: 'Invalid note_type' }, { status: 400 })
}
