/**
 * 見積エディタ「行を追加 / 見出し行 / メモ行」ドラッグ時の挿入位置ライン。
 * ラインは見積テーブルの「いま見えている範囲」の中だけに描く（サイドバー側・画面右端・
 * sticky ツールバーの上へはみ出さない）。座標はすべて viewport（getBoundingClientRect）基準。
 */

export type Box = { left: number; right: number; top: number; bottom: number }

/** ラインの太さ（px） */
export const INSERTION_LINE_HEIGHT = 4

/** 複数の矩形の共通部分。重なりがなければ null */
export function intersectBoxes(...boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  const r: Box = {
    left:   Math.max(...boxes.map(b => b.left)),
    right:  Math.min(...boxes.map(b => b.right)),
    top:    Math.max(...boxes.map(b => b.top)),
    bottom: Math.min(...boxes.map(b => b.bottom)),
  }
  return r.right > r.left && r.bottom > r.top ? r : null
}

/**
 * 行の左右端と挿入位置 y から、表示範囲 visible 内に収まるラインの位置を返す。
 * 行が横方向に表示範囲外、または y が表示範囲の上下外なら null（非表示）。
 * 返す矩形（left..left+width, top..top+height）は必ず visible に含まれる。
 */
export function clipInsertionLine(
  row: { left: number; right: number },
  y: number,
  visible: Box | null,
  height = INSERTION_LINE_HEIGHT,
): { left: number; width: number; top: number; height: number } | null {
  if (!visible) return null
  const left  = Math.max(row.left, visible.left)
  const right = Math.min(row.right, visible.right)
  if (right <= left) return null
  if (y < visible.top || y > visible.bottom) return null
  if (visible.bottom - visible.top < height) return null
  const top = Math.min(Math.max(y - height / 2, visible.top), visible.bottom - height)
  return { left, width: right - left, top, height }
}
