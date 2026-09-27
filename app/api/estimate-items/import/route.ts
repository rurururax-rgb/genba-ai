import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { calculateSellingPrice, DEFAULT_MARKUP_RATE } from '@/lib/estimate/pricing'

type ImportItem = {
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  selling_price?: number | null
  memo: string | null
  vendor_name?: string | null
}

type RequestBody = {
  project_id: string
  group_id?: string | null
  sort_order?: number       // 挿入位置を指定する場合に渡す（省略時は末尾）
  items: ImportItem[]
}

// POST /api/estimate-items/import
// 仕入れ見積書からインポートした項目を estimate_items に追加する。
// line_event_id 不要・source='import'。
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody
    const { project_id, group_id, sort_order: requestedSortOrder, items } = body

    if (!project_id || !items?.length) {
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

    const company_id = membership.company_id

    // 案件掛け率を取得（column 未存在 / RLS ブロック時は DEFAULT_MARKUP_RATE にフォールバック）
    const { data: projectData } = await supabase
      .from('projects')
      .select('markup_rate')
      .eq('id', project_id)
      .single()
    const rawRate = (projectData as { markup_rate?: number | null } | null)?.markup_rate
    const markupRate: number = rawRate != null && rawRate > 0 ? rawRate : DEFAULT_MARKUP_RATE

    // 挿入位置を決定: sort_order が指定されていればそれを使う。なければ末尾に追加。
    let baseOrder: number
    if (requestedSortOrder !== undefined) {
      baseOrder = requestedSortOrder
    } else {
      const baseQ = supabase
        .from('estimate_items')
        .select('sort_order')
        .eq('project_id', project_id)
        .is('deleted_at', null)
      const { data: maxRow } = await (
        group_id ? baseQ.eq('group_id', group_id) : baseQ
      ).order('sort_order', { ascending: false }).limit(1).single()
      baseOrder = (maxRow?.sort_order ?? -1) + 1
    }

    const rows = items.map((item, i) => {
      const costPrice  = item.cost_price ?? null
      const rawSelling = item.selling_price ?? null
      // 売価モード決定:
      //   インポート元に selling_price が存在すれば MANUAL（仕入元価格を維持）
      //   selling_price なし / 0 → AUTO（案件掛け率で計算）
      let sellingPrice: number | null
      let sellingPriceMode: 'auto' | 'manual'
      if (rawSelling != null && rawSelling !== 0) {
        sellingPrice     = rawSelling
        sellingPriceMode = 'manual'
      } else if (costPrice != null && costPrice > 0) {
        sellingPrice     = calculateSellingPrice(costPrice, markupRate)
        sellingPriceMode = 'auto'
      } else {
        sellingPrice     = rawSelling
        sellingPriceMode = 'auto'
      }
      return {
        project_id,
        company_id,
        group_id:           group_id ?? null,
        name:               item.name,
        unit:               item.unit ?? '式',
        quantity:           item.quantity ?? 1,
        cost_price:         costPrice,
        selling_price:      sellingPrice,
        selling_price_mode: sellingPriceMode,
        memo:               item.memo ?? null,
        vendor_name:        item.vendor_name ?? null,
        source:             'import' as const,
        sort_order:         baseOrder + i,
      }
    })

    const { error } = await supabase.from('estimate_items').insert(rows)
    if (error) {
      console.error('[estimate-items/import] insert error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ created: rows.length })
  } catch (err) {
    console.error('[estimate-items/import] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
