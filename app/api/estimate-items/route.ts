import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type ItemPayload = {
  name:          string
  unit:          string
  selling_price: number | null
  category?:     string
  quantity?:     number | null   // 音声抽出した数量（null の場合はデフォルト 1 を使用）
  memo?:         string | null   // 音声メモ（単位不一致・式固定時の参考情報）
}

type RequestBody = {
  project_id: string
  line_event_id: string
  items: ItemPayload[]
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody
    const { project_id, line_event_id, items } = body

    if (!project_id || !line_event_id || !items?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = await getServerClient()

    // 認証ユーザーの company_id を取得
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'No company membership' }, { status: 403 })
    }

    const company_id = membership.company_id

    // estimate_items に INSERT
    // amount は DB GENERATED（quantity * selling_price）なので送らない
    const rows = items.map((item, i) => ({
      project_id,
      company_id,
      line_event_id,
      name:          item.name,
      unit:          item.unit,
      selling_price: item.selling_price,
      category:      item.category ?? null,
      quantity:      item.quantity ?? 1,
      memo:          item.memo ?? null,
      source: 'past_item' as const,
      sort_order: i,
    }))

    const { error: insertErr } = await supabase.from('estimate_items').insert(rows)
    if (insertErr) {
      console.error('[estimate-items] insert error:', insertErr.message)
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    // line_events.reflected_to_estimate = true に更新
    const { error: updateErr } = await supabase
      .from('line_events')
      .update({ reflected_to_estimate: true })
      .eq('id', line_event_id)

    if (updateErr) {
      // 見積追加は成功しているため、フラグ更新失敗はログのみ
      console.error('[estimate-items] reflected_to_estimate update error:', updateErr.message)
    }

    return NextResponse.json({ created: rows.length })
  } catch (err) {
    console.error('[estimate-items] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
