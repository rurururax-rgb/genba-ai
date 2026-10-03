import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { CUSTOMER_ESTIMATE_ITEM_COLUMNS, toCustomerEstimateItems } from '@/lib/estimate/customer-output'
import { EstimateDocument, type EstimateDocumentProject } from '@/components/estimate/EstimateDocument'

type Params = { params: Promise<{ id: string }> }

// お客様向け見積書（プレビュー / 印刷 / PDF）。
// 明細は CUSTOMER_ESTIMATE_ITEM_COLUMNS のみ取得し、toCustomerEstimateItems() で許可リスト変換してから描画へ渡す。
// 社内メモ（internal_memo）は取得も受け渡しもしない。
export default async function EstimateDocumentPage({ params }: Params) {
  const { id: projectId } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await supabase
    .from('projects')
    .select(`
      id, name, customer_name, site_address,
      misc_expense_override, rounding_discount,
      person_in_charge, construction_period,
      estimate_valid_from, estimate_valid_months,
      construction_overview, project_memo
    `)
    .eq('id', projectId)
    .single()
  if (!project) redirect('/projects')

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id, companies(name, display_name, tax_rate, template_id)')
    .eq('user_id', user.id)
    .single()
  const company = membership?.companies as unknown as { name: string; display_name: string | null; tax_rate: number; template_id: string | null } | null

  const { data: groups } = await supabase
    .from('estimate_groups')
    .select('id, label, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  const { data: rawItems } = await supabase
    .from('estimate_items')
    .select(CUSTOMER_ESTIMATE_ITEM_COLUMNS)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  return (
    <EstimateDocument
      projectId={projectId}
      project={project as EstimateDocumentProject}
      company={company}
      groups={groups ?? []}
      items={toCustomerEstimateItems(rawItems as Record<string, unknown>[] | null)}
    />
  )
}
