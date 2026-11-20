import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  IMPORT_DRAG_TYPE, endImportDrag, isImportDrag, onImportDragEnd, resetImportDragForTest, resolveImportDrop, startImportDrag,
  type ImportDragItem,
} from '@/lib/estimate/import-drag'

/**
 * 取り込み明細のドラッグ（lib/estimate/import-drag.ts）。1 画面・別ウィンドウ共通。
 * ドラッグのデータは一時トークンだけ。ドロップ時に、トークン・案件・取り込み候補の状態を確かめてから登録の値を渡す。
 * すべて架空の明細。
 */

const ITEM: ImportDragItem = { _importId: 'row-1', name: '架空 洗面化粧台', quantity: 2, unit: '台', cost_price: 60000, vendor_name: '架空設備', memo: '' }
const dt = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' })
const start = (over: Partial<Parameters<typeof startImportDrag>[0]> = {}) =>
  startImportDrag({ projectId: 'p1', item: ITEM, check: () => null, ...over })

beforeEach(() => resetImportDragForTest())

describe('ドラッグのデータ', () => {
  it('トークンには品名・金額を含めない', () => {
    const token = start()
    expect(token).not.toContain('洗面')
    expect(token).not.toContain('60000')
    expect(token.length).toBeGreaterThanOrEqual(16)
  })

  it('取り込み明細のドラッグかは種類だけで判断する（dragover 中は値を読めない）', () => {
    expect(isImportDrag({ types: [IMPORT_DRAG_TYPE] })).toBe(true)
    expect(isImportDrag({ types: ['text/plain', 'Files'] })).toBe(false)
    expect(isImportDrag(null)).toBe(false)
  })
})

describe('ドロップの確認', () => {
  it('今のドラッグのトークン・同じ案件・候補が有効なら、登録する値を返す', () => {
    const token = start()
    const r = resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1')
    expect(r).toEqual({ ok: true, item: ITEM })
  })

  it('同じトークンで二度は登録しない（同じ明細の二重ドロップ）', () => {
    const token = start()
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1').ok).toBe(true)
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1').ok).toBe(false)
  })

  it('別のタブ・別の画面からのドラッグ（この画面に無いトークン）は受け付けない', () => {
    const r = resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: 'token-from-another-tab' }), 'p1')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('別のタブ')
      expect(r.importId).toBeUndefined()
    }
  })

  it('古い形式（品名・金額の JSON）を入れたドラッグは受け付けない', () => {
    start()
    const r = resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: JSON.stringify({ ...ITEM, cost_price: 1 }) }), 'p1')
    expect(r.ok).toBe(false)
  })

  it('トークンが空・別のドラッグに置き換わったときは受け付けない', () => {
    const old = start()
    start()
    expect(resolveImportDrop(dt({}), 'p1').ok).toBe(false)
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: old }), 'p1').ok).toBe(false)
  })

  it('別の案件の見積エディタへのドロップは受け付けず、取り込みパネルに理由を返す', () => {
    const token = start({ projectId: 'p1' })
    const r = resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p2')
    expect(r).toMatchObject({ ok: false, importId: 'row-1' })
    if (!r.ok) expect(r.reason).toContain('別の案件')
  })

  it('取り込み候補が追加中・要確認・無くなった場合は、その理由で断る', () => {
    const token = start({ check: () => 'この明細は追加中です' })
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1')).toEqual({ ok: false, reason: 'この明細は追加中です', importId: 'row-1' })
  })

  it('ドロップ時に確認する（ドラッグ開始時は有効でも、ドロップまでに無効になれば断る）', () => {
    let valid = true
    const token = start({ check: () => (valid ? null : '原本と照らして確認してから追加してください') })
    valid = false
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1').ok).toBe(false)
  })

  it('期限（5 分）を過ぎたトークンは受け付けない', () => {
    const token = start({ now: 1_000 })
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1', 1_000 + 5 * 60 * 1000 + 1).ok).toBe(false)
  })

  it('ドラッグ開始後に取り込み候補の値が変わっても、渡す値はドラッグ開始時のもの（呼び出し側で書き換えられない）', () => {
    const item = { ...ITEM }
    const token = startImportDrag({ projectId: 'p1', item, check: () => null })
    item.cost_price = 1
    const r = resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1')
    expect(r.ok && r.item.cost_price).toBe(60000)
  })
})

describe('ドラッグの終了', () => {
  it('終了を知らせる（別ウィンドウで始めたドラッグでも、見積エディタの自動スクロール・挿入線を止める）', () => {
    const listener = vi.fn()
    const off = onImportDragEnd(listener)
    const token = start()
    endImportDrag('another-token')
    expect(listener).not.toHaveBeenCalled()
    endImportDrag(token)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1').ok).toBe(false)
    off()
    start(); endImportDrag()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ドロップを受け付けたときも終了を知らせる', () => {
    const listener = vi.fn()
    onImportDragEnd(listener)
    const token = start()
    resolveImportDrop(dt({ [IMPORT_DRAG_TYPE]: token }), 'p1')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
