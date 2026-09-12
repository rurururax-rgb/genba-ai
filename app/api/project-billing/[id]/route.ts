import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/project-billing/[id]
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    invoice_date?:   string | null
    invoice_amount?: number | null
    payment_date?:   string | null
    payment_amount?: number | null
    fee?:            number | null
  }

  const allowed = ['invoice_date', 'invoice_amount', 'payment_date', 'payment_amount', 'fee']
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = (body as Record<string, unknown>)[key]
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('project_billing_milestones')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}
