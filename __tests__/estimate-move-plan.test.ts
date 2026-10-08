import { describe, it, expect } from 'vitest'
import { planMove, sortByDisplayOrder, type MovableRow, type MoveDestination, type MoveUpdate } from '@/lib/estimate/move-plan'

const G1 = 'g1'  // 内装
const G2 = 'g2'  // 外装
const groupOrder = [G1, G2]
const row = (id: string, group_id: string | null, sort_order: number): MovableRow => ({ id, group_id, sort_order })

/** 工種1: A B C D E / 工種2: X Y Z / その他: N1 N2 */
const items: MovableRow[] = [
  row('A', G1, 0), row('B', G1, 1000), row('C', G1, 2000), row('D', G1, 3000), row('E', G1, 4000),
  row('X', G2, 0), row('Y', G2, 1000), row('Z', G2, 2000),
  row('N1', null, 0), row('N2', null, 1000),
]

function apply(rows: MovableRow[], updates: MoveUpdate[]) {
  return rows.map(r => {
    const u = updates.find(x => x.id === r.id)
    return u ? { ...r, group_id: u.group_id, sort_order: u.sort_order } : r
  })
}

/** DB を ORDER BY（工種の表示順 → sort_order）で読み直したときの、工種ごとの並び */
function reload(rows: MovableRow[]) {
  const sorted = sortByDisplayOrder(rows, groupOrder)
  const by = (gid: string | null) => sorted.filter(r => r.group_id === gid).map(r => r.id).join(' ')
  return { [G1]: by(G1), [G2]: by(G2), none: by(null) }
}

function move(ids: Iterable<string>, dest: MoveDestination, rows = items) {
  const updates = planMove(rows, ids, groupOrder, dest)
  const after = apply(rows, updates)
  // どの工種でも sort_order が重複しない
  for (const gid of [G1, G2, null]) {
    const so = after.filter(r => r.group_id === gid).map(r => r.sort_order)
    expect(new Set(so).size, `duplicate sort_order in ${gid}`).toBe(so.length)
  }
  return { updates, after: reload(after) }
}

describe('planMove：1 行', () => {
  it('同じ工種の先頭へ', () => {
    expect(move(['D'], { groupId: G1, beforeId: 'A' }).after[G1]).toBe('D A B C E')
  })
  it('同じ工種の途中へ（B を C と D の間へ → A C B D E。抜く前の index を使わない）', () => {
    expect(move(['B'], { groupId: G1, beforeId: 'D' }).after[G1]).toBe('A C B D E')
  })
  it('同じ工種の末尾へ', () => {
    expect(move(['A'], { groupId: G1, beforeId: null }).after[G1]).toBe('B C D E A')
  })
  it('別の工種の先頭へ', () => {
    const r = move(['C'], { groupId: G2, beforeId: 'X' }).after
    expect(r[G2]).toBe('C X Y Z')
    expect(r[G1]).toBe('A B D E')
  })
  it('別の工種の途中へ', () => {
    expect(move(['C'], { groupId: G2, beforeId: 'Y' }).after[G2]).toBe('X C Y Z')
  })
  it('別の工種の末尾へ', () => {
    expect(move(['C'], { groupId: G2, beforeId: null }).after[G2]).toBe('X Y Z C')
  })
})

describe('planMove：複数行', () => {
  it('仕様例：B, C を E の後へ → A D E B C', () => {
    expect(move(['B', 'C'], { groupId: G1, beforeId: null }).after[G1]).toBe('A D E B C')
  })
  it('仕様例：内装 A, B を外装の C と D の間へ → C A B D', () => {
    const rows = [row('A', G1, 0), row('B', G1, 1000), row('C', G2, 0), row('D', G2, 1000)]
    const { updates, after } = move(['A', 'B'], { groupId: G2, beforeId: 'D' }, rows)
    expect(after[G2]).toBe('C A B D')
    expect(after[G1]).toBe('')
    // 変えるのは group_id と sort_order だけ
    for (const u of updates) expect(Object.keys(u).sort()).toEqual(['group_id', 'id', 'sort_order'])
  })
  it('離れた行（A, D）を Y の前へ', () => {
    const r = move(['A', 'D'], { groupId: G2, beforeId: 'Y' }).after
    expect(r[G2]).toBe('X A D Y Z')
    expect(r[G1]).toBe('B C E')
  })
  it('選択した順番が D → B でも結果は B → D（元の表示順）', () => {
    expect(move(new Set(['D', 'B']), { groupId: G2, beforeId: null }).after[G2]).toBe('X Y Z B D')
    expect(move(['D', 'B'], { groupId: G1, beforeId: 'A' }).after[G1]).toBe('B D A C E')
  })
  it('複数の工種から 1 つの工種へ：全体の表示順（工種順 → sort_order）を保つ', () => {
    // Z(工種2, 2000) と B(工種1, 1000) と N1(その他) → 表示順は B, Z, N1
    expect(move(['N1', 'Z', 'B'], { groupId: G1, beforeId: 'D' }).after[G1]).toBe('A C B Z N1 D E')
  })
  it('移動先が「その他」（group_id = null）', () => {
    const { updates, after } = move(['C', 'X'], { groupId: null, beforeId: 'N2' })
    expect(after.none).toBe('N1 C X N2')
    expect(updates.find(u => u.id === 'C')?.group_id).toBeNull()
  })
  it('移動元が「その他」（group_id = null）', () => {
    const r = move(['N2', 'N1'], { groupId: G2, beforeId: 'X' }).after
    expect(r[G2]).toBe('N1 N2 X Y Z')
    expect(r.none).toBe('')
  })
  it('空の工種へ（0 から振る）', () => {
    const { updates } = move(['B', 'A'], { groupId: 'g3', beforeId: null })
    expect(updates).toEqual([
      { id: 'A', group_id: 'g3', sort_order: 0 },
      { id: 'B', group_id: 'g3', sort_order: 1000 },
    ])
  })
})

