import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import JSZip from 'jszip'
import { calculateEstimateTotals, liveAmount, roundYen } from '@/lib/estimate/totals'
import { toCustomerEstimateItems } from '@/lib/estimate/customer-output'
import { EstimateDocument } from '@/components/estimate/EstimateDocument'
import { buildEstimateExcelInput } from '@/lib/excel/estimate-excel-input'
import { fillTemplateV2 } from '@/lib/excel/fill-template-v2'

// 見積金額の端数処理: 明細 1 行ごとに 数量×売価 を四捨五入し、その金額を足して合計を作る。
// 見積エディタ（calculateEstimateTotals）・見積書（EstimateDocument）・Excel が同じ金額になること。
// DB の amount（GENERATED: quantity × selling_price）は円未満を含むため、行の金額・合計に直接使わない。

const yen = (v: number) => v.toLocaleString('ja-JP')

/** DB の estimate_items 行（amount は DB と同じく 数量×売価 の丸めない値） */
function dbRow(id: string, quantity: number, sellingPrice: number | null, extra: Record<string, unknown> = {}) {
  return {
    id, name: `明細${id}`, category: null, quantity, unit: '式', selling_price: sellingPrice, retail_price: null,
    amount: sellingPrice == null ? null : quantity * sellingPrice, group_id: 'g1', sort_order: 0, memo: null, row_type: 'item',
    ...extra,
  }
}

