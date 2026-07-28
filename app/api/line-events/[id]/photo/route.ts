import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// DELETE: LINE イベントの写真を削除
// Storage → DB の順で処理する（Storage 失敗時は中断してエラーを返す）
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS により自社データのみ参照可
  const { data: event } = await supabase
    .from('line_events')
    .select('id, storage_path')
    .eq('id', id)
    .single()

  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!event.storage_path) return NextResponse.json({ error: 'No photo attached' }, { status: 400 })

  // 1. Storage から削除（失敗したら中断）
  const { error: storageErr } = await supabase.storage
    .from('genba-ai')
    .remove([event.storage_path])

  if (storageErr) {
    console.error('[photo/delete] storage error:', storageErr.message)
    return NextResponse.json(
      { error: `Storage削除エラー: ${storageErr.message}` },
      { status: 500 },
    )
  }

  // 2. DB を更新（写真は消えるが、テキスト起こし等は残す）
  const { error: dbErr } = await supabase
    .from('line_events')
    .update({ storage_path: null })
    .eq('id', id)

  if (dbErr) {
    // Storage は削除済みだが DB 更新失敗：不整合になるがファイルは既にない
    console.error('[photo/delete] db error (storage already deleted):', dbErr.message)
    return NextResponse.json(
      { error: `DB更新エラー（ファイルは削除済み）: ${dbErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true })
}
