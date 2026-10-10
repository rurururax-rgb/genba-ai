import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { mapAddEstimateItemsError, parseAddRequest } from '@/lib/line-events/add-estimate-items'

// POST: AI整理タブの「見積に追加」— LINE イベントの候補を見積項目に追加する。
//   見積項目の追加と、未振り分けイベントの案件への紐付け（line_events.project_id）・反映済みフラグを
//   RPC add_line_event_estimate_items で 1 トランザクションで行う（KI-001）。
//   会社の一致・別案件に紐付け済み・反映済みの確認も RPC 内でイベント行をロックして行う。
export async function POST(request: NextRequest) {
  try {
    const parsed = parseAddRequest(await request.json().catch(() => null))
    if (!parsed) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = await getServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase.rpc('add_line_event_estimate_items', {
      p_project_id:    parsed.project_id,
      p_line_event_id: parsed.line_event_id,
      p_items:         parsed.items,
    })
    if (error) {
      console.error('[estimate-items] rpc error:', error.code)
      const mapped = mapAddEstimateItemsError(error)
      return NextResponse.json(mapped.body, { status: mapped.status })
    }

    const result = (data ?? {}) as { created?: number; project_id?: string; linked?: boolean }
    return NextResponse.json({
      created:    result.created ?? parsed.items.length,
      project_id: result.project_id ?? parsed.project_id,
      linked:     result.linked ?? false,
    })
  } catch (err) {
    console.error('[estimate-items] unexpected error:', err instanceof Error ? err.name : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
