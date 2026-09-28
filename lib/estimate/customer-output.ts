/**
 * お客様向け見積出力の Source of Truth
 *
 * お客様に渡る見積データ（見積書プレビュー / 印刷 / PDF / Excel 出力、将来のお客様向け画面）は
 * 必ずこのモジュールを通して作る。
 *
 * 設計:
 *   - 許可リスト方式。ここに列挙した列だけがお客様向け出力に入る
 *     （select('*') や列追加があっても、社内メモ・原価・業者名などが漏れない）
 *   - estimate_items.internal_memo（社内メモ）は絶対に含めない
 *   - memo（お客様向け備考）は既存どおり出力する（既存見積の表示を変えない）
 */

/** お客様向け出力で DB から取得してよい estimate_items の列（internal_memo / cost_price / vendor_name は含めない） */
export const CUSTOMER_ESTIMATE_ITEM_COLUMNS =
  'id, name, category, quantity, unit, selling_price, retail_price, amount, group_id, sort_order, memo, row_type' as const

/** お客様に見せてよい明細データ */
export type CustomerEstimateItem = {
  id:            string
  name:          string | null
  category:      string | null
  quantity:      number
  unit:          string | null
  selling_price: number | null
  retail_price:  number | null
  amount:        number | null
  group_id:      string | null
  sort_order:    number
  /** お客様向け備考（estimate_items.memo） */
  memo:          string | null
  row_type:      string | null
}

/**
 * DB 行（またはアプリ内の明細 state）からお客様向け明細を作る。
 * 許可した項目だけを明示的にコピーするため、入力に internal_memo 等が含まれていても出力されない。
 */
export function toCustomerEstimateItem(row: Record<string, unknown>): CustomerEstimateItem {
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    id:            String(row.id ?? ''),
    name:          str(row.name),
    category:      str(row.category),
    quantity:      num(row.quantity) ?? 0,
    unit:          str(row.unit),
    selling_price: num(row.selling_price),
    retail_price:  num(row.retail_price),
    amount:        num(row.amount),
    group_id:      str(row.group_id),
    sort_order:    num(row.sort_order) ?? 0,
    memo:          str(row.memo),
    row_type:      str(row.row_type),
  }
}

export function toCustomerEstimateItems(rows: ReadonlyArray<Record<string, unknown>> | null | undefined): CustomerEstimateItem[] {
  return (rows ?? []).map(toCustomerEstimateItem)
}
