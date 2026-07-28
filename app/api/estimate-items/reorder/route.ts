import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type GroupOrder = { id: string; sort_order: number }
type ItemOrder  = { id: string; sort_order: number; group_id: string | null }

// POST /api/estimate-items/reorder
// ドラッグ&ドロップ後の並び順を一括保存する。
// groups と items 両方の sort_order を 1リクエストで更新する。
export async function POST(req: NextRequest) {
  const body = await req.json() as { groups: GroupOrder[]; items: ItemOrder[] }
  const { groups = [], items = [] } = body

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // グループの sort_order 更新
  for (const g of groups) {
    const { error } = await supabase
      .from('estimate_groups')
      .update({ sort_order: g.sort_order, updated_at: new Date().toISOString() })
      .eq('id', g.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // 項目の sort_order + group_id 更新
  for (const item of items) {
    const { error } = await supabase
      .from('estimate_items')
      .update({
        sort_order: item.sort_order,
        group_id:   item.group_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
