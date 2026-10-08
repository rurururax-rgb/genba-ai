import { describe, it, expect } from 'vitest'
import { planMoveToGroup, sortByDisplayOrder, type MovableRow } from '@/lib/estimate/move-plan'

const G1 = 'g1'
const G2 = 'g2'
const row = (id: string, group_id: string | null, sort_order: number): MovableRow => ({ id, group_id, sort_order })

/** DB を ORDER BY（工種の表示順 → sort_order）で読み直したときの各グループの並び */
function reload(rows: MovableRow[], groupOrder: string[], gid: string | null) {
  return sortByDisplayOrder(rows.filter(r => r.group_id === gid), groupOrder).map(r => r.id)
}

function apply(rows: MovableRow[], updates: { id: string; group_id: string | null; sort_order: number }[]) {
  return rows.map(r => {
    const u = updates.find(x => x.id === r.id)
    return u ? { ...r, group_id: u.group_id, sort_order: u.sort_order } : r
  })
}

describe('planMoveToGroup：選択行の「移動先」', () => {
  // A, B, C, D（工種1）と X, Y（工種2）
  const items = [
    row('A', G1, 0), row('B', G1, 1000), row('C', G1, 2000), row('D', G1, 3000),
    row('X', G2, 0), row('Y', G2, 1000),
  ]
  const groupOrder = [G1, G2]

  it('D を先に、B を後に選択しても、移動後は B, D（元の表示順）', () => {
    const selected = new Set(['D', 'B'])  // Set の挿入順 = 選択した順
    const updates = planMoveToGroup(items, selected, groupOrder, G2)
    expect(updates.map(u => u.id)).toEqual(['B', 'D'])
    const after = apply(items, updates)
    expect(reload(after, groupOrder, G2)).toEqual(['X', 'Y', 'B', 'D'])
    expect(reload(after, groupOrder, G1)).toEqual(['A', 'C'])
  })

  it('工種をまたいだ選択も表示順（工種順 → sort_order）。sort_order だけで並べない', () => {
    // Y(工種2, 1000) を先に、C(工種1, 2000) を後に選択 → 表示順では C が先
    const updates = planMoveToGroup(items, new Set(['Y', 'C']), groupOrder, null)
    expect(updates.map(u => u.id)).toEqual(['C', 'Y'])
    // 工種の表示順が逆なら Y が先
    expect(planMoveToGroup(items, new Set(['C', 'Y']), [G2, G1], null).map(u => u.id)).toEqual(['Y', 'C'])
  })

  it('移動先の末尾に 1000 間隔で付け、移動先で sort_order が重複しない', () => {
    const updates = planMoveToGroup(items, new Set(['A', 'C']), groupOrder, G2)
    expect(updates).toEqual([
      { id: 'A', group_id: G2, sort_order: 2000 },
      { id: 'C', group_id: G2, sort_order: 3000 },
    ])
    const tgt = apply(items, updates).filter(r => r.group_id === G2).map(r => r.sort_order)
    expect(new Set(tgt).size).toBe(tgt.length)
  })

  it('空の移動先は 0 から。未分類（null）へも移動できる', () => {
    const updates = planMoveToGroup(items, new Set(['D', 'A']), groupOrder, null)
    expect(updates).toEqual([
      { id: 'A', group_id: null, sort_order: 0 },
      { id: 'D', group_id: null, sort_order: 1000 },
    ])
  })

  it('同じ工種内で選ぶと末尾へ並びを保ったまま移る', () => {
    const after = apply(items, planMoveToGroup(items, new Set(['C', 'A']), groupOrder, G1))
    expect(reload(after, groupOrder, G1)).toEqual(['B', 'D', 'A', 'C'])
  })

  it('選択なし → 何もしない', () => {
    expect(planMoveToGroup(items, new Set(), groupOrder, G2)).toEqual([])
  })

  it('/reorder が途中で失敗しても、読み直した並びは一意で重複しない（保存済みの行だけ移動先に入る）', () => {
    const updates = planMoveToGroup(items, new Set(['D', 'B']), groupOrder, G2)
    const partially = apply(items, updates.slice(0, 1))  // 1 件目だけ保存された
    expect(reload(partially, groupOrder, G2)).toEqual(['X', 'Y', 'B'])
    expect(reload(partially, groupOrder, G1)).toEqual(['A', 'C', 'D'])
    for (const gid of [G1, G2]) {
      const so = partially.filter(r => r.group_id === gid).map(r => r.sort_order)
      expect(new Set(so).size).toBe(so.length)
    }
  })
})

describe('sortByDisplayOrder', () => {
  it('工種の表示順 → sort_order。未分類と不明な工種は最後', () => {
    const rows = [row('u', null, 0), row('b2', 'b', 0), row('a2', 'a', 1000), row('z', 'zz', 0), row('a1', 'a', 0)]
    expect(sortByDisplayOrder(rows, ['a', 'b']).map(r => r.id)).toEqual(['a1', 'a2', 'b2', 'u', 'z'])
  })
})
