import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateEstimateTotals, TAX_RATE, type EstimateTotalItem } from '@/lib/estimate/totals'

export type GetEstimateTotalResult =
  | {
      status:              'ok'
      item_count:          number
      item_subtotal:       number
      overhead:            number
      overhead_source:     'override' | 'default_rate'
      rounding_discount:   number
      pre_tax_total:       number
      tax:                 number
      tax_rate:            number
      total_including_tax: number
      note:                string
    }
  | { status: 'error'; message: string }

/**
 * get_estimate_total（READ ONLY）: 現在案件の見積合計を EstimateTab と同じ計算関数で返す。
 * RLS 有効なクライアントを使い、projectId はサーバー側でセッションから注入された値のみ使う。
 */
export async function executeGetEstimateTotal(
  supabase: SupabaseClient,
  projectId: string,
): Promise<GetEstimateTotalResult> {
  const [itemsRes, projectRes] = await Promise.all([
    supabase.from('estimate_items')
      .select('quantity,selling_price,amount')
      .eq('project_id', projectId)
      .is('deleted_at', null),
    supabase.from('projects')
      .select('misc_expense_override,rounding_discount')
      .eq('id', projectId)
      .is('deleted_at', null)
      .maybeSingle(),
  ])

  // 取得失敗を「0件」と誤認させない
  if (itemsRes.error || projectRes.error || !projectRes.data) {
    console.error('[get_estimate_total] query failed:', itemsRes.error?.message ?? projectRes.error?.message ?? 'project not found')
    return { status: 'error', message: '見積データを取得できませんでした。金額は推測せず、画面の見積タブを確認するよう伝えてください。' }
  }

  const items   = (itemsRes.data ?? []) as EstimateTotalItem[]
  const project = projectRes.data as { misc_expense_override: number | null; rounding_discount: number | null }
  const totals  = calculateEstimateTotals(items, {
    miscExpenseOverride: project.misc_expense_override ?? null,
    roundingDiscount:    project.rounding_discount ?? 0,
  })

  return {
    status:              'ok',
    item_count:          items.length,
    item_subtotal:       totals.itemSubtotal,
    overhead:            totals.overhead,
    overhead_source:     project.misc_expense_override != null ? 'override' : 'default_rate',
    rounding_discount:   totals.roundingDiscount,
    pre_tax_total:       totals.preTaxTotal,
    tax:                 totals.tax,
    tax_rate:            TAX_RATE,
    total_including_tax: totals.totalIncludingTax,
    note: items.length === 0
      ? 'この案件の見積明細は0件です。'
      : '金額は RAGZ が見積画面と同じ計算式で算出した値です。AI 側で再計算・補正せずそのまま回答してください。',
  }
}
