import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// DELETE: AI整理タブの「取り消す」— この line_event に紐づく見積項目を全件論理削除し、
//         reflected フラグを false に戻す
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: lineEventId } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error: deleteErr } = await supabase
    .from('estimate_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('line_event_id', lineEventId)
    .is('deleted_at', null)

  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 })

  const { error: flagErr } = await supabase
    .from('line_events')
    .update({ reflected_to_estimate: false })
    .eq('id', lineEventId)

  if (flagErr) {
    console.error('[unreflect] reflected_to_estimate 更新失敗:', flagErr.message)
  }

  return NextResponse.json({ ok: true })
}