describe('roundYen: 円未満の四捨五入', () => {
  it.each([
    [0.5, 1], [1.5, 2], [2.5, 3], [0.49, 0], [34437.5, 34438],
    [-0.5, -1], [-1.5, -2], [-1000.5, -1001], [-0.4, 0],
    [4.35 * 100, 435],                 // 434.99999999999994 → 435（浮動小数の誤差を吸収）
    [1.005 * 1000, 1005],
  ])('%s → %s', (input, expected) => {
    expect(roundYen(input)).toBe(expected)
  })

  it('-0 を返さない・NaN / Infinity は 0', () => {
    expect(Object.is(roundYen(-0.4), 0)).toBe(true)
    expect(roundYen(Number.NaN)).toBe(0)
    expect(roundYen(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('liveAmount: 明細 1 行の金額', () => {
  it('小数の数量: 12.5 × 2,755 = 34,437.5 → 34,438', () => {
    expect(liveAmount({ quantity: 12.5, selling_price: 2755, amount: 34437.5 })).toBe(34438)
  })

  it('小数の単価: 3 × 333.5 = 1,000.5 → 1,001（単価そのものは丸めない）', () => {
    expect(liveAmount({ quantity: 3, selling_price: 333.5, amount: 1000.5 })).toBe(1001)
  })

  it('値引き（マイナス）: 1 × -10,000.5 → -10,001（0 から遠い方へ）', () => {
    expect(liveAmount({ quantity: 1, selling_price: -10000.5, amount: -10000.5 })).toBe(-10001)
  })

  it('売価がなく amount だけある行も四捨五入する', () => {
    expect(liveAmount({ quantity: 1, selling_price: null, amount: 1250.5 })).toBe(1251)
    expect(liveAmount({ quantity: 1, selling_price: null, amount: null })).toBe(0)
  })
})

describe('合計は行ごとに丸めた金額を足す（最終合計だけを丸めない）', () => {
  it('0.5 円の行が 3 つ: 各 1 円 → 小計 3 円（合計してから丸めると 2 円になる）', () => {
    const items = [0, 1, 2].map(() => ({ quantity: 1, selling_price: 0.5, amount: 0.5 }))
    const totals = calculateEstimateTotals(items, { miscExpenseOverride: null, roundingDiscount: 0 })
    expect(totals.itemSubtotal).toBe(3)
    expect(Math.round(items.reduce((s, i) => s + i.quantity * i.selling_price, 0))).toBe(2)
  })

  it('小数の数量・値引きを含む複数行: 小計 = 各行の四捨五入の和。消費税は従来どおり切り捨て', () => {
    const items = [
      { quantity: 12.5, selling_price: 2755, amount: 34437.5 },  // 34,438
      { quantity: 3,    selling_price: 333.5, amount: 1000.5 },  // 1,001
      { quantity: 2.5,  selling_price: 1333, amount: 3332.5 },   // 3,333
      { quantity: 1,    selling_price: -5000.5, amount: -5000.5 }, // -5,001
    ]
    const totals = calculateEstimateTotals(items, { miscExpenseOverride: null, roundingDiscount: 0 })
    expect(totals.itemSubtotal).toBe(34438 + 1001 + 3333 - 5001)
    expect(totals.overhead).toBe(Math.round(totals.itemSubtotal * 0.08))
    expect(totals.tax).toBe(Math.floor(totals.preTaxTotal * 0.1))
    expect(Number.isInteger(totals.totalIncludingTax)).toBe(true)
  })
})

describe('お客様向け明細（toCustomerEstimateItems）', () => {
  it('amount は行ごとに四捨五入した金額。数量・単価は小数のまま', () => {
    const [item] = toCustomerEstimateItems([dbRow('a', 12.5, 2755.5)])
    expect(item.quantity).toBe(12.5)
    expect(item.selling_price).toBe(2755.5)
    expect(item.amount).toBe(roundYen(12.5 * 2755.5)) // 34,443.75 → 34,444
  })

  it('見出し・空行（売価も amount もない）は amount = null のまま', () => {
    const [item] = toCustomerEstimateItems([dbRow('h', 1, null, { name: '【見出し】' })])
    expect(item.amount).toBeNull()
  })
})

describe('見積書（全ページ）と見積エディタの合計が一致する', () => {
  // 2 工種・45 行（工種 1 は 1 ページ 19 行を超えて 3 ページ）。小数の数量・0.5 円・値引きを含む
  const g1 = Array.from({ length: 40 }, (_, i) => dbRow(`x${i}`, i % 2 === 0 ? 12.5 : 0.5, i % 3 === 0 ? 2755 : 1001, { sort_order: i }))
  const g2 = [
    dbRow('y1', 2.5, 13333, { group_id: 'g2' }),   // 33,332.5 → 33,333
    dbRow('y2', 1, 0.5, { group_id: 'g2' }),
    dbRow('y3', 1, 0.5, { group_id: 'g2' }),
    dbRow('y4', 1, -10000.5, { group_id: 'g2', name: '出精値引' }),
    dbRow('y5', 1, null, { group_id: 'g2', name: '【備考】' }),
  ]
  const rows = [...g1, ...g2]
  const groups = [{ id: 'g1', label: '内装', sort_order: 0 }, { id: 'g2', label: '設備', sort_order: 1 }]
  const project = { id: 'p1', name: '端数確認（架空）', customer_name: '架空 太郎', site_address: null }
  const company = { name: '架空工務店', display_name: null, tax_rate: 0.1, template_id: 'modern' }
  const editorTotals = calculateEstimateTotals(rows, { miscExpenseOverride: null, roundingDiscount: 0 })

  const html = renderToStaticMarkup(
    <EstimateDocument projectId="p1" project={project} company={company} groups={groups} items={toCustomerEstimateItems(rows)} />,
  )
  const text = html.replace(/<[^>]+>/g, ' ')

  it('表紙の税込合計 = 見積エディタの税込合計（円未満なし）', () => {
    expect(Number.isInteger(editorTotals.totalIncludingTax)).toBe(true)
    expect(text).toContain(`¥${yen(editorTotals.totalIncludingTax)}`)
  })

  it('見積書のどこにも円未満の金額が出ない（単価はすべて整数のケース）', () => {
    expect(text).not.toMatch(/\d,\d{3}\.\d/)   // 34,437.5 のような桁区切りの金額
    expect(text).not.toMatch(/¥[\d,]+\.\d/)
  })

  it('工種の小計 = その工種の行の金額（四捨五入済み）の和。小計の合計 = エディタの小計', () => {
    const sum = (rs: typeof rows) => rs.reduce((s, r) => s + liveAmount(r), 0)
    expect(text).toContain(yen(sum(g1)))
    expect(sum(g2)).toBeGreaterThan(0)
    expect(text).toContain(yen(sum(g2)))
    expect(sum(g1) + sum(g2)).toBe(editorTotals.itemSubtotal)
    expect(text).toContain(yen(editorTotals.itemSubtotal))
  })

  it('値引き行は四捨五入した金額をマイナスで表示する', () => {
    expect(text).toContain('-10,001')
  })

  it('小数の単価は丸めずに表示し、金額は四捨五入する', () => {
    const one = renderToStaticMarkup(
      <EstimateDocument projectId="p1" project={project} company={company} groups={groups}
        items={toCustomerEstimateItems([dbRow('d', 12.5, 2755.5)])} />,
    ).replace(/<[^>]+>/g, ' ')
    expect(one).toContain('2,755.5')
    expect(one).toContain('34,444')
    expect(one).not.toContain('34,443.75')
  })
})

describe('Excel 出力の明細・工種の金額も同じ', () => {
  it('明細の金額セルは四捨五入した値、単価セルは小数のまま', async () => {
    const items = toCustomerEstimateItems([dbRow('a', 12.5, 2755), dbRow('b', 3, 333.5, { sort_order: 1 })])
    const input = buildEstimateExcelInput([{ id: 'g1', label: '内装', display_mode: 'detailed', sort_order: 0 }], items, 0.1)
    const { buffer } = await fillTemplateV2(input)
    const zip = await JSZip.loadAsync(buffer)
    const xml = (await Promise.all(Object.values(zip.files).filter(f => f.name.endsWith('.xml')).map(f => f.async('string')))).join('\n')
    expect(xml).toContain('>34438<')
    expect(xml).toContain('>1001<')
    expect(xml).toContain(`>${34438 + 1001}<`)   // 工種の小計
    expect(xml).not.toContain('34437.5')
    expect(xml).not.toContain('1000.5')
    expect(xml).toContain('>333.5<')
  })
})
