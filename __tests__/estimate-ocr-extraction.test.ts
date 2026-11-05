import { describe, it, expect } from 'vitest'
import {
  MAX_ITEMS_PER_FILE, needsReview, normalizeEstimateExtraction, reviewEstimateItem, toRate,
  type EstimateOcrItem,
} from '@/lib/estimate/ocr-extraction'

/**
 * 見積書 OCR の正規化と照合（lib/estimate/ocr-extraction.ts）。すべて架空の業者見積書。
 * 単価（cost_price）は原本の単価欄の値だけを使い、AI に計算させない。取り違えは決定的な照合で「要確認」にする。
 */

const base: Pick<EstimateOcrItem, 'quantity' | 'cost_price' | 'cost_from' | 'list_price' | 'rate' | 'amount'> = {
  quantity: 2, cost_price: 6000, cost_from: 'printed_unit_price', list_price: 10000, rate: 0.6, amount: 12000,
}
const warns = (m: ReturnType<typeof reviewEstimateItem>) => m.filter(x => x.level === 'warn').map(x => x.text)

describe('明細 1 行の照合', () => {
  it('定価 × 掛率 = 単価、数量 × 単価 = 金額 なら確認事項なし', () => {
    expect(reviewEstimateItem(base)).toEqual([])
  })

  it('定価を単価として読んだ（単価 = 定価・掛率あり）→ 要確認', () => {
    const m = reviewEstimateItem({ ...base, cost_price: 10000, amount: 12000 })
    expect(needsReview(m)).toBe(true)
    expect(warns(m).join()).toContain('定価')
  })

  it('定価 × 掛率 が単価と合わない → 要確認', () => {
    const m = reviewEstimateItem({ ...base, cost_price: 5000, amount: 10000 })
    expect(warns(m).join()).toContain('掛率')
  })

  it('金額欄を単価として読んだ（数量 > 1 で単価 = 金額）→ 要確認', () => {
    const m = reviewEstimateItem({ ...base, list_price: null, rate: null, cost_price: 12000 })
    expect(warns(m).join()).toContain('金額欄を単価として読んだ')
  })

  it('数量 × 単価 が金額と合わない → 要確認（1 円の端数は許す）', () => {
    expect(needsReview(reviewEstimateItem({ ...base, list_price: null, rate: null, quantity: 3 }))).toBe(true)
    expect(reviewEstimateItem({ quantity: 3, cost_price: 333.33, cost_from: 'printed_unit_price', list_price: null, rate: null, amount: 1000 })).toEqual([])
  })

  it('単価が読めない・0 円・数量が読めない は要確認', () => {
    expect(warns(reviewEstimateItem({ ...base, cost_price: null })).join()).toContain('単価')
    expect(warns(reviewEstimateItem({ ...base, cost_price: 0, list_price: null, rate: null, amount: 0 })).join()).toContain('0 円')
    expect(warns(reviewEstimateItem({ ...base, quantity: null })).join()).toContain('数量')
  })

  it('掛率なしで単価が定価より高い → 要確認', () => {
    expect(needsReview(reviewEstimateItem({ quantity: 1, cost_price: 12000, cost_from: 'printed_unit_price', list_price: 10000, rate: null, amount: 12000 }))).toBe(true)
  })
})

