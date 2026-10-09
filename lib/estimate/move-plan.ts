/**
 * 見積エディタで「選択した行をまとめて動かす」ときの並び順。
 * sort_order はグループ（工種）ごとの値なので、グループをまたいで sort_order だけで並べると
 * 表示順と食い違う。必ず「工種の表示順 → グループ内 sort_order」で並べる。
 * 選択した順番（Set の挿入順）は使わない。
 */

import { ORDER_STEP } from '@/lib/estimate/insert-plan'

export type MovableRow = { id: string; group_id: string | null; sort_order: number }

export type MoveUpdate = { id: string; group_id: string | null; sort_order: number }

/**
 * 移動先。行間（InsertGap）と同じく工種と「この行の前」で表す。
 * index ではなく行 id を使うのは、移動する行を抜くと index がずれるため。
 * beforeId = null は工種の末尾。
 */
export type MoveDestination = { groupId: string | null; beforeId: string | null }

/**
 * 行を画面の表示順に並べる。groupOrder は工種 id の表示順。
 * 未分類（group_id = null）と groupOrder にない工種は、画面と同じく工種の後ろに置く。
 */
export function sortByDisplayOrder<T extends MovableRow>(rows: T[], groupOrder: string[]): T[] {
  const rank = new Map(groupOrder.map((id, i) => [id, i]))
  const groupRank = (gid: string | null) => (gid !== null && rank.has(gid) ? rank.get(gid)! : groupOrder.length)
  return [...rows].sort((a, b) =>
    groupRank(a.group_id) - groupRank(b.group_id) || a.sort_order - b.sort_order,
  )
}

/**
 * moveIds の行を dest の位置へ、元の表示順のまま移す計画。
 *
 * 1. 移動する行を表示順に並べる（存在しない id・重複 id は無視）
 * 2. 移動先の工種から移動する行を取り除く
 * 3. beforeId の前に差し込む。beforeId が移動する行そのもの（移動中の行のすぐ上下の行間）なら、
 *    その後ろで最初に残る行の前とみなす。見つからなければ末尾
 * 4. 移動先の工種だけ 0, 1000, 2000… で振り直す
 *
 * 移動元の工種は行が抜けて sort_order に穴が空くだけで順番は変わらないので書き込まない。
 * updates には group_id か sort_order が変わる行だけを入れる。並びが今と同じなら空（保存不要）。
 */
export function planMove(
  items: MovableRow[],
  moveIds: Iterable<string>,
  groupOrder: string[],
  dest: MoveDestination,
): MoveUpdate[] {
  const ids = new Set(moveIds)
  const moving = sortByDisplayOrder(items.filter(i => ids.has(i.id)), groupOrder)
  if (moving.length === 0) return []
  const movingIds = new Set(moving.map(i => i.id))

  const target = items
    .filter(i => i.group_id === dest.groupId)
    .sort((a, b) => a.sort_order - b.sort_order)
  const at = dest.beforeId === null ? -1 : target.findIndex(i => i.id === dest.beforeId)
  const before = at < 0 ? undefined : target.slice(at).find(i => !movingIds.has(i.id))

  const rest = target.filter(i => !movingIds.has(i.id))
  const insertAt = before ? rest.indexOf(before) : rest.length
  const next = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)]

  // 並びが今と同じ（移動する行がすべて移動先にあり順番も変わらない）なら、sort_order が詰まっていなくても書き込まない
  if (next.length === target.length && next.every((row, i) => row === target[i])) return []

  return next
    .map((row, i) => ({ row, sort_order: i * ORDER_STEP }))
    .filter(({ row, sort_order }) => row.group_id !== dest.groupId || row.sort_order !== sort_order)
    .map(({ row, sort_order }) => ({ id: row.id, group_id: dest.groupId, sort_order }))
}
