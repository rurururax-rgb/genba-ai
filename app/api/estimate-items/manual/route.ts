import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await request.json() as {
    project_id: string
    name?: string
    quantity?: number
    unit?: string
    sort_order?: number
    group_id?: string | null
    row_type?: 'item' | 'header' | 'note'
  }
  const { project_id } = body
  if (!project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const rowType = body.row_type ?? 'item'
  const defaultName = rowType === 'item' ? '新規項目' : ''

  // 過去実績から単価を自動補完（itemタイプかつ名前がある場合のみ）
  let autoPrice: number | null = null
  let autoUnit: string | null = null
  let autoSource = 'manual'
  const itemName = (body.name ?? '').trim()
  if (itemName && rowType === 'item') {
    const { data: matches } = await supabase
      .from('company_estimate_items')
      .select('selling_price, unit')
      .eq('company_id', membership.company_id)
      .ilike('name', `%${itemName}%`)
      .not('selling_price', 'is', null)
      .order('usage_count', { ascending: false })
      .limit(1)
    if (matches?.[0]?.selling_price != null) {
      autoPrice = matches[0].selling_price as number
      autoUnit  = (matches[0].unit as string | null) ?? null
      autoSource = 'past_item'
    }
  }

  const { data, error } = await supabase
    .from('estimate_items')
    .insert({
      project_id,
      company_id: membership.company_id,
      name:          itemName || defaultName,
      quantity:      body.quantity ?? 1,
      unit:          body.unit ?? autoUnit ?? '式',
      selling_price: autoPrice,
      group_id:      body.group_id ?? null,
      sort_order:    body.sort_order ?? 0,
      source:        autoSource,
      row_type:      rowType,
    })
    .select('id, name, category, quantity, unit, selling_price, amount, cost_price, vendor_name, group_id, sort_order, source, line_event_id, memo, row_type')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
