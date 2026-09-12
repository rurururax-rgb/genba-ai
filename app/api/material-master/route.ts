/**
 * GET /api/material-master   — 資材マスター一覧（自社のみ）
 * POST /api/material-master  — 新規登録
 *
 * セキュリティ: getServerClient()（RLS有効）。admin.ts 不使用。
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

export async function GET(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') ?? ''

  let query = supabase
    .from('company_estimate_items')
    .select('id, name, spec, unit, selling_price, cost_price, url, category, usage_count, updated_at')
    .eq('company_id', membership.company_id)
    .order('updated_at', { ascending: false })

  if (q) {
    query = query.ilike('name', `%${q}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
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
  if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const safeFields = pickAllowed(body)

  const { data, error } = await supabase
    .from('company_estimate_items')
    .insert({
      ...safeFields,
      company_id:   membership.company_id,
      usage_count:  1,
      last_used_at: new Date().toISOString(),
    })
    .select('id, name, spec, unit, selling_price, cost_price, url, category, usage_count, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