describe('AI の出力の正規化', () => {
  it('単価欄が空なら、金額 ÷ 数量 で単価を作らない（数量 2・金額 20,000 → 単価 null・要確認）', () => {
    const f = normalizeEstimateExtraction({ items: [{ name: 'クロス張替', quantity: 2, unit: '㎡', cost_price: null, amount: 20000 }] }, 'a.jpg')
    expect(f.items[0].cost_price).toBeNull()
    expect(needsReview(reviewEstimateItem(f.items[0]))).toBe(true)
  })

  it('数量 1 の行で単価欄が空なら、印字された金額をそのまま単価にする（計算ではない）', () => {
    const f = normalizeEstimateExtraction({ items: [{ name: '養生', quantity: 1, unit: '式', cost_price: null, amount: 30000 }] }, 'a.jpg')
    expect(f.items[0]).toMatchObject({ cost_price: 30000, cost_from: 'amount_with_qty1' })
    expect(needsReview(reviewEstimateItem(f.items[0]))).toBe(false)
  })

  it('文字列の数値・カンマ・円記号を数値に、負数・文字・桁外れは null に', () => {
    const f = normalizeEstimateExtraction({
      items: [
        { name: 'A', quantity: '3', cost_price: '¥12,000', amount: '36,000円' },
        { name: 'B', quantity: -1, cost_price: 'abc', amount: 1e15 },
      ],
    }, 'a.jpg')
    expect(f.items[0]).toMatchObject({ quantity: 3, cost_price: 12000, amount: 36000 })
    expect(f.items[1]).toMatchObject({ quantity: null, cost_price: null, amount: null })
  })

  it('掛率は 60 / "60%" / 0.6 のどれでも 0.6 に揃える', () => {
    expect(toRate(60)).toBe(0.6)
    expect(toRate('60%')).toBe(0.6)
    expect(toRate(0.6)).toBe(0.6)
    expect(toRate(250)).toBeNull()
  })

  it('品名のない行は捨てる。items が配列でなければ 0 行', () => {
    expect(normalizeEstimateExtraction({ items: [{ name: '' }, { name: '  ' }, null] }, 'a').items).toHaveLength(0)
    expect(normalizeEstimateExtraction({ items: 'x' }, 'a').items).toHaveLength(0)
    expect(normalizeEstimateExtraction(null, 'a').items).toHaveLength(0)
  })

  it('行の業者名が無ければ書類全体の業者名を使う', () => {
    const f = normalizeEstimateExtraction({ supplier: '架空建材', items: [{ name: 'A', vendor_name: null }, { name: 'B', vendor_name: '別業者' }] }, 'a')
    expect(f.items.map(i => i.vendor_name)).toEqual(['架空建材', '別業者'])
  })

  it('売価（selling_price）は AI が返しても取り込まない', () => {
    const f = normalizeEstimateExtraction({ items: [{ name: 'A', quantity: 1, cost_price: 1000, selling_price: 99999 }] }, 'a')
    expect(f.items[0]).not.toHaveProperty('selling_price')
  })
})

describe('画像全体の照合', () => {
  it('値引きの行は明細に入れず、原価に反映していないと警告する', () => {
    const f = normalizeEstimateExtraction({
      items: [{ name: 'A', quantity: 1, cost_price: 100000, amount: 100000 }],
      subtotal: 100000, adjustments: [{ label: '出精値引', amount: 5000 }],
    }, 'a')
    expect(f.adjustments).toEqual([{ label: '出精値引', amount: 5000 }])
    expect(f.messages.map(m => m.text).join()).toContain('出精値引')
    expect(f.items).toHaveLength(1)
  })

  it('明細の金額合計が小計と合わなければ警告（読み落とし）', () => {
    const f = normalizeEstimateExtraction({
      items: [{ name: 'A', quantity: 1, cost_price: 1000, amount: 1000 }, { name: 'B', quantity: 1, cost_price: 2000, amount: 2000 }],
      subtotal: 5000,
    }, 'a')
    expect(f.messages.some(m => m.level === 'warn' && m.text.includes('小計'))).toBe(true)
  })

  it('合計が小計と一致すれば警告なし', () => {
    const f = normalizeEstimateExtraction({
      items: [{ name: 'A', quantity: 1, cost_price: 1000, amount: 1000 }, { name: 'B', quantity: 2, cost_price: 1000, amount: 2000 }],
      subtotal: 3000, adjustments: [], warnings: [],
    }, 'a')
    expect(f.messages).toEqual([])
  })

  it('原本の行数より少なく読んだ・上限を超えた・税込単価・AI の注意書きを警告する', () => {
    const few = normalizeEstimateExtraction({ items: [{ name: 'A' }], items_total: 30 }, 'a')
    expect(few.messages.map(m => m.text).join()).toContain('30 行')

    const many = normalizeEstimateExtraction({ items: Array.from({ length: MAX_ITEMS_PER_FILE + 5 }, (_, i) => ({ name: `部材${i}` })) }, 'a')
    expect(many.items).toHaveLength(MAX_ITEMS_PER_FILE)
    expect(many.messages.map(m => m.text).join()).toContain('残り 5 行')

    const tax = normalizeEstimateExtraction({ items: [], prices_include_tax: true, warnings: ['右端が切れている'], raw_warning: '旧形式' }, 'a')
    const t = tax.messages.map(m => m.text).join()
    expect(t).toContain('税込')
    expect(t).toContain('右端が切れている')
    expect(t).toContain('旧形式')
  })
})

