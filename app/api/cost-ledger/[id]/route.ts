import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { countItemInvoices } from '@/lib/cost-ledger/actual-cost-lock'
import { ACTUAL_COST_LOCKED_MESSAGE, mapCostLedgerDbError } from '@/lib/cost-ledger/rpc-errors'
import { describeReasons, protectionReasons } from '@/lib/cost-ledger/ledger-protection'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/cost-ledger/[id]
// 更新可能フィールド: name | budget_cost | completion_cost | actual_cost | note | vendor_name
// actual_cost は業者請求書が0件の項目だけ直接変更できる（請求書がある項目は 409 actual_cost_locked）

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const allowed = ['name', 'budget_cost', 'completion_cost', 'actual_cost', 'note', 'vendor_name']
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  if ('actual_cost' in patch) {
    const count = await countItemInvoices(supabase, id)
    if (count === null) return NextResponse.json({ error: '保存できませんでした。もう一度お試しください。' }, { status: 500 })
    if (count > 0) {
      return NextResponse.json({ error: ACTUAL_COST_LOCKED_MESSAGE, code: 'actual_cost_locked' }, { status: 409 })
    }
  }

  const { data, error } = await supabase
    .from('cost_ledger_items')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, name, quantity, unit, estimate_cost, budget_cost, completion_cost, actual_cost, note, vendor_name, sort_order, source, estimate_item_id')
    .maybeSingle()

  if (error) {
    console.error('[cost-ledger PATCH]', error.code)
    const mapped = mapCostLedgerDbError(error)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}

// DELETE /api/cost-ledger/[id]（?confirm=values で、実績原価・予算の入った行も削除する）
// ソフトデリート。論理削除した行は案件の実績原価・予算の合計から消えるため（KI-005）:
//   - 業者請求書がある行は削除しない（409 has_invoices。先に請求書を削除する）
//   - 実績原価・実行予算・完工予算が入った行は、確認（?confirm=values）がなければ削除しない（409 needs_confirm）
//   - 削除は「確かめたときの値のまま」の行だけを対象にする条件付き UPDATE。
//     確かめた後に請求書の登録・値の変更があれば 0 行になり、削除しない（409 changed）
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: item, error: readErr } = await supabase
    .from('cost_ledger_items')
    .select('id, actual_cost, budget_cost, completion_cost, updated_at')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (readErr) {
    console.error('[cost-ledger DELETE] read', readErr.code)
    return NextResponse.json({ error: '削除できませんでした。もう一度お試しください。' }, { status: 500 })
  }
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const invoiceCount = await countItemInvoices(supabase, id)
  if (invoiceCount === null) return NextResponse.json({ error: '削除できませんでした。もう一度お試しください。' }, { status: 500 })

  const reasons = protectionReasons(item, invoiceCount)
  if (reasons.includes('invoices')) {
    return NextResponse.json({
      error: 'この項目には業者請求書が登録されているため削除できません。先に請求書を削除してください。',
      code: 'has_invoices',
      reasons,
    }, { status: 409 })
  }
  const confirmed = req.nextUrl.searchParams.get('confirm') === 'values'
  if (reasons.length > 0 && !confirmed) {
    return NextResponse.json({
      error: `この項目には${describeReasons(reasons)}が入力されています。削除すると案件の合計から外れます。`,
      code: 'needs_confirm',
      reasons,
    }, { status: 409 })
  }

  // 確かめたときの値のままの行だけを削除する（請求書の登録・値の変更と重なったら削除しない）
  let query = supabase
    .from('cost_ledger_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
  for (const col of ['actual_cost', 'budget_cost', 'completion_cost', 'updated_at'] as const) {
    const v = item[col]
    query = v == null ? query.is(col, null) : query.eq(col, v)
  }
  const { data: deleted, error } = await query.select('id')

  if (error) {
    console.error('[cost-ledger DELETE]', error.code)
    const mapped = mapCostLedgerDbError(error)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }
  if (!Array.isArray(deleted) || deleted.length !== 1) {
    return NextResponse.json({
      error: 'この項目は確認の後に変更されました。画面を読み込み直してから、もう一度お試しください。',
      code: 'changed',
    }, { status: 409 })
  }

  return new NextResponse(null, { status: 204 })
}
