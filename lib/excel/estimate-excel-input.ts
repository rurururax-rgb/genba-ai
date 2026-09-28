import type { CustomerEstimateItem } from '@/lib/estimate/customer-output'
import type { FillGroupV2, FillInputV2 } from '@/lib/excel/fill-template-v2'

/**
 * お客様向け Excel（内訳明細書）の入力を組み立てる。
 * 明細は CustomerEstimateItem（toCustomerEstimateItems() 済み）のみを受け取るため、
 * 社内メモ（internal_memo）・原価・業者名はここに到達しない。
 */
export function buildEstimateExcelInput(
  groups:  ReadonlyArray<{ id: string; label: string | null; display_mode: string | null; sort_order: number }>,
  items:   ReadonlyArray<CustomerEstimateItem>,
  taxRate: number,
): FillInputV2 {
  const toFill = (i: CustomerEstimateItem) => ({
    name:          i.name ?? '',
    quantity:      i.quantity,
    unit:          i.unit ?? '',
    selling_price: i.selling_price,
    amount:        i.amount,
    memo:          i.memo ?? null,
  })

  const fillGroups: FillGroupV2[] = groups.map(g => ({
    label:        g.label || '（グループ名未設定）',
    display_mode: g.display_mode as 'detailed' | 'lump_sum',
    sort_order:   g.sort_order,
    items:        items
      .filter(i => i.group_id === g.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(toFill),
  }))

  const ungrouped = items
    .filter(i => !i.group_id)
    .map(i => ({ ...toFill(i), sort_order: i.sort_order }))

  return { groups: fillGroups, ungrouped, tax_rate: taxRate }
}
