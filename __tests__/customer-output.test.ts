import { describe, it, expect } from 'vitest'
import {
  CUSTOMER_ESTIMATE_ITEM_COLUMNS,
  toCustomerEstimateItem,
  toCustomerEstimateItems,
} from '@/lib/estimate/customer-output'

// お客様向け出力に絶対に含めてはいけない列
const FORBIDDEN = ['internal_memo', 'cost_price', 'vendor_name', 'markup_rate_override', 'selling_price_mode', 'line_event_id', 'company_id']

const fullRow = {
  id: 'a1', name: 'システムバス', category: '設備機器', quantity: 2, unit: '台',
  selling_price: 145000, retail_price: 200000, amount: 290000, group_id: 'g1', sort_order: 3,
  memo: '工事期間中は駐車スペースをお借りします', row_type: 'item',
  internal_memo: '見積No. ABC-123', cost_price: 100000, vendor_name: 'QA設備',
  markup_rate_override: 1.6, selling_price_mode: 'auto', line_event_id: 'le1', company_id: 'c1',
}

describe('CUSTOMER_ESTIMATE_ITEM_COLUMNS', () => {
  const cols = CUSTOMER_ESTIMATE_ITEM_COLUMNS.split(',').map(c => c.trim())

  it.each(FORBIDDEN)('社内向けの列 %s を取得しない', col => {
    expect(cols).not.toContain(col)
  })

  it('お客様向け備考（memo）は従来どおり取得する（既存見積の表示を変えない）', () => {
    expect(cols).toContain('memo')
  })
})

describe('toCustomerEstimateItem', () => {
  it('社内メモ・原価・業者名など許可していない項目を出力しない', () => {
    const out = toCustomerEstimateItem(fullRow) as Record<string, unknown>
    for (const k of FORBIDDEN) expect(out).not.toHaveProperty(k)
    expect(JSON.stringify(out)).not.toContain('ABC-123')
    expect(JSON.stringify(out)).not.toContain('QA設備')
  })

  it('お客様向けの値はそのまま渡す', () => {
    expect(toCustomerEstimateItem(fullRow)).toEqual({
      id: 'a1', name: 'システムバス', category: '設備機器', quantity: 2, unit: '台',
      selling_price: 145000, retail_price: 200000, amount: 290000, group_id: 'g1', sort_order: 3,
      memo: '工事期間中は駐車スペースをお借りします', row_type: 'item',
    })
  })

  it('社内メモだけの行はお客様向け備考が null（空欄）', () => {
    const out = toCustomerEstimateItem({ ...fullRow, memo: null })
    expect(out.memo).toBeNull()
    expect(JSON.stringify(out)).not.toContain('ABC-123')
  })

  it('不正な型は null / 既定値に丸める（NaN を出さない）', () => {
    const out = toCustomerEstimateItem({ id: 'x', quantity: NaN, selling_price: 'abc', sort_order: undefined })
    expect(out.quantity).toBe(0)
    expect(out.selling_price).toBeNull()
    expect(out.sort_order).toBe(0)
  })
})

describe('toCustomerEstimateItems', () => {
  it('null / undefined は空配列', () => {
    expect(toCustomerEstimateItems(null)).toEqual([])
    expect(toCustomerEstimateItems(undefined)).toEqual([])
  })

  it('複数行でも社内メモを含まない', () => {
    const out = toCustomerEstimateItems([fullRow, { ...fullRow, id: 'a2', internal_memo: '仕入先管理番号 9999' }])
    expect(out).toHaveLength(2)
    expect(JSON.stringify(out)).not.toMatch(/ABC-123|9999|internal_memo/)
  })
})
