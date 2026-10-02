/**
 * 書き込みリクエスト（POST / PATCH / DELETE）の共通ラッパー
 *
 * 目的: 「失敗したのに成功したように見える」状態を作らない。
 *   - HTTP エラー（4xx / 5xx）
 *   - 通信例外（オフライン・タイムアウト・DNS 失敗などで fetch が throw）
 * のどちらも { ok: false, message } として返し、呼び出し側が必ず分岐できるようにする。
 *
 * 呼び出し側の約束（Failure Philosophy）:
 *   成功 … サーバーが返した値で画面を確定する
 *   失敗 … ユーザーに message を表示し、画面を DB の値へ戻す（再取得）
 */

export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; status: number | null }

export const NETWORK_ERROR_MESSAGE = '通信できませんでした。接続を確認して、もう一度お試しください。'

export async function writeRequest<T = unknown>(
  url: string,
  init: RequestInit,
  /** HTTP エラーでサーバーがメッセージを返さなかった場合の文言（例: '保存に失敗しました'） */
  fallbackMessage: string,
): Promise<WriteResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, message: NETWORK_ERROR_MESSAGE, status: null }
  }

  // 本文は JSON とは限らない（空・HTML のエラーページ等）。読めなければ null
  const body = await res.json().catch(() => null) as unknown

  if (!res.ok) {
    const serverMessage = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null
    return { ok: false, message: serverMessage ?? `${fallbackMessage}（${res.status}）`, status: res.status }
  }
  return { ok: true, data: body as T }
}

/** JSON を送る書き込みリクエストの init を作る */
export function jsonInit(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
