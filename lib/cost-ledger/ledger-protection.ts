/**
 * 請求実績・実績原価・予算のある原価台帳項目を、論理削除から守る（KI-005）。
 *
 * 見積同期（POST /api/cost-ledger/sync）と台帳項目の削除（DELETE /api/cost-ledger/[id]）で使う。
 * 案件の実績原価・予算の合計は「未削除の台帳項目」の合計なので、論理削除するとその分が合計から消える。
 *
 * 同時実行への備え（DB の変更なし）:
 *   論理削除は「確かめたときの値のまま」の行だけを対象にする条件付き UPDATE で行う。
 *   請求書の登録（RPC cost_ledger_invoice_insert）は同じトランザクションで actual_cost と updated_at を書き換えるため、
 *     ・RPC が先: 論理削除の UPDATE は行ロックを待ち、更新後の行で条件を見直して 0 行になる（削除しない）
 *     ・論理削除が先: RPC は削除済みの項目として CL404 で登録を拒否する
 *   のどちらかになり、「請求書があるのに論理削除された項目」はできない。
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ProtectionReason = 'invoices' | 'actual_cost' | 'budget_cost' | 'completion_cost'

export type LedgerValues = {
  actual_cost: number | null
  budget_cost: number | null
  completion_cost: number | null
}

export const PROTECTION_LABEL: Record<ProtectionReason, string> = {
  invoices:        '業者請求書',
  actual_cost:     '実績原価',
  budget_cost:     '実行予算',
  completion_cost: '完工予算',
}

/** 論理削除すると合計から消えてしまうもの。空なら守る必要がない */
export function protectionReasons(item: LedgerValues, invoiceCount: number): ProtectionReason[] {
  const reasons: ProtectionReason[] = []
  if (invoiceCount > 0) reasons.push('invoices')
  if (item.actual_cost != null) reasons.push('actual_cost')
  if (item.budget_cost != null) reasons.push('budget_cost')
  if (item.completion_cost != null) reasons.push('completion_cost')
  return reasons
}

export const describeReasons = (reasons: ProtectionReason[]) => reasons.map(r => PROTECTION_LABEL[r]).join('・')

const INVOICE_COUNT_CHUNK = 100
// 1回に読む請求書の行数。PostgREST の max-rows（Supabase の既定は 1000）がこれより小さくても、
// 「0行が返るまで」読み進めるので数え落とさない
const INVOICE_PAGE_SIZE = 1000
// 読み進める回数の上限（無限ループ防止）。超えたら件数不明として失敗にする
const INVOICE_MAX_PAGES = 1000

/**
 * 台帳項目ごとの請求書の件数。読み取りに失敗したら null（呼び出し側は安全側＝書き込まない・一覧ごと失敗）。
 * PostgREST は1回の応答の行数に上限（max-rows）があり、上限で切られても応答はエラーにならない。
 * そのため id の昇順に「前回の最後の id より後」を読み（keyset ページング）、0行が返るまで続ける。
 */
export async function countInvoicesByItem(
  supabase: SupabaseClient,
  itemIds: string[],
): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>()
  for (let i = 0; i < itemIds.length; i += INVOICE_COUNT_CHUNK) {
    const chunk = itemIds.slice(i, i + INVOICE_COUNT_CHUNK)
    let after: string | null = null
    for (let page = 0; ; page++) {
      if (page >= INVOICE_MAX_PAGES) return null
      let query = supabase
        .from('cost_ledger_invoices')
        .select('id, cost_ledger_item_id')
        .in('cost_ledger_item_id', chunk)
      if (after) query = query.gt('id', after)
      const { data: rows, error } = await query.order('id').limit(INVOICE_PAGE_SIZE)
      if (error || !Array.isArray(rows)) return null
      if (rows.length === 0) break
      for (const r of rows) {
        const key = r.cost_ledger_item_id as string
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      after = rows[rows.length - 1].id as string
    }
  }
  return counts
}

/**
 * 実績・予算が空で、請求書もない項目だけを論理削除する（条件付き UPDATE）。
 * 戻り値: 'deleted' = 削除した / 'kept' = 確かめた後に値が入った・既に削除済み（削除しない） / 'error'
 */
export async function softDeleteIfEmpty(supabase: SupabaseClient, itemId: string): Promise<'deleted' | 'kept' | 'error'> {
  const { data, error } = await supabase
    .from('cost_ledger_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', itemId)
    .is('deleted_at', null)
    .is('actual_cost', null)
    .is('budget_cost', null)
    .is('completion_cost', null)
    .select('id')
  if (error || !Array.isArray(data)) return 'error'
  return data.length === 1 ? 'deleted' : 'kept'
}
