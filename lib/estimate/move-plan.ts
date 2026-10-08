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
 * 選択行を targetGroupId（null = 未分類）の末尾へ、元の表示順のまま移動する計画。
 * 移動先の既存行（選択行を含む）の最大 sort_order より後ろに ORDER_STEP 間隔で並べるので、
 * 移動先で sort_order が重複しない。
 */
export function planMoveToGroup(
  items: MovableRow[],
  selectedIds: ReadonlySet<string>,
  groupOrder: string[],
  targetGroupId: string | null,
): MoveUpdate[] {
  const selected = sortByDisplayOrder(items.filter(i => selectedIds.has(i.id)), groupOrder)
  if (selected.length === 0) return []
  const target = items.filter(i => i.group_id === targetGroupId)
  const base = target.length > 0 ? Math.max(...target.map(i => i.sort_order)) + ORDER_STEP : 0
  return selected.map((row, i) => ({ id: row.id, group_id: targetGroupId, sort_order: base + i * ORDER_STEP }))
}
