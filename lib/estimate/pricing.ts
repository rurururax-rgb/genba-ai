/**
 * 売価計算の共通 Calculation Layer
 *
 * 設計原則:
 *   - Pure functions のみ。Supabase / React / fetch / side effect は持たない
 *   - DB保存は呼び出し側の責任
 *   - 1.45 という定数はここだけに定義する（既存コードの1.45はSTEP 2B以降で置換）
 *   - selling_price_mode の判定もここで扱う
 *
 * 参照: CLAUDE.md 「Variable Markup effectiveMarkup定義」
 *   effectiveMarkup = item.markup_rate_override ?? project.markup_rate ?? DEFAULT_MARKUP_RATE
 */

/** 案件標準掛け率が未設定の場合のフォールバック値 */
export const DEFAULT_MARKUP_RATE = 1.45

/**
 * 実効掛け率を決定する。
 * 明細override → 案件標準 → システムデフォルト の優先順。
 */
export function getEffectiveMarkupRate(
  projectMarkupRate:  number | null | undefined,
  itemMarkupOverride: number | null | undefined,
): number {
  return itemMarkupOverride ?? projectMarkupRate ?? DEFAULT_MARKUP_RATE
}

/**
 * 原価と掛け率から売価を計算する。
 * 既存の Math.round(cost * rate) を完全に再現する。
 *
 * 無効な入力は null を返す（既存UIを壊すような throw はしない）:
 *   - cost が null / undefined / NaN / Infinity → null
 *   - rate が 0 以下 / null / undefined / NaN / Infinity → null
 *   - cost = 0 → 0（0円工事は有効）
 */
export function calculateSellingPrice(
  costPrice:  number | null | undefined,
  markupRate: number | null | undefined,
): number | null {
  if (costPrice == null || !Number.isFinite(costPrice)) return null
  const rate = markupRate ?? DEFAULT_MARKUP_RATE
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.round(costPrice * rate)
}

/**
 * 売価権威モードと既存売価を考慮して最終的な selling_price を解決する。
 *
 * - mode = 'auto'  : cost_price × markupRate で再計算
 * - mode = 'manual': 既存 selling_price をそのまま返す（cost / markup 変化でも変えない）
 *
 * DB の selling_price_mode 列が未実装でも呼び出せる設計にしてある。
 * 既存コードで selling_price_mode を持たない箇所は、手動フラグの代わりに
 * mode='manual' を渡して挙動を再現できる。
 */
export function resolveSellingPrice(
  mode:            SellingPriceMode,
  existingSelling: number | null | undefined,
  costPrice:       number | null | undefined,
  markupRate:      number | null | undefined,
): number | null {
  if (mode === 'manual') return existingSelling ?? null
  return calculateSellingPrice(costPrice, markupRate)
}

/**
 * 粗利率を計算する。
 * gross_margin_rate = (selling - cost) / selling
 *
 * selling = 0 や無効値の場合は null を返す。
 */
export function calculateGrossMarginRate(
  costPrice:    number | null | undefined,
  sellingPrice: number | null | undefined,
): number | null {
  if (costPrice == null || sellingPrice == null) return null
  if (!Number.isFinite(costPrice) || !Number.isFinite(sellingPrice)) return null
  if (sellingPrice === 0) return null
  return (sellingPrice - costPrice) / sellingPrice
}

/**
 * 掛け率から粗利率を直接計算するショートカット。
 * markupToMarginRate(1.45) ≈ 0.31034...
 *
 * markup = 0 以下や無効値の場合は null を返す。
 */
export function markupToMarginRate(markupRate: number): number | null {
  if (!Number.isFinite(markupRate) || markupRate <= 0) return null
  return (markupRate - 1) / markupRate
}

/**
 * 粗利率から掛け率へ変換する（markupToMarginRate の逆関数）。
 * markup = 1 / (1 - margin)
 *
 * 丸めない。DB (markup_rate_override: NUMERIC) へそのまま保存することで、
 * calculateSellingPrice(cost, markup) = Math.round(cost / (1 - margin)) が成立する。
 * 例: margin 0.30 → 1.428571… → 原価100,000 の売価 142,857
 *
 * margin >= 1 や無効値は null を返す。
 */
export function marginRateToMarkup(marginRate: number): number | null {
  if (!Number.isFinite(marginRate) || marginRate >= 1) return null
  return 1 / (1 - marginRate)
}

