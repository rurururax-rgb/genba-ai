import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// GET /api/estimate-revisions?project_id=xxx
export async function GET(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('estimate_revisions')
    .select('id, rev_number, label, subtotal, misc_expense, rounding_discount, tax_amount, total, created_at')
    .eq('project_id', projectId)
    .order('rev_number', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST /api/estimate-revisions
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
  const { project_id, label } = body as { project_id: string; label?: string }
  if (!project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  // 現在の最大 rev_number を取得して +1
  const { data: existing } = await supabase
    .from('estimate_revisions')
    .select('rev_number')
    .eq('project_id', project_id)
    .order('rev_number', { ascending: false })
    .limit(1)
    .single()
  const nextRev = (existing?.rev_number ?? 0) + 1

  // 現在の estimate_items をスナップショット
  const { data: items, error: itemsErr } = await supabase
    .from('estimate_items')
    .select('id, name, category, quantity, unit, selling_price, retail_price, cost_price, vendor_name, group_id, sort_order, source, memo, row_type')
    .eq('project_id', project_id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })

  // 現在の estimate_groups もスナップショット
  const { data: groups } = await supabase
    .from('estimate_groups')
    .select('id, label, display_mode, sort_order')
    .eq('project_id', project_id)
    .order('sort_order', { ascending: true })

  // 合計値は body から受け取る（クライアントが計算済み）
  const { subtotal, misc_expense, rounding_discount, tax_amount, total } = body as {
    subtotal: number
    misc_expense: number
    rounding_discount: number
    tax_amount: number
    total: number
  }

  const { data: rev, error: revErr } = await supabase
    .from('estimate_revisions')
    .insert({
      project_id,
      company_id: member.company_id,
      rev_number: nextRev,
      label: label ?? null,
      snapshot: { items: items ?? [], groups: groups ?? [] },
      subtotal,
      misc_expense,
      rounding_discount,
      tax_amount,
      total,
    })
    .select('id, rev_number, label, subtotal, misc_expense, rounding_discount, tax_amount, total, created_at')
    .single()

  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })
  return NextResponse.json(rev, { status: 201 })
}
