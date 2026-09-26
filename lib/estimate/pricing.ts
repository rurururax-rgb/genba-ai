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

/** selling_price の権威を表す型（DB の selling_price_mode 列と対応） */
export type SellingPriceMode = 'auto' | 'manual'
