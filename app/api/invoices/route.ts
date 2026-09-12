import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

async function getCompanyId(supabase: Awaited<ReturnType<typeof getServerClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('company_members').select('company_id').eq('user_id', user.id).single()
  return data?.company_id ?? null
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const supabase = await getServerClient()
  const { data, error } = await supabase
    .from('invoice_documents')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()
  const company_id = await getCompanyId(supabase)
  if (!company_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    project_id, invoice_number, payment_type, customer_name, construction_name,
    issued_at, payment_due_at, items, adjustment, memo, status,
  } = body

  if (!project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('invoice_documents')
    .insert({
      project_id, company_id,
      invoice_number: invoice_number ?? null,
      payment_type: payment_type ?? 'custom',
      customer_name: customer_name ?? null,
      construction_name: construction_name ?? null,
      issued_at: issued_at ?? new Date().toISOString().slice(0, 10),
      payment_due_at: payment_due_at ?? null,
      items: items ?? [],
      adjustment: adjustment ?? 0,
      memo: memo ?? null,
      status: status ?? 'draft',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