/**
 * 原価と売価から実効掛け率を逆算する（MANUAL 行の表示用）。
 * cost が 0 以下 / 無効値なら null。
 */
export function deriveMarkupRate(
  costPrice:    number | null | undefined,
  sellingPrice: number | null | undefined,
): number | null {
  if (costPrice == null || sellingPrice == null) return null
  if (!Number.isFinite(costPrice) || !Number.isFinite(sellingPrice)) return null
  if (costPrice <= 0) return null
  return sellingPrice / costPrice
}

/** UI の入力範囲（DB CHECK 制約 0.01〜9.99 と一致） */
export const MIN_MARKUP_RATE = 0.01
export const MAX_MARKUP_RATE = 9.99

export function isValidMarkupRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= MIN_MARKUP_RATE && rate <= MAX_MARKUP_RATE
}

/**
 * 画面表示上「同じ掛け率」と見なせるか。
 * 掛け率（小数2桁）と粗利率（0.1%単位）の表示がどちらも一致すれば同じとする。
 * 例: 粗利31%入力 → ×1.4493 は、案件標準 ×1.45（粗利31.0%）と同じ
 */
export function isSameDisplayedRate(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (Math.abs(a - b) < 1e-9) return true
  const ma = markupToMarginRate(a)
  const mb = markupToMarginRate(b)
  if (ma == null || mb == null) return false
  return Math.round(a * 100) === Math.round(b * 100) && Math.round(ma * 1000) === Math.round(mb * 1000)
}

/**
 * 明細に保存する override 値を正規化する。
 * 案件標準と（表示上）同じ値なら null（= 案件標準に従う）として保存する。
 * 掛け率から入力しても粗利率から入力しても、同じ見た目の値なら同じ状態になる。
 */
export function normalizeMarkupOverride(
  rate:              number,
  projectMarkupRate: number | null | undefined,
): number | null {
  const projRate = projectMarkupRate ?? DEFAULT_MARKUP_RATE
  return isSameDisplayedRate(rate, projRate) ? null : rate
}

/**
 * 明細の価格状態（UI 表示用）。
 *
 * 表示する掛け率・粗利率は常に「実際の原価と売価」から逆算した値。
 * これにより MANUAL 行で override が売価に反映されていなくても、
 * 画面上の 掛け率 / 粗利率 / 売価 が数学的に矛盾しない。
 *
 * - basis 'no_cost' : 原価未入力（または 0 以下）→ 掛け率・粗利率から売価を計算できない
 * - basis 'manual'  : 売価はユーザーが直接決定
 * - basis 'override': AUTO + 明細の個別掛け率
 * - basis 'project' : AUTO + 案件標準掛け率
 */
export type PricingBasis = 'no_cost' | 'manual' | 'override' | 'project'

export type ItemPricingState = {
  basis:          PricingBasis
  /** AUTO 時に適用される掛け率（override → 案件標準 → デフォルト） */
  configuredRate: number
  /** 実際の 売価 ÷ 原価。算出不可なら null */
  actualMarkup:   number | null
  /** 実際の (売価 - 原価) ÷ 売価。算出不可なら null */
  actualMargin:   number | null
}

export function getItemPricingState(
  item: {
    cost_price:            number | null | undefined
    selling_price:         number | null | undefined
    selling_price_mode?:   SellingPriceMode | null
    markup_rate_override?: number | null
  },
  projectMarkupRate: number | null | undefined,
): ItemPricingState {
  const configuredRate = getEffectiveMarkupRate(projectMarkupRate, item.markup_rate_override)
  const actualMarkup   = deriveMarkupRate(item.cost_price, item.selling_price)
  const actualMargin   = calculateGrossMarginRate(item.cost_price, item.selling_price)
  const hasCost        = item.cost_price != null && Number.isFinite(item.cost_price) && item.cost_price > 0
  const basis: PricingBasis =
    !hasCost                                   ? 'no_cost'
    : (item.selling_price_mode ?? 'auto') === 'manual' ? 'manual'
    : item.markup_rate_override != null        ? 'override'
    : 'project'
  return { basis, configuredRate, actualMarkup, actualMargin }
}

/** selling_price の権威を表す型（DB の selling_price_mode 列と対応） */
export type SellingPriceMode = 'auto' | 'manual'
