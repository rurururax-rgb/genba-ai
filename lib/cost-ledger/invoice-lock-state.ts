/**
 * 原価台帳の画面で「請求実績（actual_cost）を直接編集させてよいか」を決める（画面用・DB に触れない）。
 *
 * 件数の出どころは2つ:
 *   - 一覧 API（GET /api/cost-ledger）の invoice_count … DB から読み直した件数。表示はこちらを優先する
 *   - 内訳パネルで読み込んだ請求書（invoicesMap）… 以前に開いたときの内容で、古いことがある
 * 一覧の件数が不明なとき、または2つが食い違うときは、どちらかに1件でもあれば編集させない（安全側）。
 * 食い違ったキャッシュは読み直して DB の結果へ揃える（staleInvoiceCaches）。
 */

export type ActualCostLockState = {
  /** true のとき請求実績を直接編集させない */
  locked: boolean
  /** 表示する件数（一覧 API の件数）。不明なら null */
  count: number | null
}

function validCount(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null
}

export function actualCostLockState(
  listCount: number | null | undefined,
  cachedInvoices: readonly unknown[] | undefined,
): ActualCostLockState {
  const count = validCount(listCount)
  const cached = cachedInvoices?.length ?? 0
  return { locked: count === null || count > 0 || cached > 0, count }
}

/** 内訳のキャッシュが一覧 API の件数と食い違う項目（読み直しが必要）。一覧に無い項目のキャッシュも含む */
export function staleInvoiceCaches(
  items: ReadonlyArray<{ id: string; invoice_count?: number | null }>,
  cache: Readonly<Record<string, readonly unknown[]>>,
): string[] {
  const counts = new Map(items.map(i => [i.id, validCount(i.invoice_count)]))
  return Object.keys(cache).filter(id => {
    const c = counts.get(id)
    return c === undefined || c === null || c !== cache[id].length
  })
}
