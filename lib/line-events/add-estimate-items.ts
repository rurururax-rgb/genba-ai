/**
 * LINE イベントの候補を見積に追加する API（POST /api/estimate-items）の入力検証と、
 * RPC add_line_event_estimate_items（migration 20261013000001）のエラーを HTTP 応答に変換する。
 *
 * DB のエラー文（error.message / details / hint）は利用者に返さない。ログにも SQLSTATE だけを残す。
 *
 *   LE401 unauthenticated           → 401
 *   LE400 invalid_input / 22xxx     → 400
 *   LE404 not_found                 → 404（他社・削除済み・存在しないを区別しない）
 *   LE403 company_mismatch          → 403
 *   LE409 linked_to_other_project   → 409 linked_to_other_project
 *   LE409 already_reflected         → 409 already_reflected
 *   LE409 その他                    → 409 conflict
 *   55P03 / 40P01                   → 503 busy（何も変わっていないので再試行できる）
 *   それ以外（関数が無い PGRST202 等）→ 500
 */

export type AddItemPayload = {
  name:          string
  unit:          string
  selling_price: number | null
  category?:     string | null
  quantity?:     number | null   // 音声抽出した数量（null の場合は DB 側でデフォルト 1）
  memo?:         string | null   // 音声メモ（単位不一致・式固定時の参考情報）
}

export type AddRequest = {
  project_id:    string
  line_event_id: string
  items:         AddItemPayload[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isStr     = (v: unknown): v is string => typeof v === 'string'
const isOptStr  = (v: unknown) => v === undefined || v === null || isStr(v)
const isOptNum  = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v))

/** リクエスト本文を検証する。不正なら null（DB 側でも同じ検証をする） */
export function parseAddRequest(body: unknown): AddRequest | null {
  if (!body || typeof body !== 'object') return null
  const { project_id, line_event_id, items } = body as Record<string, unknown>
  if (!isStr(project_id) || !UUID_RE.test(project_id)) return null
  if (!isStr(line_event_id) || !UUID_RE.test(line_event_id)) return null
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) return null
  for (const it of items) {
    if (!it || typeof it !== 'object') return null
    const i = it as Record<string, unknown>
    if (!isStr(i.name) || !i.name.trim() || !isStr(i.unit) || !i.unit.trim()) return null
    if (!isOptNum(i.selling_price) || !isOptNum(i.quantity) || !isOptStr(i.category) || !isOptStr(i.memo)) return null
  }
  return {
    project_id,
    line_event_id,
    items: (items as Record<string, unknown>[]).map(i => ({
      name:          i.name as string,
      unit:          i.unit as string,
      selling_price: (i.selling_price as number | null | undefined) ?? null,
      category:      (i.category as string | null | undefined) ?? null,
      quantity:      (i.quantity as number | null | undefined) ?? null,
      memo:          (i.memo as string | null | undefined) ?? null,
    })),
  }
}

export type RpcError = { code?: string | null; message?: string | null } | null | undefined
export type MappedError = { status: number; body: { error: string; code?: string } }

export function mapAddEstimateItemsError(error: RpcError): MappedError {
  const code = error?.code ?? ''
  switch (code) {
    case 'LE401':
      return { status: 401, body: { error: 'Unauthorized' } }
    case 'LE400':
      return { status: 400, body: { error: '入力内容を確認してください' } }
    case 'LE404':
      return { status: 404, body: { error: '案件またはLINEメッセージが見つかりません。画面を再読み込みしてください。', code: 'not_found' } }
    case 'LE403':
      return { status: 403, body: { error: 'このLINEメッセージは別の会社のものです。', code: 'company_mismatch' } }
    case 'LE409':
      if (error?.message === 'linked_to_other_project') {
        return { status: 409, body: { error: 'このLINEメッセージは別の案件に振り分け済みです。画面を再読み込みしてください。', code: 'linked_to_other_project' } }
      }
      if (error?.message === 'already_reflected') {
        return { status: 409, body: { error: 'このLINEメッセージは見積に反映済みです。画面を再読み込みしてください。', code: 'already_reflected' } }
      }
      return { status: 409, body: { error: '他の操作と内容が食い違いました。画面を再読み込みしてください。', code: 'conflict' } }
    case '55P03':
    case '40P01':
      return { status: 503, body: { error: '他の操作と重なりました。少し待ってからもう一度お試しください。', code: 'busy' } }
  }
  if (code.startsWith('22')) return { status: 400, body: { error: '入力内容を確認してください' } }
  return { status: 500, body: { error: '見積に追加できませんでした。もう一度お試しください。' } }
}
