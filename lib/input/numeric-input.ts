/**
 * 数値入力の解釈（RAGZ 共通の Source of Truth）
 *
 * 設計原則:
 *   - Pure functions のみ。React / fetch / side effect は持たない
 *   - 金額・数量・掛け率・粗利率など、ユーザーが手で打つ（または貼り付ける）数値はすべてここで解釈する
 *   - 解釈できない入力は null を返す。0 や NaN に変換しない（＝呼び出し側は「保存しない」を選べる）
 *
 * 受け付ける表記:
 *   全角数字（１２３）/ 桁区切り（145,000・１４５，０００）/ 通貨記号（¥ ￥ 円）
 *   全角・和文のマイナス（− － ー ‐）/ 全角小数点（． 。）/ 単位記号（% ％ × x）/ 空白
 */

/** 表記ゆれを半角の数値文字列に揃える（数値として妥当かは判定しない） */
function normalizeNumericText(text: string): string {
  return text
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．。]/g, '.')
    .replace(/[−－ー‐]/g, '-')
    .replace(/[,，、¥￥円%％×xX\s]/g, '')
}

/** 符号・整数部・小数部だけで構成された文字列か（指数表記や 12abc のような混在は不可） */
const NUMERIC_PATTERN = /^-?(\d+\.?\d*|\.\d+)$/

/**
 * 入力文字列を数値として解釈する。解釈できなければ null。
 *
 *   '１２３４５' → 12345      '145,000' → 145000     '¥145,000' → 145000
 *   '￥１４５，０００' → 145000  '-500' → -500          '1.5' → 1.5
 *   '' / 'abc' / '12abc' / '1e5' / '1.2.3' → null
 */
export function parseNumericInput(text: string): number | null {
  const t = normalizeNumericText(text)
  if (!NUMERIC_PATTERN.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * 数値セルの入力確定時の扱い。
 *   - clear : 空欄にした（値を消す意図）
 *   - save  : 解釈できた数値を保存する
 *   - revert: 解釈できない → 保存せず、元の値のままにする
 */
export type NumericCommit =
  | { action: 'clear' }
  | { action: 'save'; value: number }
  | { action: 'revert' }

export function resolveNumericCommit(draft: string): NumericCommit {
  if (draft.trim() === '') return { action: 'clear' }
  const value = parseNumericInput(draft)
  return value == null ? { action: 'revert' } : { action: 'save', value }
}
