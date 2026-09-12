/**
 * PATCH /api/material-master/[id]  — 更新
 * DELETE /api/material-master/[id] — 削除
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

const ALLOWED_FIELDS = new Set([
  'name', 'spec', 'unit', 'selling_price', 'cost_price',
  'url', 'category', 'memo',
])

function pickAllowed(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => ALLOWED_FIELDS.has(k)))
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json() as Record<string, unknown>
  const safeFields = pickAllowed(body)
  if (Object.keys(safeFields).length === 0) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('company_estimate_items')
    .update({ ...safeFields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', membership.company_id)
    .select('id, name, spec, unit, selling_price, cost_price, url, category, usage_count, updated_at')
    .single()

  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Not found' }, { status: error ? 500 : 404 })
  return NextResponse.json({ data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const { error } = await supabase
    .from('company_estimate_items')
    .delete()
    .eq('id', id)
    .eq('company_id', membership.company_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
