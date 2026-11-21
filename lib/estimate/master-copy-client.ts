/**
 * 「資材マスターから追加」画面の通信。
 *
 * - 検索: GET /api/estimate-items/search-master（読み取りのみ）
 * - 追加: POST /api/estimate-items/add-from-master（自動で再送しない）
 *
 * 通信の結果は画面がそのまま分岐できる形（kind）にして返す。
 * 「登録できたか分からない」状態（通信エラー・タイムアウト・5xx）は unknown として分け、
 * 画面は再送させずに見積明細の再取得を案内する（二重登録を防ぐため）。過去見積から追加と同じ扱い。
 */

import type { MasterItemHit } from '@/app/api/estimate-items/search-master/route'
import type { SellingPriceMode } from './pricing'
import { COPY_TIMEOUT_MS, UNKNOWN_RESULT_MESSAGE } from './past-copy-client'

export type { MasterItemHit }

// ── 検索 ─────────────────────────────────────────────────────────────

export type MasterSearchOutcome =
  | { kind: 'ok'; items: MasterItemHit[]; hasMore: boolean }
  | { kind: 'aborted' }
  | { kind: 'error'; status: number | null; message: string }

export async function searchMasterItems(
  query: string, projectId: string, signal?: AbortSignal, limit = 30,
): Promise<MasterSearchOutcome> {
  const params = new URLSearchParams({ q: query, project_id: projectId, limit: String(limit) })
  let res: Response
  try {
    res = await fetch(`/api/estimate-items/search-master?${params}`, { signal })
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return { kind: 'aborted' }
    return { kind: 'error', status: null, message: '通信できませんでした。接続を確認して、もう一度検索してください。' }
  }
  const body = await res.json().catch(() => null) as { items?: MasterItemHit[]; has_more?: boolean; error?: string } | null
  if (!res.ok) return { kind: 'error', status: res.status, message: httpMessage(res.status, body?.error, '検索できませんでした') }
  const items = Array.isArray(body?.items) ? body.items.filter(i => i?.preview?.fingerprint) : []
  return { kind: 'ok', items, hasMore: body?.has_more === true }
}

// ── 追加 ─────────────────────────────────────────────────────────────

export type MasterAddBody = {
  project_id:         string
  group_id:           string | null
  master_item_id:     string
  fingerprint:        string
  quantity:           number
  cost_price:         number | null
  selling_price_mode: SellingPriceMode
  /** manual のときだけ送る */
  selling_price?:     number
}

export type MasterAddOutcome =
  /** 登録できた */
  | { kind: 'success' }
  /** 409: 画面に出した後にマスターの内容か案件の掛け率が変わった。いまの内容で確認し直す（登録していない） */
  | { kind: 'changed'; item: MasterItemHit; message: string }
  /** 404 で資材が見つからない（削除された・他社）。登録していない */
  | { kind: 'missing'; message: string }
  /** 400 / 401 / 403 / 案件・工種の 404 / 並び順の 409: 登録していない */
  | { kind: 'rejected'; status: number; message: string }
  /** 通信エラー・タイムアウト・5xx: 登録できたか分からない */
  | { kind: 'unknown'; message: string }

export async function addFromMaster(body: MasterAddBody, timeoutMs = COPY_TIMEOUT_MS): Promise<MasterAddOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch('/api/estimate-items/add-from-master', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
  } finally {
    clearTimeout(timer)
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null
  const serverError = typeof data?.error === 'string' ? data.error : undefined
  if (res.ok) return { kind: 'success' }
  if (res.status >= 500) return { kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE }
  const item = data?.item as MasterItemHit | undefined
  if (res.status === 409 && item?.preview?.fingerprint) {
    return { kind: 'changed', item, message: serverError ?? '資材マスターの内容が変わりました。確認してからもう一度追加してください。' }
  }
  if (res.status === 404 && data?.reason === 'master_not_found') {
    return { kind: 'missing', message: serverError ?? 'この資材は資材マスターから削除されたか、見つかりません。検索し直してください。' }
  }
  if (res.status === 404) {
    return { kind: 'rejected', status: 404, message: '追加先の案件または工種が見つかりません。画面を再読み込みしてから、もう一度お試しください。' }
  }
  return { kind: 'rejected', status: res.status, message: httpMessage(res.status, serverError, '追加できませんでした') }
}

function httpMessage(status: number, serverError: string | undefined, fallback: string): string {
  if (status === 401) return 'ログインの有効期限が切れました。ログインし直してください。'
  if (status === 403) return 'この操作を行う権限がありません。会社の管理者に確認してください。'
  if ((status === 400 || status === 409) && serverError) return serverError
  return `${fallback}（${status}）`
}
