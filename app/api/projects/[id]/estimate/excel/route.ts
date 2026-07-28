import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { fillTemplateV2, type FillInputV2, type FillGroupV2 } from '@/lib/excel/fill-template-v2'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // プロジェクト + 会社情報（tax_rate を含む）
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('name, customer_name, site_address, companies(name, tax_rate)')
    .eq('id', projectId)
    .single()

  if (projErr || !project) {
    return NextResponse.json({ error: '案件が見つかりません' }, { status: 404 })
  }

  const companiesRaw = project.companies as unknown
  const taxRate = (
    companiesRaw && typeof companiesRaw === 'object' && 'tax_rate' in companiesRaw
      ? (companiesRaw as { tax_rate: number }).tax_rate
      : 0.10
  )

  // グループ取得
  const { data: groups, error: groupsErr } = await supabase
    .from('estimate_groups')
    .select('id, label, display_mode, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  if (groupsErr) return NextResponse.json({ error: groupsErr.message }, { status: 500 })

  // 見積項目取得
  const { data: items, error: itemsErr } = await supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, selling_price, amount, group_id, sort_order, memo')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })
  if (!items?.length) {
    return NextResponse.json({ error: '見積項目がありません' }, { status: 400 })
  }

  // FillInputV2 を構築
  const fillGroups: FillGroupV2[] = (groups ?? []).map(g => ({
    label:        g.label || '（グループ名未設定）',
    display_mode: g.display_mode as 'detailed' | 'lump_sum',
    sort_order:   g.sort_order,
    items:        items
      .filter(i => i.group_id === g.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(i => ({
        name:          i.name,
        quantity:      i.quantity,
        unit:          i.unit,
        selling_price: i.selling_price,
        amount:        i.amount,
        memo:          i.memo ?? null,
      })),
  }))

  const ungrouped = items
    .filter(i => !i.group_id)
    .map(i => ({
      name:          i.name,
      quantity:      i.quantity,
      unit:          i.unit,
      selling_price: i.selling_price,
      amount:        i.amount,
      memo:          i.memo ?? null,
      sort_order:    i.sort_order,
    }))

  const fillInput: FillInputV2 = { groups: fillGroups, ungrouped, tax_rate: taxRate }

  let result
  try {
    result = await fillTemplateV2(fillInput)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  if (result.warnings.length) {
    console.warn('[estimate/excel] warnings:', result.warnings)
  }

  const fileName = encodeURIComponent(`内訳明細書_${project.name}.xlsx`)

  return new Response(result.buffer as unknown as ArrayBuffer, {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
    },
  })
}
