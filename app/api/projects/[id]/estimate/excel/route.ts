import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { fillTemplateV2 } from '@/lib/excel/fill-template-v2'
import { buildEstimateExcelInput } from '@/lib/excel/estimate-excel-input'
import { CUSTOMER_ESTIMATE_ITEM_COLUMNS, toCustomerEstimateItems } from '@/lib/estimate/customer-output'
import { supportsLegacyRugsDocuments } from '@/lib/company/templates'

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
    .select('name, customer_name, site_address, companies(name, tax_rate, template_id)')
    .eq('id', projectId)
    .single()

  if (projErr || !project) {
    return NextResponse.json({ error: '案件が見つかりません' }, { status: 404 })
  }

  const companiesRaw = project.companies as unknown

  // Excel テンプレートはラグズ建築専用（社名・住所・電話・登録番号・画像が埋め込まれている）。
  // 対象 project → company → template_id を確認し、対象会社以外には生成しない
  if (!supportsLegacyRugsDocuments(companiesRaw as { template_id?: string | null } | null)) {
    return NextResponse.json({ error: 'この会社では Excel 出力は利用できません' }, { status: 403 })
  }
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
  // お客様に渡す書類なので、許可リスト（CUSTOMER_ESTIMATE_ITEM_COLUMNS）の列だけを取得し、
  // toCustomerEstimateItems() を通す。社内メモ（internal_memo）・原価・業者名は出力しない
  const { data: rawItems, error: itemsErr } = await supabase
    .from('estimate_items')
    .select(CUSTOMER_ESTIMATE_ITEM_COLUMNS)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })
  const items = toCustomerEstimateItems(rawItems as Record<string, unknown>[] | null)
  if (!items?.length) {
    return NextResponse.json({ error: '見積項目がありません' }, { status: 400 })
  }

  const fillInput = buildEstimateExcelInput(groups ?? [], items, taxRate)

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
