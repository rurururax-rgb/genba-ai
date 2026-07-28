import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// DELETE: 追記ノートを削除
// 写真ノートの場合は Storage → DB の順で処理する
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS により自社データのみ参照可
  const { data: note } = await supabase
    .from('line_event_notes')
    .select('id, note_type, storage_path')
    .eq('id', id)
    .single()

  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // 1. 写真ノートの場合は Storage から先に削除
  if (note.note_type === 'photo' && note.storage_path) {
    const { error: storageErr } = await supabase.storage
      .from('genba-ai')
      .remove([note.storage_path])

    if (storageErr) {
      console.error('[note/delete] storage error:', storageErr.message)
      return NextResponse.json(
        { error: `Storage削除エラー: ${storageErr.message}` },
        { status: 500 },
      )
    }
  }

  // 2. DB レコードを削除
  const { error: dbErr } = await supabase
    .from('line_event_notes')
    .delete()
    .eq('id', id)

  if (dbErr) {
    console.error('[note/delete] db error:', dbErr.message)
    return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
