/**
 * 業者請求書がある台帳項目の actual_cost（請求実績）を直接書き換えさせないための判定。
 *
 * 請求書が1件以上ある項目の actual_cost は「請求書の合計」であり、変更は請求書の追加・編集・削除
 * （RPC cost_ledger_invoice_*）だけで行う。請求書が0件の項目は従来どおり直接入力できる。
 *
 * これはアプリ側の確認であり、確認と書き込みの間に請求書が登録される競合や、
 * PostgREST からの直接 UPDATE は防げない。DB 側の保護は migration 20261011000001（未適用）。
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** 台帳項目に紐づく請求書の件数。読み取りに失敗したら null（呼び出し側は安全側＝書き込まない） */
export async function countItemInvoices(supabase: SupabaseClient, itemId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('cost_ledger_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('cost_ledger_item_id', itemId)
  if (error || count === null) return null
  return count
}
