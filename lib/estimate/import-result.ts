/**
 * 取り込み API（/api/estimate-items/import）の結果の見分け方と、結果が分からなかったときの照合。
 *
 * 通信が途切れたときは、サーバーで登録が終わっていて応答だけが届かなかったことがある。
 * これを「保存失敗・もう一度追加してよい」と扱うと二重に登録されるため、次の 3 つに分ける:
 *   - saved    … 2xx。登録済み（同じ登録 ID の再送なら、保存済みの明細が返る）
 *   - rejected … サーバーが登録を断った。4xx（すべて登録前の確認か、登録 ID の競合）、
 *                または 5xx で not_saved: true（API が「1 件も入っていない」と言い切れるとき）
 *   - unknown  … 応答が届かない・not_saved の無い 5xx（ゲートウェイ・タイムアウト・Supabase との通信断など）
 * 以前は「エラー本文つきの 500 は未登録」としていたが、API と Supabase の間で通信が途切れたときも
 * エラー本文つきの 500 になり、コミット済みのことがあった。いまは API が not_saved で明示する。
 */

export type ImportOutcome =
  | { kind: 'saved'; body: unknown }
  | { kind: 'rejected'; error: string; code?: string; conflictRequestId?: string }
  | { kind: 'unknown' }

/** 同じ登録 ID が、違う内容で登録済み・登録後に削除済み（409）。もう一度送っても入らない */
export const IMPORT_CONFLICT_CODES = new Set(['import_request_conflict', 'import_request_deleted'])

export async function classifyImportResponse(res: Response | null, fallbackError = '見積への追加に失敗しました'): Promise<ImportOutcome> {
  if (!res) return { kind: 'unknown' }
  if (res.ok) {
    const body = await res.json().catch(() => null)
    noteImportResponse(body)
    return { kind: 'saved', body }
  }
  const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown; not_saved?: unknown; import_request_id?: unknown } | null
  const error = typeof body?.error === 'string' ? body.error : null
  const code = typeof body?.code === 'string' ? body.code : undefined
  const conflictRequestId = typeof body?.import_request_id === 'string' ? body.import_request_id : undefined
  if (res.status >= 400 && res.status < 500) return { kind: 'rejected', error: error ?? fallbackError, code, conflictRequestId }
  if (res.status >= 500 && body?.not_saved === true) return { kind: 'rejected', error: error ?? fallbackError, code }
  return { kind: 'unknown' }
}

// ── 登録 ID（estimate_items.import_request_id） ──

/** 取り込み候補 1 行の登録 ID（UUID v4）。再送では同じ ID を送る */
export function newImportRequestId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Blob の中身（Blob.arrayBuffer の無い古いブラウザ・テスト環境では FileReader） */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as ArrayBuffer)
    r.onerror = () => reject(r.error)
    r.readAsArrayBuffer(file)
  })
}

/** 画像の SHA-256（小文字 16 進）。読めなければ null（登録 ID は乱数にする） */
export async function fileSha256(file: Blob): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const d = new Uint8Array(await subtle.digest('SHA-256', await readBytes(file)))
    return [...d].map(x => x.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

/**
 * 案件・画像（SHA-256）・読み取り結果の行番号から決まる登録 ID（UUID の形・version 5 相当）。
 * 画面を再読み込みして同じ画像を読み直しても同じ ID になるので、応答を失った登録を読み直し後に再送しても二重に入らない
 * （中身が同じなら保存済みの明細が返り、違えば 409）。読めないときは乱数の ID
 */
export async function importRequestIdFor(projectId: string, imageSha256: string | null, rowIndex: number): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!imageSha256 || !subtle) return newImportRequestId()
  try {
    const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`ragz-estimate-import:v1:${projectId}:${imageSha256}:${rowIndex}`)))
    d[6] = (d[6] & 0x0f) | 0x50
    d[8] = (d[8] & 0x3f) | 0x80
    const h = [...d.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  } catch { return newImportRequestId() }
}

/**
 * 登録 API が登録 ID で二重登録を防げるか（DB に import_request_id 列がある）。
 * 一度でも idempotent: true の応答を受けたら true。結果が分からなかったときの自動の再送は、これが true のときだけ行う
 * （列が無い DB に再送すると二重に登録されるため）
 */
let serverIdempotent = false
export function noteImportResponse(body: unknown) {
  const v = (body as { idempotent?: unknown } | null)?.idempotent
  if (v === true) serverIdempotent = true
  if (v === false) serverIdempotent = false
}
export function isImportIdempotent() { return serverIdempotent }
export function resetImportIdempotencyForTest() { serverIdempotent = false }

/** 結果が分からなかったとき、同じ登録 ID で自動で送り直すまでの待ち時間 */
export const IDEMPOTENT_RETRY_MS = 800

/** 409（同じ登録 ID が違う内容で登録済み・削除済み）を受けた候補に付ける注意 */
export const IMPORT_CONFLICT_WARNING = 'この明細は前回の送信で登録済みです（違う内容、または登録後に削除）。見積を確かめ、別の明細としてもう一度追加する場合だけ「確認したので追加する」を押してください'

/** 登録したはずの明細の中身（登録 API と同じ規則で、サーバーが保存する値） */
export type ImportSignature = {
  groupId: string | null
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  /** 位置を指定して送ったときの sort_order（末尾に追加したときは undefined） */
  sortOrder?: number
}

type SavedLike = { id: string; group_id: string | null; name: string; quantity: number; unit: string; cost_price: number | null; sort_order: number; source: string }

/**
 * 結果が分からなかった登録が、DB に入っているかを探す。
 * 送る前に見えていた明細（knownIds）と、ほかの登録の結果だと分かっている明細（attributedIds）は除く。
 * 見つかった明細を返す（無ければ null）
 */
export function findSavedImport<T extends SavedLike>(items: T[], knownIds: Set<string>, attributedIds: Set<string>, sig: ImportSignature): T | null {
  const name = sig.name.trim()
  const quantity = sig.quantity ?? 1
  const unit = sig.unit ?? '式'
  return items.find(i =>
    !knownIds.has(i.id) && !attributedIds.has(i.id)
    && i.source === 'import' && (i.group_id ?? null) === sig.groupId
    && i.name === name && Number(i.quantity) === quantity && i.unit === unit
    && (i.cost_price ?? null) === (sig.cost_price ?? null)
    && (sig.sortOrder === undefined || i.sort_order === sig.sortOrder),
  ) ?? null
}

/** 結果が分からなかったときに、取り込みパネルの候補に付ける注意（「確認したので追加する」まで追加・ドラッグできない） */
export const UNKNOWN_SAVE_WARNING = '前回の追加は通信が途切れ、保存できたか確認できていません。見積に同じ明細が入っていないか確かめてから追加してください（二重に登録されることがあります）'
