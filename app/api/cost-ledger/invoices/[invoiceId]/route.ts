import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isUuid, parseInvoicePatch } from '@/lib/cost-ledger/invoice-dedupe'
import { mapCostLedgerDbError, toNumberOrNull } from '@/lib/cost-ledger/rpc-errors'

type Params = { params: Promise<{ invoiceId: string }> }

const NOT_FOUND = '請求書が見つかりません。画面を再読み込みしてください。'

// ─────────────────────────────────────────────
// PATCH /api/cost-ledger/invoices/[invoiceId]
// 内訳を更新し、親の actual_cost を再集計する
//
// RPC cost_ledger_invoice_update（migration 20261010000002）で、変更と再集計を1トランザクションで行う。
// 変更できるのは amount / invoice_date / payment_date / note のみ。
// 応答に DB のエラー文は含めない。
// ─────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { invoiceId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!isUuid(invoiceId)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const parsed = parseInvoicePatch(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await supabase.rpc('cost_ledger_invoice_update', {
    p_invoice_id: invoiceId,
    p_patch:      parsed.value,
  })
  if (error) {
    console.error('[cost-ledger invoices PATCH]', error.code)
    const mapped = mapCostLedgerDbError(error, NOT_FOUND)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }

  const r = data as { invoice: Record<string, unknown>; item_id: string; actual_cost: unknown; invoice_count: number }
  return NextResponse.json({
    invoice:       r.invoice,
    newActualCost: toNumberOrNull(r.actual_cost),
    itemId:        r.item_id,
    invoiceCount:  r.invoice_count,
  })
}

// ─────────────────────────────────────────────
// DELETE /api/cost-ledger/invoices/[invoiceId]
// 内訳を削除し、親の actual_cost を再集計する
//
// RPC cost_ledger_invoice_delete で、削除と再集計を1トランザクションで行う。
// 最後の1件を削除したら actual_cost は NULL（直接入力モードへ戻る）。
// ─────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { invoiceId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!isUuid(invoiceId)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { data, error } = await supabase.rpc('cost_ledger_invoice_delete', { p_invoice_id: invoiceId })
  if (error) {
    console.error('[cost-ledger invoices DELETE]', error.code)
    const mapped = mapCostLedgerDbError(error, NOT_FOUND)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }

  const r = data as { deleted_id: string; item_id: string; actual_cost: unknown; invoice_count: number }
  return NextResponse.json({
    newActualCost: toNumberOrNull(r.actual_cost),
    itemId:        r.item_id,
    invoiceCount:  r.invoice_count,
  })
}
