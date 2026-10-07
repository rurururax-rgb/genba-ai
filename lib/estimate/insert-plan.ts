/**
 * 見積エディタ「行間の ＋」から行を挿入するときの sort_order 計画。
 * DOM 座標は一切使わず、グループ内の表示順と挿入位置（index）だけで決める。
 *
 * - groupItems はグループ（または未分類「その他」）の行を表示順に並べたもの
 * - insertIndex = 新しい行が入る位置（0 = 先頭、groupItems.length = 末尾）
 * - 前後の行の間に整数の空きがなければ、先にグループ全体を 0, 1000, 2000… に振り直す
 *   （ドラッグ並び替えと同じ間隔）。振り直しが必要な行だけ renumber に入る。
 * - sort_order は INT 列で、同値だと DB の ORDER BY が不定（再読込で順序が変わる）になるため、
 *   結果は必ず「既存行と重複しない・表示順と一致する」値にする。
 */

export const ORDER_STEP = 1000

export type OrderedRow = { id: string; sort_order: number }

export type InsertPlan = {
  /** 新しい行に付ける sort_order */
  sortOrder: number
  /** 挿入前に保存が必要な既存行の sort_order（不要なら空配列） */
  renumber: OrderedRow[]
}

function isStrictlyIncreasingInts(rows: OrderedRow[]): boolean {
  for (let i = 0; i < rows.length; i++) {
    if (!Number.isInteger(rows[i].sort_order)) return false
    if (i > 0 && rows[i].sort_order <= rows[i - 1].sort_order) return false
  }
  return true
}

export function planInsert(groupItems: OrderedRow[], insertIndex: number): InsertPlan {
  const n = groupItems.length
  const index = Math.min(Math.max(Math.trunc(insertIndex) || 0, 0), n)

  if (n === 0) return { sortOrder: 0, renumber: [] }

  if (isStrictlyIncreasingInts(groupItems)) {
    const prev = index > 0 ? groupItems[index - 1].sort_order : null
    const next = index < n ? groupItems[index].sort_order : null
    if (prev === null && next !== null) return { sortOrder: next - ORDER_STEP, renumber: [] }
    if (next === null && prev !== null) return { sortOrder: prev + ORDER_STEP, renumber: [] }
    if (prev !== null && next !== null && next - prev >= 2) {
      return { sortOrder: Math.floor((prev + next) / 2), renumber: [] }
    }
  }

  // 空きなし（または既存の順序が重複・非整数）→ 新しい行の分を空けてグループ全体を振り直す
  const renumber: OrderedRow[] = []
  groupItems.forEach((row, i) => {
    const order = (i < index ? i : i + 1) * ORDER_STEP
    if (row.sort_order !== order) renumber.push({ id: row.id, sort_order: order })
  })
  return { sortOrder: index * ORDER_STEP, renumber }
}

/** planInsert の結果を適用した後の並び（テスト・ローカル反映用）。表示順に並べて返す */
export function applyInsertPlan<T extends OrderedRow>(groupItems: T[], plan: InsertPlan, newRow: T): T[] {
  const next = new Map(plan.renumber.map(r => [r.id, r.sort_order]))
  return [
    ...groupItems.map(r => (next.has(r.id) ? { ...r, sort_order: next.get(r.id)! } : r)),
    { ...newRow, sort_order: plan.sortOrder },
  ].sort((a, b) => a.sort_order - b.sort_order)
}