describe('照合できない見積書・明細に入れなかった行（実 AI 検証で見つけた点）', () => {
  it('金額・定価の列がない見積書は、単価を照合できないことを必ず警告する（AI の注意書きに頼らない）', () => {
    const f = normalizeEstimateExtraction({ items: [{ name: 'A', quantity: 18, cost_price: 4850 }, { name: 'B', quantity: 1, cost_price: 25000 }] }, 'a')
    expect(f.messages).toContainEqual(expect.objectContaining({ level: 'warn', text: expect.stringContaining('照合で見つけられません') }))
  })

  it('金額の列があれば、その警告は出さない', () => {
    const f = normalizeEstimateExtraction({ items: [{ name: 'A', quantity: 2, cost_price: 100, amount: 200 }] }, 'a')
    expect(f.messages.some(m => m.text.includes('照合で見つけられません'))).toBe(false)
  })

  it('「別途」の行は明細に入れず、原価に含まれていないと警告する。「含む」「0円」は案内だけ', () => {
    const f = normalizeEstimateExtraction({
      items: [{ name: 'A', quantity: 1, cost_price: 100, amount: 100 }],
      excluded_rows: [{ name: '電気工事', reason: '別途' }, { name: '運搬費', reason: '含む' }, { name: '管理費', reason: '0 円' }, { name: 'x', reason: '不明' }, { name: '', reason: '別途' }],
    }, 'a')
    expect(f.items).toHaveLength(1)
    expect(f.excluded).toEqual([
      { name: '電気工事', reason: '別途' }, { name: '運搬費', reason: '含む' }, { name: '管理費', reason: '0円' }, { name: 'x', reason: 'その他' },
    ])
    expect(f.messages.filter(m => m.level === 'warn').map(m => m.text)).toEqual([expect.stringContaining('電気工事')])
    expect(f.messages.filter(m => m.level === 'info')).toHaveLength(3)
  })
})

describe('読み落としの警告は、明細に入れなかった行を数に含める（実 AI 検証の誤警告）', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ name: `A${i}`, quantity: 1, cost_price: 100, amount: 100 }))
  const excluded_rows = [{ name: '運搬費', reason: '含む' }, { name: '管理費', reason: '0円' }, { name: '電気', reason: '別途' }]

  it('原本 9 行 = 明細 6 行 + 除外 3 行 なら読み落としの警告を出さない', () => {
    const f = normalizeEstimateExtraction({ items, excluded_rows, items_total: 9 }, 'a')
    expect(f.messages.some(m => m.text.includes('しか読み取れませんでした'))).toBe(false)
  })

  it('原本 10 行なら 1 行の読み落としとして警告する', () => {
    const f = normalizeEstimateExtraction({ items, excluded_rows, items_total: 10 }, 'a')
    expect(f.messages.some(m => m.level === 'warn' && m.text.includes('しか読み取れませんでした'))).toBe(true)
  })
})
