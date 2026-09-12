import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()

  if (!member) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json()
  const name = body.name ? String(body.name).trim() : '新規現調'
  const customer_name = body.customer_name ? String(body.customer_name).trim() : null

  const { data, error } = await supabase
    .from('projects')
    .insert({ company_id: member.company_id, name, customer_name })
    .select('id, name')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
