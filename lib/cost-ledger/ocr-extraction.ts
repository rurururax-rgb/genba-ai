/**
 * 業者請求書 OCR（app/api/ai/extract-vendor-invoice）の応答の形と正規化。
 * 画面（VendorInvoiceImportTab）と QA Fixture も同じ型を使う。
 */

import { reviewInvoiceAmounts, toAmount, toPrintedAmounts } from './ocr-amounts'

/** 画面に返す明細の行数（AI にも最初の 20 行だけを書かせる。登録金額には使わない参考表示） */
export const MAX_ITEMS = 20

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const dateOrNull = (v: unknown) => {
  const t = str(v, 10)
  return DATE_RE.test(t) && !Number.isNaN(Date.parse(t)) ? t : null
}

/**
 * AI の出力を、画面に返す形に揃える（形・型は信用しない）。
 * 金額の照合と登録金額（税抜）の候補はサーバーの決定的な処理で作る（AI には判断させない）。
 */
export function normalizeExtraction(raw: unknown) {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const amounts = toPrintedAmounts(r)
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).map(i => {
    const it = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>
    return { name: str(it.name, 200), amount: toAmount(it.amount) }
  }).filter(i => i.name || i.amount != null)
  const itemsTotal = typeof r.items_total === 'number' && Number.isInteger(r.items_total) && r.items_total <= 10000 ? r.items_total : null
  return {
    vendor_name:      str(r.vendor_name, 200),
    invoice_number:   str(r.invoice_number, 100) || null,
    invoice_date:     dateOrNull(r.invoice_date),
    payment_due_date: dateOrNull(r.payment_due_date),
    amounts,
    review: reviewInvoiceAmounts(amounts),
    items,
    // 原本の明細行の数。AI には最初の 20 行だけを書かせるので、画面で「ほかに N 行」と示す
    items_total: itemsTotal != null && itemsTotal >= items.length ? itemsTotal : items.length,
    warnings: (Array.isArray(r.warnings) ? r.warnings : []).map(w => str(w, 300)).filter(Boolean).slice(0, 10),
  }
}

export type ExtractedVendorInvoice = ReturnType<typeof normalizeExtraction> & { document_sha256: string }
