/**
 * 見積合計の共通 Calculation Layer（EstimateTab の画面表示と AI ツール get_estimate_total が共用）
 * Pure functions のみ。計算式を変えると画面の金額も変わるため、変更時は両方の影響を確認すること。
 */

/** 諸経費の既定率（小計 × 8%）。misc_expense_override があればそちらを使う */
export const OVERHEAD_RATE = 0.08
/** 消費税率（税抜合計 × 10%、切り捨て） */
export const TAX_RATE = 0.1

export type EstimateTotalItem = {
  quantity:      number
  selling_price: number | null
  amount:        number | null
}

export type EstimateTotalSettings = {
  miscExpenseOverride: number | null
  roundingDiscount:    number
}

export type EstimateTotals = {
  itemSubtotal:      number
  overhead:          number
  roundingDiscount:  number
  preTaxTotal:       number
  tax:               number
  totalIncludingTax: number
}

/** 明細1行の金額。売価があれば数量×売価（四捨五入）、なければ DB の amount */
export function liveAmount(item: EstimateTotalItem): number {
  return item.selling_price != null ? Math.round(item.quantity * item.selling_price) : (item.amount ?? 0)
}

export function calculateEstimateTotals(
  items: readonly EstimateTotalItem[],
  settings: EstimateTotalSettings,
): EstimateTotals {
  const itemSubtotal = items.reduce((acc, i) => acc + liveAmount(i), 0)
  const overhead     = settings.miscExpenseOverride != null
    ? settings.miscExpenseOverride
    : Math.round(itemSubtotal * OVERHEAD_RATE)
  const preTaxTotal  = itemSubtotal + overhead - settings.roundingDiscount
  const tax          = Math.floor(preTaxTotal * TAX_RATE)
  return {
    itemSubtotal,
    overhead,
    roundingDiscount:  settings.roundingDiscount,
    preTaxTotal,
    tax,
    totalIncludingTax: preTaxTotal + tax,
  }
}
