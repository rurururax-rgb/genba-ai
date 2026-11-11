import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import JSZip from 'jszip'
import { toCustomerEstimateItems } from '@/lib/estimate/customer-output'
import { calculateEstimateTotals, liveAmount } from '@/lib/estimate/totals'
import { EstimateDocument } from '@/components/estimate/EstimateDocument'
import { buildEstimateExcelInput } from '@/lib/excel/estimate-excel-input'
import { fillTemplateV2 } from '@/lib/excel/fill-template-v2'

// ラグズ建築専用 Excel（内訳明細書）のフッターを、お客様向け見積書と同じ計算にする。
//   H52 諸経費（手動の上書きを優先）・H53 端数値引（マイナス）・H54 合計（税抜）・H55 消費税（切り捨て）・H57 総合計（税込）
// 経路はルート（/api/projects/[id]/estimate/excel）と同じ: DB 行 → toCustomerEstimateItems → buildEstimateExcelInput → fillTemplateV2

const RUGS = { name: 'ラグズ建築', display_name: null, tax_rate: 0.1, template_id: 'rugs' }
const GROUPS = [
  { id: 'g1', label: '内装', display_mode: 'detailed', sort_order: 0 },
  { id: 'g2', label: '設備', display_mode: 'detailed', sort_order: 1 },
]

function dbRow(id: string, groupId: string | null, quantity: number, sellingPrice: number | null, sort = 0, name = `明細${id}`) {
  return {
    id, name, category: null, quantity, unit: '式', selling_price: sellingPrice, retail_price: null,
    amount: sellingPrice == null ? null : quantity * sellingPrice, group_id: groupId, sort_order: sort, memo: null, row_type: 'item',
  }
}

// 小数の数量・0.5 円・値引き行・工種なしの行を含む（行ごとの四捨五入で合計が変わる）
const ROWS = [
  dbRow('a', 'g1', 12.5, 2755, 0),          // 34,437.5 → 34,438
  dbRow('b', 'g1', 3, 333.5, 1),            // 1,000.5 → 1,001
  dbRow('c', 'g1', 1, 0.5, 2),              // 0.5 → 1
  dbRow('d', 'g2', 2.5, 13333, 0),          // 33,332.5 → 33,333
  dbRow('e', 'g2', 1, 286752, 1),
  dbRow('f', 'g2', 1, -10000.5, 2, '出精値引'), // -10,000.5 → -10,001
  dbRow('g', null, 1, 55100, 0),
]

async function sheetXml(project: { misc_expense_override?: number | null; rounding_discount?: number | null }) {
  const input = buildEstimateExcelInput(GROUPS, toCustomerEstimateItems(ROWS), 0.1, project)
  const { buffer } = await fillTemplateV2(input)
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('xl/worksheets/sheet1.xml')!.async('string')
}

/** セルの値（数式が残っていれば formula に入る）。空のセルは value = null */
function cell(xml: string, ref: string): { value: number | null; formula: string | null } {
  const m = xml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`, 's'))
  if (!m) throw new Error(`cell ${ref} not found`)
  const inner = m[1] ?? ''
  const v = inner.match(/<v>([^<]*)<\/v>/)
  const f = inner.match(/<f[^>]*>([^<]*)<\/f>|<f[^>]*\/>/)
  return { value: v ? Number(v[1]) : null, formula: f ? (f[1] ?? 'shared') : null }
}

function documentTotal(project: { misc_expense_override?: number | null; rounding_discount?: number | null }): string {
  const html = renderToStaticMarkup(
    <EstimateDocument projectId="p1" company={RUGS} groups={GROUPS} items={toCustomerEstimateItems(ROWS)}
      project={{ id: 'p1', name: '架空の改修工事', customer_name: '架空 太郎', site_address: null, ...project }} />,
  )
  const m = html.replace(/<[^>]+>/g, ' ').match(/¥([\d,]+)/)
  return m![1]
}

const CASES: Array<[string, { misc_expense_override?: number | null; rounding_discount?: number | null }]> = [
  ['諸経費は自動（小計 × 8%）・端数値引なし', {}],
  ['諸経費の手動上書き 50,000', { misc_expense_override: 50000 }],
  ['端数値引 6,789', { rounding_discount: 6789 }],
  ['諸経費 0 円の上書き・端数値引あり', { misc_expense_override: 0, rounding_discount: 1234 }],
]

describe('Excel のフッター = お客様向け見積書の合計', () => {
  it.each(CASES)('%s', async (_label, project) => {
    const expected = calculateEstimateTotals(ROWS, {
      miscExpenseOverride: project.misc_expense_override ?? null,
      roundingDiscount:    project.rounding_discount ?? 0,
      taxRate:             0.1,
    })
    const xml = await sheetXml(project)

    expect(cell(xml, 'H52')).toEqual({ value: expected.overhead, formula: null })
    expect(cell(xml, 'H53').value).toBe(expected.roundingDiscount === 0 ? null : -expected.roundingDiscount)
    expect(cell(xml, 'H54')).toEqual({ value: expected.preTaxTotal, formula: null })
    expect(cell(xml, 'H55')).toEqual({ value: expected.tax, formula: null })
    expect(cell(xml, 'H57')).toEqual({ value: expected.totalIncludingTax, formula: null })

    // 見積書の表紙の税込合計と同じ
    expect(documentTotal(project)).toBe(expected.totalIncludingTax.toLocaleString('ja-JP'))
    // 合計（税抜）= 明細の小計 + 諸経費 − 端数値引、税込 = 税抜 + 消費税
    expect(expected.preTaxTotal).toBe(expected.itemSubtotal + expected.overhead - expected.roundingDiscount)
    expect(expected.totalIncludingTax).toBe(expected.preTaxTotal + expected.tax)
  })

  it('消費税は切り捨て（四捨五入なら 1 円違うケース）', async () => {
    const project = { rounding_discount: 0, misc_expense_override: 5 }   // 税抜の 1 の位が 5 以上になるように調整
    const t = calculateEstimateTotals(ROWS, { miscExpenseOverride: 5, roundingDiscount: 0, taxRate: 0.1 })
    const raw = t.preTaxTotal * 0.1
    expect(Math.round(raw)).not.toBe(Math.floor(raw))
    const xml = await sheetXml(project)
    expect(cell(xml, 'H54').value).toBe(t.preTaxTotal)
    expect(cell(xml, 'H55').value).toBe(Math.floor(raw))
    expect(cell(xml, 'H57').value).toBe(t.preTaxTotal + Math.floor(raw))
    expect(documentTotal(project)).toBe(t.totalIncludingTax.toLocaleString('ja-JP'))
  })

  it('工種の集計（H37・H38）は行ごとに四捨五入した金額の和', async () => {
    const xml = await sheetXml({})
    const sum = (g: string) => ROWS.filter(r => r.group_id === g).reduce((s, r) => s + liveAmount(r), 0)
    expect(cell(xml, 'H37').value).toBe(sum('g1'))
    expect(cell(xml, 'H38').value).toBe(sum('g2'))
  })

  it('レイアウトを壊さない: K 列以降の社内計算の数式・ラベルはそのまま、H56 は空欄のまま', async () => {
    const xml = await sheetXml({ rounding_discount: 6789 })
    expect(cell(xml, 'K44').formula).toBe('SUM(H37:H49)')
    expect(cell(xml, 'O44').formula).toBe('H54-S55')
    expect(cell(xml, 'H56').value).toBeNull()
    expect(xml).toMatch(/<c r="H53" s="743"/)   // 書式（罫線・表示形式）を保つ
    expect(xml).toMatch(/<c r="H57" s="752"/)
  })
})
