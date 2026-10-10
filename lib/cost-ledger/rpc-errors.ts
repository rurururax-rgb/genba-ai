/**
 * 原価台帳の RPC（cost_ledger_invoice_insert / update / delete）と、
 * 台帳項目の actual_cost 保護（migration 20261011000001 のトリガー）が返す SQLSTATE を
 * HTTP 応答に変換する。
 *
 * DB のエラー文（error.message / details / hint）は利用者に返さない。
 * ログにも SQLSTATE だけを残す（請求内容・内部情報を出さない）。
 *
 *   CL401 unauthenticated    → 401
 *   CL400 invalid_input      → 400
 *   CL404 not_found          → 404（他社・削除済み・存在しないを区別しない）
 *   CL409 inconsistent       → 409 inconsistent（再読み込みを促す）
 *   CL423 actual_cost_locked → 409 actual_cost_locked（請求書がある項目の実績原価は直接変更できない）
 *   55P03 / 40P01            → 503 busy（ロック待ち超過・デッドロック。トランザクションごと取り消し済みで再試行できる）
 *   23514 / 22xxx            → 400
 *   23505                    → 呼び出し側で分類（再送・同じ画像）。ここに来たら 409 conflict
 *   それ以外（関数が無い PGRST202 等） → 500
 */

export type DbError = { code?: string | null } | null | undefined

export type MappedError = { status: number; body: { error: string; code?: string } }

export const ACTUAL_COST_LOCKED_MESSAGE =
  'この項目には業者請求書が登録されているため、実績原価は直接変更できません。請求書の内訳を追加・編集してください。'

export function mapCostLedgerDbError(error: DbError, notFoundMessage = '見つかりません。画面を再読み込みしてください。'): MappedError {
  const code = error?.code ?? ''
  switch (code) {
    case 'CL401':
      return { status: 401, body: { error: 'Unauthorized' } }
    case 'CL400':
    case '23514':
      return { status: 400, body: { error: '入力内容を確認してください' } }
    case 'CL404':
      return { status: 404, body: { error: notFoundMessage, code: 'not_found' } }
    case 'CL409':
      return { status: 409, body: { error: '他の操作と内容が食い違いました。画面を再読み込みしてください。', code: 'inconsistent' } }
    case 'CL423':
      return { status: 409, body: { error: ACTUAL_COST_LOCKED_MESSAGE, code: 'actual_cost_locked' } }
    case '55P03':
    case '40P01':
      return { status: 503, body: { error: '他の操作と重なりました。少し待ってからもう一度お試しください。', code: 'busy' } }
    case '23505':
      return { status: 409, body: { error: '登録できませんでした。画面を再読み込みしてください。', code: 'conflict' } }
  }
  // 22P02（UUID・数値の形式違い）・22007/22008（日付）など入力値の変換エラー
  if (code.startsWith('22')) return { status: 400, body: { error: '入力内容を確認してください' } }
  return { status: 500, body: { error: '保存できませんでした。もう一度お試しください。' } }
}

/** numeric は JSON の数値で返るが、念のため文字列も数値に直す。null はそのまま */
export function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
