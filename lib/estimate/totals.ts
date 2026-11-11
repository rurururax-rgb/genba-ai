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

/**
 * 円未満の四捨五入。0.5 円は 0 から遠い方へ丸める（値引きの -0.5 円は -1 円。Math.round だと -0 になる）。
 * 12.5 × 2,755 のような小数の掛け算の誤差（例: 4.35 × 100 = 434.99999999999994）を 6 桁で吸収してから丸める。
 */
export function roundYen(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(Number(Math.abs(value).toFixed(6)))
  return rounded === 0 ? 0 : Math.sign(value) * rounded
}

/**
 * 明細1行の金額（円）。売価があれば 数量×売価 を四捨五入、なければ DB の amount を四捨五入。
 * 見積の合計は、この行ごとの金額を足して作る（合計だけを丸めない）。数量・売価そのものは丸めない。
 * DB の estimate_items.amount（GENERATED: quantity × selling_price）は円未満を含みうるので、合計・出力に直接使わない。
 */
export function liveAmount(item: EstimateTotalItem): number {
  if (item.selling_price != null) return roundYen(item.quantity * item.selling_price)
  return item.amount == null ? 0 : roundYen(item.amount)
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
