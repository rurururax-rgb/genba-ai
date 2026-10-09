/**
 * 業者請求書の登録（POST /api/cost-ledger/[id]/invoices）をブラウザから送る。
 *
 * 二重登録を防ぐ約束:
 *   - 1回の登録操作に1つの idempotency_key を使う。通信エラー後の再試行でも同じキーを使う
 *     （サーバーは保存済みなら新しい行を作らず、保存済みの結果を返す）
 *   - 新しいキーを作るのは、新しい登録操作を始めるとき（成功後・別の画像・フォームを開き直したとき）だけ
 *   - 送信中は次の送信を受け付けない（連打・Enter の連続入力）
 *   - 結果が分からない（通信エラー・サーバーエラー）ときは自動で再送しない
 */

import { NETWORK_ERROR_MESSAGE } from '@/lib/api/write-request'

export type SavedInvoice = {
  id: string
  cost_ledger_item_id: string
  amount: number
  invoice_date: string | null
  payment_date: string | null
  note: string | null
  source: string | null
  vendor_name: string | null
  invoice_number: string | null
  created_at: string
}

export type ExistingDocument = {
  cost_ledger_item_id: string
  item_name: string | null
  amount: number
  invoice_date: string | null
  created_at: string
}

export type SimilarInvoiceSummary = {
  id: string
  cost_ledger_item_id: string
  item_name: string | null
  amount: number
  invoice_date: string | null
  vendor_name: string | null
  invoice_number: string | null
  created_at: string
  reason: 'invoice_number' | 'vendor_amount_date'
}

export type InvoicePayload = {
  source: 'ocr' | 'manual'
  amount: number
  invoice_date: string | null
  payment_date: string | null
  note: string | null
  vendor_name?: string | null
  invoice_number?: string | null
  document_sha256?: string | null
  confirm_similar?: boolean
}

export type PostInvoiceResult =
  /** 保存できた。replayed = 以前の送信で保存済みだった（新しい行は作っていない） */
  | { kind: 'saved'; invoice: SavedInvoice; newActualCost: number | null; synced: boolean; replayed: boolean }
  /** 同じ案件に同じ画像が登録済み */
  | { kind: 'duplicate_document'; message: string; existing: ExistingDocument | null }
  /** 以前の請求書と似ている（確認すれば登録できる） */
  | { kind: 'similar'; message: string; similar: SimilarInvoiceSummary[] }
  /** 保存されていないことが確かな失敗（入力不備・対象なし・キーの食い違い） */
  | { kind: 'rejected'; message: string; status: number }
  /** 保存されたか分からない（通信エラー・サーバーエラー）。同じキーでの再送は安全 */
  | { kind: 'unknown'; message: string }

export const UNKNOWN_RESULT_MESSAGE =
  '登録できたか確認できませんでした。もう一度「登録」を押しても二重には登録されません。'

export async function postInvoice(
  itemId: string,
  payload: InvoicePayload,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostInvoiceResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/cost-ledger/${itemId}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, idempotency_key: idempotencyKey }),
    })
  } catch {
    return { kind: 'unknown', message: `${NETWORK_ERROR_MESSAGE}（${UNKNOWN_RESULT_MESSAGE}）` }
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  const message = typeof body?.error === 'string' ? body.error : null

  if (res.ok) {
    if (!body || typeof body.invoice !== 'object' || body.invoice === null) {
      return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
    }
    return {
      kind: 'saved',
      invoice: body.invoice as SavedInvoice,
      newActualCost: typeof body.newActualCost === 'number' ? body.newActualCost : null,
      synced: body.synced !== false,
      replayed: body.replayed === true,
    }
  }
  if (res.status === 409 && body?.code === 'duplicate_document') {
    return { kind: 'duplicate_document', message: message ?? 'この請求書は登録済みです', existing: (body.existing as ExistingDocument) ?? null }
  }
  if (res.status === 409 && body?.code === 'similar_invoice') {
    return { kind: 'similar', message: message ?? '以前の請求書と似ています', similar: (body.similar as SimilarInvoiceSummary[]) ?? [] }
  }
  if (res.status >= 400 && res.status < 500) {
    return { kind: 'rejected', message: message ?? `登録できませんでした（${res.status}）`, status: res.status }
  }
  return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
}

/**
 * 1回の登録操作。送信中の二重送信を止め、操作が終わるまで同じ idempotency_key を使う。
 * React では useRef に入れて使う（state だと連打の間に再描画が間に合わない）。
 */
export function createRegisterAttempt(newKey: () => string = () => crypto.randomUUID()) {
  let key: string | null = null
  let busy = false
  return {
    get busy() { return busy },
    /** 現在の操作のキー（なければ作る） */
    key() {
      if (!key) key = newKey()
      return key
    },
    /** 送信する。送信中なら何もせず null を返す */
    async submit<T>(send: (key: string) => Promise<T>): Promise<T | null> {
      if (busy) return null
      busy = true
      try {
        return await send(this.key())
      } finally {
        busy = false
      }
    },
    /** 登録操作を終える（成功後・別の画像・フォームを開き直したとき）。次の送信は新しいキーになる */
    reset() {
      key = null
    },
  }
}

export type RegisterAttempt = ReturnType<typeof createRegisterAttempt>
