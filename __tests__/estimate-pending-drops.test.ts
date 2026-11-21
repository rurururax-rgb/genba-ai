import { describe, it, expect } from 'vitest'
import { mergeSavedItems, pendingSlots, savedItemsFrom, type PendingDrop } from '@/lib/estimate/pending-drops'

/** 見積エディタへのドロップの仮の行（lib/estimate/pending-drops.ts）。すべて架空の明細 */

const p = (tempId: string, afterItemId: string | null | undefined, groupId = 'g1'): PendingDrop =>
  ({ tempId, importId: `imp-${tempId}`, groupId, afterItemId, name: `架空 ${tempId}`, quantity: 1, unit: '式', cost_price: 1000 })

describe('仮の行を出す位置', () => {
  it('明細の後ろ・先頭・末尾に分け、ほかの工種の仮の行は含めない', () => {
    const s = pendingSlots(['a', 'b', 'c'], [p('1', 'b'), p('2', null), p('3', undefined), p('4', 'a', 'g2')], 'g1')
    expect(s.after.get('b')?.map(x => x.tempId)).toEqual(['1'])
    expect(s.head.map(x => x.tempId)).toEqual(['2'])
    expect(s.end.map(x => x.tempId)).toEqual(['3'])
    expect(s.after.has('a')).toBe(false)
  })

  it('同じ位置へ続けてドロップしたときは、保存後の並び（後のものほど前）と同じに出す', () => {
    // b の直後へ 1 → 2 → 3 の順にドロップ。保存は順に「b の直後」へ入るので、保存後は b, 3, 2, 1
    const s = pendingSlots(['a', 'b'], [p('1', 'b'), p('2', 'b'), p('3', 'b')], 'g1')
    expect(s.after.get('b')?.map(x => x.tempId)).toEqual(['3', '2', '1'])
    const h = pendingSlots(['a'], [p('1', null), p('2', null)], 'g1')
    expect(h.head.map(x => x.tempId)).toEqual(['2', '1'])
    // 末尾はドロップした順
    const e = pendingSlots(['a'], [p('1', undefined), p('2', undefined)], 'g1')
    expect(e.end.map(x => x.tempId)).toEqual(['1', '2'])
  })

  it('入れる位置の明細が無くなった・工種が空なら末尾に出す（保存も末尾になる）', () => {
    expect(pendingSlots(['a'], [p('1', 'deleted')], 'g1').end.map(x => x.tempId)).toEqual(['1'])
    expect(pendingSlots([], [p('1', null)], 'g1').end.map(x => x.tempId)).toEqual(['1'])
  })
})

describe('保存できた明細の反映', () => {
  it('新しい明細は追加し、同じ ID は DB の値で置き換える（並びは sort_order で決まる）', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    expect(mergeSavedItems(prev, [{ id: 'c', v: 3 }, { id: 'b', v: 20 }])).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 20 }, { id: 'c', v: 3 }])
  })

  it('登録 API の応答の形が違う・件数が合わないときは null（全件を読み直す）', () => {
    const ok = { created: 1, items: [{ id: 'x', sort_order: 5 }] }
    expect(savedItemsFrom(ok, 1)).toEqual(ok.items)
    expect(savedItemsFrom({ created: 1 }, 1)).toBeNull()
    expect(savedItemsFrom(ok, 2)).toBeNull()
    expect(savedItemsFrom({ items: [{ id: 1, sort_order: 5 }] }, 1)).toBeNull()
    expect(savedItemsFrom({ items: [{ id: 'x' }] }, 1)).toBeNull()
    expect(savedItemsFrom(null, 1)).toBeNull()
  })
})
