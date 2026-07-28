/**
 * estimate_items.memo に格納される「（現場メモ: ...）」形式の文字列から
 * 接頭辞と括弧を除去し、中身だけを返す。
 *
 * fill-template.ts でExcelテンプレートのJ列（備考）に書き込む際に使用する。
 *
 * 例:
 *   "（現場メモ: 12m / TOTO VP管）" → "12m / TOTO VP管"
 *   "（現場メモ: LIXIL アライズ）"  → "LIXIL アライズ"
 *   "その他のメモ"                   → "その他のメモ"（そのまま返す）
 *   null / undefined                 → null
 */
export function extractMemoContent(memo: string | null | undefined): string | null {
  if (!memo) return null
  const match = memo.match(/^（現場メモ: (.+)）$/)
  return match ? match[1] : memo
}
