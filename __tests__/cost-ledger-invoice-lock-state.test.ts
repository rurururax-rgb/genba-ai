import { describe, it, expect } from 'vitest'
import { actualCostLockState, staleInvoiceCaches } from '@/lib/cost-ledger/invoice-lock-state'

/**
 * 原価台帳の画面で実績原価（actual_cost）を直接編集させてよいかの判定（P1-3 / PR #32 レビュー指摘 2）。
 * 一覧 API（DB）の invoice_count を優先し、件数不明・キャッシュとの食い違いでは編集させない。
 */

const inv = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `inv-${i}` }))

describe('actualCostLockState', () => {
  it('一覧の件数が 0 で内訳キャッシュも無い・空なら直接編集できる', () => {
    expect(actualCostLockState(0, undefined)).toEqual({ locked: false, count: 0 })
    expect(actualCostLockState(0, [])).toEqual({ locked: false, count: 0 })
  })

  it('一覧の件数が 1件以上なら編集させない（内訳を開いていない行でも）', () => {
    expect(actualCostLockState(2, undefined)).toEqual({ locked: true, count: 2 })
  })

  it('以前開いた内訳（0件）が残っていても、一覧（DB）の新しい件数を表示に使う', () => {
    // 内訳を開いた後に別画面で請求書が登録され、一覧だけ読み直された状態
    expect(actualCostLockState(1, [])).toEqual({ locked: true, count: 1 })
  })

  it('一覧が 0件でもキャッシュに請求書が残っている（食い違い）なら編集させない', () => {
    expect(actualCostLockState(0, inv(1))).toEqual({ locked: true, count: 0 })
  })

  it('件数が不明（未設定・null・不正な値）なら編集させない', () => {
    for (const c of [undefined, null, -1, 1.5, Number.NaN]) {
      expect(actualCostLockState(c as number | null | undefined, undefined).locked).toBe(true)
      expect(actualCostLockState(c as number | null | undefined, undefined).count).toBeNull()
    }
  })
})

describe('staleInvoiceCaches（一覧の再読み込み後に読み直す内訳）', () => {
  const items = [
    { id: 'a', invoice_count: 0 },
    { id: 'b', invoice_count: 2 },
    { id: 'c', invoice_count: null },
  ]

  it('件数が一致するキャッシュは残す', () => {
    expect(staleInvoiceCaches(items, { a: [], b: inv(2) })).toEqual([])
  })

  it('件数が食い違う・件数不明・一覧から消えた項目のキャッシュは読み直し対象', () => {
    expect(staleInvoiceCaches(items, { a: inv(1), b: inv(1), c: [], gone: [] }).sort()).toEqual(['a', 'b', 'c', 'gone'])
  })
})
