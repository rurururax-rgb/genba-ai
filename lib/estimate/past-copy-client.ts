/**
 * 「過去見積から追加」画面の通信と表示用の小さな関数。
 *
 * - 検索: GET /api/estimate-items/search-past（読み取りのみ）
 * - コピー: POST /api/estimate-items/copy-from-past（自動で再送しない）
 *
 * 通信の結果は画面がそのまま分岐できる形（kind）にして返す。
 * 「登録できたか分からない」状態（通信エラー・タイムアウト・5xx）は unknown として分け、
 * 画面は再送させずに見積明細の再取得を案内する（二重登録を防ぐため）。
 */

import type { PastEstimateHit } from '@/app/api/estimate-items/search-past/route'
import type { PastCopyPricePreview } from './past-copy'

export type { PastEstimateHit }
export type PastCopyPreview = PastCopyPricePreview & { fingerprint: string }

/** 409 で返る、いまのコピー元の値（確認画面の表示を最新にする） */
export type PastCopyChangedItem = {
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  selling_price: number | null
  selling_price_mode: 'auto' | 'manual'
}
export type PastCopyChange = { source_item_id: string; copy_preview: PastCopyPreview; item?: PastCopyChangedItem }

/** コピーの応答を待つ上限。これを超えたら中断し、結果不明として扱う */
export const COPY_TIMEOUT_MS = 30_000

// ── 検索 ─────────────────────────────────────────────────────────────

export type PastSearchOutcome =
  | { kind: 'ok'; items: PastEstimateHit[]; hasMore: boolean }
  | { kind: 'aborted' }
  | { kind: 'error'; status: number | null; message: string }

export async function searchPastEstimates(
  query: string, projectId: string, signal?: AbortSignal, limit = 30,
): Promise<PastSearchOutcome> {
  const params = new URLSearchParams({ q: query, project_id: projectId, limit: String(limit) })
  let res: Response
  try {
    res = await fetch(`/api/estimate-items/search-past?${params}`, { signal })
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return { kind: 'aborted' }
    return { kind: 'error', status: null, message: '通信できませんでした。接続を確認して、もう一度検索してください。' }
  }
  const body = await res.json().catch(() => null) as { items?: PastEstimateHit[]; has_more?: boolean; error?: string } | null
  if (!res.ok) return { kind: 'error', status: res.status, message: httpMessage(res.status, body?.error, '検索できませんでした') }
  return { kind: 'ok', items: Array.isArray(body?.items) ? body.items : [], hasMore: body?.has_more === true }
}

// ── コピー ───────────────────────────────────────────────────────────

export type PastCopyOutcome =
  /** 登録できた */
  | { kind: 'success'; count: number }
  /** 409: プレビュー後に金額・明細が変わった。最新のプレビューで確認し直す（登録していない） */
  | { kind: 'changed'; changed: PastCopyChange[] }
  /** 404: コピー元の明細の一部が使えなくなった（登録していない） */
  | { kind: 'missing'; ids: string[] }
  /** 400 / 401 / 403 / それ以外の 404 / 並び順の 409: 登録していない */
  | { kind: 'rejected'; status: number; message: string }
  /** 通信エラー・タイムアウト・5xx: 登録できたか分からない */
  | { kind: 'unknown'; message: string }

export const UNKNOWN_RESULT_MESSAGE =
  '追加できたか確認できませんでした。もう一度押す前に、見積明細を読み込み直して、追加されていないか確かめてください。'

export async function copyFromPast(
  body: { project_id: string; group_id: string | null; items: Array<{ source_item_id: string; fingerprint: string }> },
  timeoutMs = COPY_TIMEOUT_MS,
): Promise<PastCopyOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch('/api/estimate-items/copy-from-past', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 備考・社内メモは検索結果で中身を確認できないため、この画面ではコピーしない（常に false）
      body: JSON.stringify({ ...body, include_memo: false, include_internal_memo: false }),
      signal: controller.signal,
    })
  } catch {
    return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
  } finally {
    clearTimeout(timer)
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null
  if (res.ok) {
    const count = typeof data?.inserted_count === 'number' ? data.inserted_count : body.items.length
    return { kind: 'success', count }
  }
  if (res.status >= 500) return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
  if (res.status === 409 && Array.isArray(data?.changed)) {
    return { kind: 'changed', changed: data.changed as PastCopyChange[] }
  }
  if (res.status === 404 && Array.isArray(data?.missing_source_item_ids)) {
    return { kind: 'missing', ids: data.missing_source_item_ids as string[] }
  }
  const serverError = typeof data?.error === 'string' ? data.error : undefined
  if (res.status === 404) {
    return { kind: 'rejected', status: 404, message: 'コピー先の案件または工種が見つかりません。画面を再読み込みしてから、もう一度お試しください。' }
  }
  return { kind: 'rejected', status: res.status, message: httpMessage(res.status, serverError, '追加できませんでした') }
}

function httpMessage(status: number, serverError: string | undefined, fallback: string): string {
  if (status === 401) return 'ログインの有効期限が切れました。ログインし直してください。'
  if (status === 403) return 'この操作を行う権限がありません。会社の管理者に確認してください。'
  if (status === 400 && serverError) return serverError
  if (status === 409 && serverError) return serverError
  return `${fallback}（${status}）`
}

// ── 表示 ─────────────────────────────────────────────────────────────

export function formatYen(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `¥${Math.round(v).toLocaleString('ja-JP')}`
}

export function formatSignedYen(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`
}

/** ISO 日時 → 2026/03/01（日本時間）。読めなければ空文字 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
}

export type PriceTone = 'same' | 'changed' | 'fixed' | 'unset'

/**
 * コピー後の売価の見せ方。
 * - changed: 掛け率で計算し直して過去の売価と変わる（差額を出す）
 * - same   : 計算し直しても過去と同じ
 * - fixed  : 手入力の売価をそのまま使う（0 円も含む）
 * - unset  : 原価がないため売価なし（手入力が必要）
 */
export function describeCopyPrice(p: PastCopyPricePreview): { tone: PriceTone; badge: string; detail: string } {
  if (p.basis === 'manual_kept') {
    return {
      tone: 'fixed',
      badge: p.new_selling_price === 0 ? '0円で固定' : '手入力の売価で固定',
      detail: p.new_selling_price == null ? '過去の明細に売価がありません。追加後に入力してください' : '過去の売価をそのまま使います（掛け率で計算し直しません）',
    }
  }
  if (p.basis === 'no_cost' || p.basis === 'not_priced' || p.new_selling_price == null) {
    return {
      tone: 'unset',
      badge: '売価なし',
      detail: '原価がないため売価を計算できません。追加後に売価を入力してください',
    }
  }
  if (p.changed) {
    return {
      tone: 'changed',
      badge: p.difference != null ? `過去より ${formatSignedYen(p.difference)}` : '原価から計算',
      detail: p.applied_markup_rate != null ? `この案件の掛け率 ${p.applied_markup_rate} で計算し直します` : 'この案件の掛け率で計算し直します',
    }
  }
  return { tone: 'same', badge: '過去と同じ', detail: 'この案件の掛け率で計算し直しても同じ売価です' }
}
