import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

const DEFAULT_MILESTONES = [
  { type: '契約金',  sort_order: 0 },
  { type: '着工金',  sort_order: 1 },
  { type: '中間金',  sort_order: 2 },
  { type: '完工金',  sort_order: 3 },
]

// GET /api/project-billing?project_id=xxx
// 4マイルストーンを返す。存在しなければ自動作成する。
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!member) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const { data: existing } = await supabase
    .from('project_billing_milestones')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order')

  // 初回アクセス時に4行を自動生成
  if (!existing || existing.length === 0) {
    const rows = DEFAULT_MILESTONES.map(m => ({
      project_id: projectId,
      company_id: member.company_id,
      ...m,
    }))
    const { data: created, error } = await supabase
      .from('project_billing_milestones')
      .insert(rows)
      .select('*')
      .order('sort_order')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(created)
  }

  return NextResponse.json(existing)
}

// GET /api/project-billing?project_id=xxx&include_contract=true
// 追加金額も含めて返す（contract_amount, additional_amount_1/2/3）
export async function POST(req: NextRequest) {
  // project の additional_amount と contract_amount を更新
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    project_id: string
    contract_amount?: number | null
    additional_amount_1?: number | null
    additional_amount_2?: number | null
    additional_amount_3?: number | null
  }
  if (!body.project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('contract_amount'     in body) patch.contract_amount     = body.contract_amount
  if ('additional_amount_1' in body) patch.additional_amount_1 = body.additional_amount_1
  if ('additional_amount_2' in body) patch.additional_amount_2 = body.additional_amount_2
  if ('additional_amount_3' in body) patch.additional_amount_3 = body.additional_amount_3

  const { data, error } = await supabase
    .from('projects')
    .update(patch)
    .eq('id', body.project_id)
    .select('id, contract_amount, additional_amount_1, additional_amount_2, additional_amount_3')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
