/**
 * lib/line/push.ts
 *
 * LINE Messaging API — テキスト Push Message 送信。
 *
 * ── 責務の境界 ──────────────────────────────────────────────────────
 * このモジュールは「指定 userId へテキストを1通送る」だけ。
 *
 * 実装しないもの（拡張するときはこのファイルを編集すること）:
 *   - reply message
 *   - multicast / broadcast
 *   - Flex Message / 画像 / ファイル
 *   - 顧客への自動送信（日次ブリーフィング専用）
 *
 * ── セキュリティ ────────────────────────────────────────────────────
 * - LINE_CHANNEL_ACCESS_TOKEN はログに出力しない。
 * - LINE userId はマスクしてのみログに出力する。
 * - NEXT_PUBLIC_ 変数は使わない。
 *
 * ── 将来の拡張ポイント ───────────────────────────────────────────────
 * 現在は LINE_BRIEFING_USER_ID 環境変数から送信先を取得する（1社検証用）。
 * 将来は company_settings テーブルへの移行を想定しており、
 * その場合は sendLinePushMessage の呼び出し元が to を渡す設計で対応できる。
 */

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push'

// ── 型定義 ──────────────────────────────────────────────────────────

export type LinePushParams = {
  /** 送信先 LINE userId（U から始まる文字列） */
  to:   string
  /** 送信テキスト（最大 5000 文字） */
  text: string
}

export type LinePushResult =
  | { ok: true }
  | { ok: false; reason: string; httpStatus?: number }

// ── メイン送信関数 ───────────────────────────────────────────────────

/**
 * LINE テキスト Push Message を1通送信する。
 *
 * @param params  to（userId）と text
 * @returns       成功時 { ok: true }、失敗時 { ok: false, reason, httpStatus }
 */
export async function sendLinePushMessage(
  params: LinePushParams,
): Promise<LinePushResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN

  // ── 引数チェック ─────────────────────────────────────────────────

  if (!token) {
    return { ok: false, reason: 'LINE_CHANNEL_ACCESS_TOKEN が設定されていません' }
  }
  if (!params.to || !params.to.startsWith('U')) {
    return { ok: false, reason: `LINE userId が無効です（to="${maskUserId(params.to)}"）` }
  }
  if (!params.text || params.text.trim().length === 0) {
    return { ok: false, reason: 'text が空文字です' }
  }
  if (params.text.length > 5000) {
    return { ok: false, reason: `text が 5000 文字を超えています（${params.text.length}文字）` }
  }

  // ── HTTP リクエスト ───────────────────────────────────────────────

  let res: Response
  try {
    res = await fetch(LINE_PUSH_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,   // token はここのみ使用。ログに出さない
      },
      body: JSON.stringify({
        to:       params.to,
        messages: [{ type: 'text', text: params.text }],
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[LINE Push] fetch 失敗: ${msg}`)
    return { ok: false, reason: `ネットワークエラー: ${msg}` }
  }

  // ── レスポンス確認 ────────────────────────────────────────────────

  if (res.ok) {
    console.log(
      `[LINE Push] 送信成功 → to=${maskUserId(params.to)} HTTP=${res.status}`,
    )
    return { ok: true }
  }

  // エラー時: ステータスとレスポンスボディをログに残す（token は含まない）
  let errorBody = ''
  try {
    errorBody = await res.text()
  } catch {
    errorBody = '(body 読み取り失敗)'
  }
  console.error(
    `[LINE Push] 送信失敗 → to=${maskUserId(params.to)} HTTP=${res.status} body=${errorBody}`,
  )
  return {
    ok:         false,
    reason:     `LINE API エラー HTTP ${res.status}: ${errorBody}`,
    httpStatus: res.status,
  }
}

// ── ユーティリティ ────────────────────────────────────────────────────

/** userId の先頭3文字と末尾3文字のみ残してマスク（ログ安全表示用） */
export function maskUserId(userId: string): string {
  if (!userId) return '(empty)'
  if (userId.length <= 8) return userId.slice(0, 2) + '***'
  return userId.slice(0, 3) + '***' + userId.slice(-3)
}
