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

/**
 * <input type="number"> の入力中の文字列（draft）。
 *
 * 数値で制御する（value={0}）と、React は DOM の "01000" と state の 1000 を等しいとみなして
 * DOM を書き換えないため、先頭の 0 が画面に残る。入力中は文字列で持ち、確定値（数値）と分ける。
 *
 *   '01000' → '1000'   '001000' → '1000'   '-05' → '-5'   '0' → '0'   '0.5' → '0.5'   '' → ''
 *
 * type="number" の value は、ブラウザが数値として解釈できる文字列か ''（空欄・途中の '-' など）だけ。
 */
export function normalizeNumberDraft(raw: string): string {
  return raw.replace(/^(-?)0+(?=\d)/, '$1')
}

/** draft が表す数値。空欄（入力途中）は 0 として扱う（合計の計算・保存用） */
export function numberDraftValue(draft: string): number {
  if (draft === '') return 0
  const n = Number(draft)
  return Number.isFinite(n) ? n : 0
}

/**
 * 外から値が変わったとき（支払種別の自動入力・保存後の再読み込みなど）の draft。
 * draft が今の値を表していれば、入力中の文字列（空欄・'1.' など）をそのまま残す。
 */
export function syncNumberDraft(draft: string, value: number): string {
  return numberDraftValue(draft) === value ? draft : String(value)
}
