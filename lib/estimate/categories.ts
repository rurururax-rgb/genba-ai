// 10工種それぞれに固有の色を割り当てる（重複なし）
// bg: ラベル背景色（淡色）、text: ラベル文字色（濃色）
export const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  '仮設工事':       { bg: '#EDE9FE', text: '#6D28D9' },  // purple
  '解体工事':       { bg: '#FEE2E2', text: '#B91C1C' },  // red
  '給排水設備工事': { bg: '#DBEAFE', text: '#1D4ED8' },  // blue
  '電気配線工事':   { bg: '#FEF3C7', text: '#B45309' },  // amber
  '木工事':         { bg: '#D1FAE5', text: '#065F46' },  // emerald
  '左官工事':       { bg: '#F1F5F9', text: '#334155' },  // slate
  '内装工事':       { bg: '#FCE7F3', text: '#9D174D' },  // pink
  '設備機器':       { bg: '#CFFAFE', text: '#155E75' },  // cyan
  '鋼製建具工事':   { bg: '#FFEDD5', text: '#9A3412' },  // orange
  '屋根・外壁工事': { bg: '#DCFCE7', text: '#14532D' },  // green
}

// CLAUDE.md v3.3 で定義された10工種のブロック番号マッピング
// ブロック番号はExcelシート番号に対応する（1始まり）
export const CATEGORY_TO_BLOCK: Record<string, number> = {
  '仮設工事':       1,
  '解体工事':       2,
  '給排水設備工事': 3,
  '電気配線工事':   4,
  '木工事':         5,
  '左官工事':       6,
  '内装工事':       7,
  '設備機器':       8,
  '鋼製建具工事':   9,
  '屋根・外壁工事': 10,
}

// 順序付き配列（見積タブ表示など配列が必要な箇所で使用）
export const CATEGORY_ORDER = Object.keys(CATEGORY_TO_BLOCK)

function rankOf(cat: string): number {
  const block = CATEGORY_TO_BLOCK[cat]
  return block !== undefined ? block - 1 : CATEGORY_ORDER.length  // 未定義は末尾（UI表示用）
}

/**
 * Excel書き込み前に全アイテムのカテゴリを厳密検証する。
 * CATEGORY_TO_BLOCK に存在しないカテゴリが1件でもあればエラーをスローする。
 */
export function validateCategoriesForExcel(
  items: { category: string | null | undefined }[],
): void {
  for (const item of items) {
    if (!item.category || !(item.category in CATEGORY_TO_BLOCK)) {
      throw new Error(
        `未対応の工種です: "${item.category ?? '（未設定）'}" — 対応工種: ${Object.keys(CATEGORY_TO_BLOCK).join('、')}`,
      )
    }
  }
}

/**
 * items を category でグループ化し、CATEGORY_ORDER 順にソートした Map を返す。
 * @param items       グループ化対象のアイテム配列
 * @param getCategory アイテムから category 文字列（null/undefined = '未分類'）を取り出す関数
 */
export function groupByCategory<T>(
  items: T[],
  getCategory: (item: T) => string | null | undefined,
): Map<string, T[]> {
  const raw = new Map<string, T[]>()
  for (const item of items) {
    const cat = getCategory(item) ?? '未分類'
    if (!raw.has(cat)) raw.set(cat, [])
    raw.get(cat)!.push(item)
  }
  return new Map(
    [...raw.entries()].sort(([a], [b]) => rankOf(a) - rankOf(b)),
  )
}
