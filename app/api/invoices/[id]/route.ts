import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data, error } = await supabase
    .from('invoice_documents').select('*').eq('id', id).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

const PATCH_TEXT_FIELDS = [
  'invoice_number', 'payment_type', 'customer_name', 'construction_name',
  'issued_at', 'payment_due_at', 'memo', 'status', 'printed_at',
] as const

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await req.json()

  const patch: Record<string, unknown> = {}
  for (const key of PATCH_TEXT_FIELDS) {
    if (key in body) patch[key] = body[key] === null ? null : String(body[key])
  }
  if ('items' in body) patch.items = body.items
  if ('adjustment' in body) patch.adjustment = body.adjustment === null ? 0 : Number(body.adjustment)

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid fields' }, { status: 400 })
  }

  const supabase = await getServerClient()
  const { data, error } = await supabase
    .from('invoice_documents')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { error } = await supabase.from('invoice_documents').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