describe('planMove：安全性', () => {
  it('beforeId が移動先の工種にない → 末尾', () => {
    expect(move(['A'], { groupId: G2, beforeId: 'missing' }).after[G2]).toBe('X Y Z A')
    expect(move(['A'], { groupId: G2, beforeId: 'C' }).after[G2]).toBe('X Y Z A')  // 別の工種の行 id
  })
  it('moveIds に存在しない id があっても無視する', () => {
    expect(move(['ghost', 'B'], { groupId: G2, beforeId: null }).after[G2]).toBe('X Y Z B')
    expect(planMove(items, ['ghost'], groupOrder, { groupId: G2, beforeId: null })).toEqual([])
  })
  it('beforeId が移動する行そのもの（移動中の行のすぐ上下の行間）→ その後ろで残る行の前とみなす', () => {
    // A [B] [C] D：B と C の間・B の上を押しても今と同じ位置 → 保存なし
    expect(planMove(items, ['B', 'C'], groupOrder, { groupId: G1, beforeId: 'C' })).toEqual([])
    expect(planMove(items, ['B', 'C'], groupOrder, { groupId: G1, beforeId: 'B' })).toEqual([])
    // 離れた行 [A] B [C] D：C の上（B と C の間）→ D の前 → B A C D E
    expect(move(['A', 'C'], { groupId: G1, beforeId: 'C' }).after[G1]).toBe('B A C D E')
    // 移動する行が末尾まで続くなら末尾
    expect(move(['B', 'E'], { groupId: G1, beforeId: 'E' }).after[G1]).toBe('A C D B E')
  })
  it('重複した id を渡しても 1 行として扱う', () => {
    const { updates, after } = move(['B', 'B', 'C', 'B'], { groupId: G2, beforeId: 'Y' })
    expect(after[G2]).toBe('X B C Y Z')
    expect(updates.filter(u => u.id === 'B')).toHaveLength(1)
  })
  it('今と同じ位置なら何も書き込まない（sort_order が詰まっていなくても）', () => {
    expect(planMove(items, ['B'], groupOrder, { groupId: G1, beforeId: 'C' })).toEqual([])
    expect(planMove(items, ['E'], groupOrder, { groupId: G1, beforeId: null })).toEqual([])
    const sparse = [row('P', G1, 5), row('Q', G1, 7), row('R', G1, 7000)]
    expect(planMove(sparse, ['Q'], groupOrder, { groupId: G1, beforeId: 'R' })).toEqual([])
  })
  it('選択なし → 何もしない', () => {
    expect(planMove(items, [], groupOrder, { groupId: G2, beforeId: null })).toEqual([])
  })
  it('書き込むのは移動先の工種で並びか工種が変わる行だけ（移動元は穴が空くだけで書かない）', () => {
    const { updates } = move(['B'], { groupId: G2, beforeId: null })
    expect(updates).toEqual([{ id: 'B', group_id: G2, sort_order: 3000 }])
  })
})

describe('planMove：読み直し', () => {
  it('保存後に ORDER BY で読み直しても同じ並び（一意な sort_order）', () => {
    const updates = planMove(items, ['E', 'A', 'Y'], groupOrder, { groupId: G1, beforeId: 'C' })
    const after = apply(items, updates)
    const shuffled = [...after].reverse()
    expect(reload(shuffled)).toEqual(reload(after))
    expect(reload(after)[G1]).toBe('B A E Y C D')
  })
  it('/reorder が途中で失敗しても、読み直した並びは一意で重複しない（保存済みの行だけ動く）', () => {
    const updates = planMove(items, ['D', 'B'], groupOrder, { groupId: G2, beforeId: null })
    const partially = apply(items, updates.slice(0, 1))
    expect(reload(partially)[G2]).toBe('X Y Z B')
    expect(reload(partially)[G1]).toBe('A C D E')
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
