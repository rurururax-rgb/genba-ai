import { describe, it, expect } from 'vitest'
import { planInsert, applyInsertPlan, ORDER_STEP, type OrderedRow } from '@/lib/estimate/insert-plan'

const rows = (...orders: number[]): OrderedRow[] => orders.map((o, i) => ({ id: `r${i}`, sort_order: o }))
const ids = (list: OrderedRow[]) => list.map(r => r.id)

/** 挿入後、DB の ORDER BY sort_order で読み直したときの並び（同値なし前提で一意） */
function insertAndReload(list: OrderedRow[], index: number, newId: string) {
  const plan = planInsert(list, index)
  const after = applyInsertPlan(list, plan, { id: newId, sort_order: 0 })
  return { plan, after }
}

function expectNoDuplicates(list: OrderedRow[]) {
  expect(new Set(list.map(r => r.sort_order)).size).toBe(list.length)
}

describe('planInsert：行間 ＋ からの挿入位置', () => {
  it('空グループ → 0・振り直しなし', () => {
    expect(planInsert([], 0)).toEqual({ sortOrder: 0, renumber: [] })
  })

  it('先頭 → 先頭行より前（旧実装の「先頭に入れたいのに末尾へ」バグの回帰）', () => {
    const list = rows(0, 1000, 2000)
    const { plan, after } = insertAndReload(list, 0, 'new')
    expect(plan.sortOrder).toBeLessThan(0)
    expect(plan.renumber).toEqual([])
    expect(ids(after)).toEqual(['new', 'r0', 'r1', 'r2'])
  })

  it('中間（空きあり）→ 中点・振り直しなし', () => {
    const plan = planInsert(rows(0, 1000, 2000), 1)
    expect(plan).toEqual({ sortOrder: 500, renumber: [] })
  })

  it('末尾 → 最終行 + 1000', () => {
    const plan = planInsert(rows(0, 1000, 2000), 3)
    expect(plan).toEqual({ sortOrder: 2000 + ORDER_STEP, renumber: [] })
  })

  it('空きが十分（差 2）→ 振り直しなしで間に入る', () => {
    const { plan, after } = insertAndReload(rows(10, 12), 1, 'new')
    expect(plan).toEqual({ sortOrder: 11, renumber: [] })
    expect(ids(after)).toEqual(['r0', 'new', 'r1'])
  })

  it('空きなし（差 1）→ グループを 0,1000,2000… に振り直してから挿入', () => {
    const { plan, after } = insertAndReload(rows(10, 11, 12), 1, 'new')
    expect(plan.sortOrder).toBe(1000)
    expect(plan.renumber).toEqual([
      { id: 'r0', sort_order: 0 },
      { id: 'r1', sort_order: 2000 },
      { id: 'r2', sort_order: 3000 },
    ])
    expect(ids(after)).toEqual(['r0', 'new', 'r1', 'r2'])
    expectNoDuplicates(after)
  })

  it('既存の sort_order が重複している → 振り直し（変わる行だけ renumber に入る）', () => {
    const { plan, after } = insertAndReload(rows(0, 1000, 1000), 3, 'new')
    expect(plan.renumber).toEqual([{ id: 'r2', sort_order: 2000 }])
    expect(plan.sortOrder).toBe(3000)
    expect(ids(after)).toEqual(['r0', 'r1', 'r2', 'new'])
    expectNoDuplicates(after)
  })

  it('同じ隙間へ 20 回連続で挿入しても重複せず、毎回その位置に入る', () => {
    let list = rows(0, 1000)
    for (let k = 0; k < 20; k++) {
      // 常に「r0 の直後」へ挿入 → 新しい行ほど r0 の直後に来る
      const { after } = insertAndReload(list, 1, `n${k}`)
      expectNoDuplicates(after)
      expect(after[0].id).toBe('r0')
      expect(after[1].id).toBe(`n${k}`)
      expect(after[after.length - 1].id).toBe('r1')
      list = after
    }
    expect(list).toHaveLength(22)
  })

  it('先頭・末尾にも 20 回連続で挿入でき、重複しない', () => {
    let list = rows(0)
    for (let k = 0; k < 20; k++) {
      list = insertAndReload(list, 0, `h${k}`).after
      list = insertAndReload(list, list.length, `t${k}`).after
      expectNoDuplicates(list)
    }
    expect(list[0].id).toBe('h19')
    expect(list[list.length - 1].id).toBe('t19')
  })

  it('並びは sort_order だけで再現できる（再読込しても同じ順）', () => {
    let list = rows(0, 1, 2, 3)
    list = insertAndReload(list, 2, 'a').after
    list = insertAndReload(list, 0, 'b').after
    list = insertAndReload(list, 3, 'c').after
    const reloaded = [...list].reverse().sort((x, y) => x.sort_order - y.sort_order)
    expect(ids(reloaded)).toEqual(ids(list))
    expect(list.every(r => Number.isInteger(r.sort_order))).toBe(true)
  })

  it('範囲外の index は先頭／末尾に丸める', () => {
    expect(planInsert(rows(0, 1000), -5).sortOrder).toBe(-1000)
    expect(planInsert(rows(0, 1000), 99).sortOrder).toBe(2000)
  })
})
