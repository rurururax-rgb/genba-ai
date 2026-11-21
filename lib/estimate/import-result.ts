/**
 * 取り込み API（/api/estimate-items/import）の結果の見分け方と、結果が分からなかったときの照合。
 *
 * 通信が途切れたときは、サーバーで登録が終わっていて応答だけが届かなかったことがある。
 * これを「保存失敗・もう一度追加してよい」と扱うと二重に登録されるため、次の 3 つに分ける:
 *   - saved    … 2xx。登録済み
 *   - rejected … サーバーが登録を断った（4xx、またはこの API が返したエラー本文つきの 500）。1 件も登録されていない
 *   - unknown  … 応答が届かない・本文のない 5xx（ゲートウェイ・タイムアウトなど）。登録されたか分からない
 * この API の insert は 1 文なので、エラー本文つきで返したときは 1 件も登録されていない。
 */

export type ImportOutcome =
  | { kind: 'saved'; body: unknown }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown' }

export async function classifyImportResponse(res: Response | null, fallbackError = '見積への追加に失敗しました'): Promise<ImportOutcome> {
  if (!res) return { kind: 'unknown' }
  if (res.ok) return { kind: 'saved', body: await res.json().catch(() => null) }
  const body = await res.json().catch(() => null) as { error?: unknown } | null
  const error = typeof body?.error === 'string' ? body.error : null
  if (res.status >= 400 && res.status < 500) return { kind: 'rejected', error: error ?? fallbackError }
  if (res.status === 500 && error) return { kind: 'rejected', error }
  return { kind: 'unknown' }
}

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
