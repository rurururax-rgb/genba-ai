/**
 * 業者請求書（cost_ledger_invoices）の登録リクエスト検証と、重複の疑いの判定。
 *
 * DB 側（migration 20261010000001）:
 *   - 同じ案件に同じ画像（document_sha256）の OCR 登録は1件まで
 *   - idempotency_key は全体で一意
 * ここでは DB に送る前の入力検証と、DB 制約では止めない「似ている請求書」の判定だけを行う。
 * 似ているかどうかは候補を示すだけで、登録するかは人が決める（同じ金額だけでは重複とみなさない）。
 */

import { isUuid } from '@/lib/estimate/ownership'

export { isUuid }

const SHA256_RE = /^[0-9a-f]{64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 1件の請求金額の上限（入力ミスの桁あふれを弾く。円） */
const MAX_AMOUNT = 1_000_000_000_000
const MAX_NOTE = 500
const MAX_VENDOR = 200
const MAX_INVOICE_NUMBER = 100

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v)
}

/** YYYY-MM-DD で、実在する日付か */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** 0 以外の有限の数値（値引・返品のマイナス請求は従来どおり許可） */
export function isInvoiceAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v !== 0 && Math.abs(v) < MAX_AMOUNT
}

export type InvoiceSource = 'ocr' | 'manual'

export type InvoiceRequest = {
  source: InvoiceSource
  amount: number
  invoice_date: string | null
  payment_date: string | null
  note: string | null
  vendor_name: string | null
  invoice_number: string | null
  document_sha256: string | null
  idempotency_key: string | null
  /** 「以前の請求書と似ています」を確認したうえで登録する */
  confirm_similar: boolean
}

type Parsed = { ok: true; value: InvoiceRequest } | { ok: false; error: string }

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > max) return undefined
  return t || null
}

function optionalDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null
  return isIsoDate(v) ? v : undefined
}

/**
 * POST /api/cost-ledger/[id]/invoices の本文を検証する。
 * source 省略は手動登録（従来のクライアント互換）。OCR 登録はハッシュと冪等キーが必須。
 * project_id は受け取らない（サーバーが親の台帳項目から取得する）。
 */
export function parseInvoiceRequest(body: unknown): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request' }
  const b = body as Record<string, unknown>

  const source = b.source === undefined || b.source === null ? 'manual' : b.source
  if (source !== 'ocr' && source !== 'manual') return { ok: false, error: 'Invalid source' }

  if (!isInvoiceAmount(b.amount)) return { ok: false, error: '金額を正しく入力してください' }

  const invoice_date = optionalDate(b.invoice_date)
  const payment_date = optionalDate(b.payment_date)
  if (invoice_date === undefined || payment_date === undefined) return { ok: false, error: '日付の形式が正しくありません' }

  const note = optionalText(b.note, MAX_NOTE)
  const vendor_name = optionalText(b.vendor_name, MAX_VENDOR)
  const invoice_number = optionalText(b.invoice_number, MAX_INVOICE_NUMBER)
  if (note === undefined || vendor_name === undefined || invoice_number === undefined) {
    return { ok: false, error: 'Invalid request' }
  }

  const idempotency_key = b.idempotency_key === undefined || b.idempotency_key === null ? null : b.idempotency_key
  if (idempotency_key !== null && !isUuid(idempotency_key)) return { ok: false, error: 'Invalid idempotency_key' }

  const document_sha256 = b.document_sha256 === undefined || b.document_sha256 === null ? null : b.document_sha256
  if (source === 'ocr') {
    if (!isSha256(document_sha256)) return { ok: false, error: 'Invalid document_sha256' }
    if (idempotency_key === null) return { ok: false, error: 'idempotency_key required' }
  } else if (document_sha256 !== null) {
    // 手動登録は画像を持たない（DB の CHECK 制約と同じ）
    return { ok: false, error: 'Invalid document_sha256' }
  }

  if (b.confirm_similar !== undefined && typeof b.confirm_similar !== 'boolean') return { ok: false, error: 'Invalid request' }

  return {
    ok: true,
    value: {
      source,
      amount: b.amount,
      invoice_date,
      payment_date,
      note,
      // 手動登録には OCR の読み取り情報を持たせない
      vendor_name: source === 'ocr' ? vendor_name : null,
      invoice_number: source === 'ocr' ? invoice_number : null,
      document_sha256: source === 'ocr' ? (document_sha256 as string) : null,
      idempotency_key: idempotency_key as string | null,
      confirm_similar: b.confirm_similar === true,
    },
  }
}

// ── 似ている請求書の判定 ─────────────────────────────────────

/** 請求書番号の比較用正規化（全角→半角・英字の大小・空白と区切り記号を無視） */
export function normalizeInvoiceNumber(v: string | null | undefined): string | null {
  if (!v) return null
  const n = v.normalize('NFKC').toLowerCase().replace(/[\s\-_‐－ー―/.#№:：]/g, '').replace(/^no/, '')
  return n || null
}

/** 業者名の比較用正規化（全角→半角・法人格・空白を無視） */
export function normalizeVendorName(v: string | null | undefined): string | null {
  if (!v) return null
  const n = v.normalize('NFKC').toLowerCase()
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)|㈱|㈲/g, '')
    .replace(/[\s　・.,]/g, '')
  return n || null
}

/** 既存行（vendor_name 列の追加前）は備考の「○○からの請求」にだけ業者名が残っている */
function vendorOf(inv: ExistingInvoice): string | null {
  if (inv.vendor_name) return inv.vendor_name
  const m = inv.note?.match(/^(.+)からの請求$/)
  return m ? m[1] : null
}

export type ExistingInvoice = {
  id: string
  cost_ledger_item_id: string
  amount: number
  invoice_date: string | null
  note: string | null
  vendor_name: string | null
  invoice_number: string | null
  created_at: string
}

export type SimilarReason = 'invoice_number' | 'vendor_amount_date'

export type SimilarInvoice = ExistingInvoice & { reason: SimilarReason }

/**
 * 登録しようとしている請求書と似ている既存の請求書を返す。
 *   - 請求書番号が一致（業者名が両方あって食い違う場合は除く）
 *   - 業者名・金額・請求日がすべて一致
 * 金額だけ・業者名と金額だけの一致は返さない（分割請求・定額の請求を誤って止めない）。
 * 請求書番号が両方あって異なる場合は、業者名・金額・日付が一致しても別の請求書とみなす。
 */
export function findSimilarInvoices(
  candidate: { amount: number; invoice_date: string | null; vendor_name: string | null; invoice_number: string | null },
  existing: ExistingInvoice[],
): SimilarInvoice[] {
  const num = normalizeInvoiceNumber(candidate.invoice_number)
  const vendor = normalizeVendorName(candidate.vendor_name)
  const out: SimilarInvoice[] = []
  for (const inv of existing) {
    const invNum = normalizeInvoiceNumber(inv.invoice_number)
    const invVendor = normalizeVendorName(vendorOf(inv))
    const vendorConflict = vendor != null && invVendor != null && vendor !== invVendor
    if (num != null && invNum != null) {
      if (num === invNum && !vendorConflict) out.push({ ...inv, reason: 'invoice_number' })
      continue
    }
    if (vendor != null && vendor === invVendor
      && Number(inv.amount) === candidate.amount
      && candidate.invoice_date != null && inv.invoice_date?.slice(0, 10) === candidate.invoice_date) {
      out.push({ ...inv, reason: 'vendor_amount_date' })
    }
  }
  return out
}
