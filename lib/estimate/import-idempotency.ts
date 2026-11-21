/**
 * 見積書 OCR 取り込みの登録 ID（estimate_items.import_request_id）による二重登録防止（サーバー側）。
 *
 * - 取り込み候補 1 行ごとに画面が登録 ID を作り、再送では同じ ID を送る
 * - 同じ会社に同じ ID の明細があれば、もう一度は入れずにその明細を返す（再送・連打・別ウィンドウ・同時送信）
 * - 同じ ID でも中身（案件・工種・品名・数量・単位・原価・業者・社内メモ）が違えば 409 で断る
 * - 同時に同じ ID が来たときは UNIQUE (company_id, import_request_id) で後の INSERT が 23505 になる。
 *   そのときは保存済みの行を読み直して同じ判定をする
 *
 * 応答の約束（画面の classifyImportResponse と対）:
 *   - 1 件でも登録したあとはエラーを返さない（「断られた＝1 件も入っていない」を崩さない）
 *   - 5xx のうち「1 件も入っていない」と言い切れるものだけ not_saved: true を付ける。
 *     Supabase との通信が途切れた（コードのないエラー）ときは、コミット済みのことがあるので付けない
 */

/** PostgREST / PostgreSQL のエラー（code が無いものは通信の失敗など、結果が分からない） */
export type DbError = { message: string; code?: string | null }

/** 1 件も入っていないと言い切れる DB のエラーか（PostgreSQL の SQLSTATE か PostgREST の PGRST コードがある） */
export function isDefiniteDbError(error: DbError): boolean {
  return typeof error.code === 'string' && error.code.length > 0
}

/** import_request_id 列が無い（migration 未適用）ことを表すエラーか */
export function isMissingImportRequestColumn(error: DbError): boolean {
  if (error.code === '42703' || error.code === 'PGRST204') return /import_request_id/.test(error.message)
  return false
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 登録 ID の形を確かめる。全行に付いているか・全行に無いか（混在は断る）、UUID か、要求の中で重複しないか。
 * 問題なければ { ids }（無ければ null）、問題があればエラー文
 */
export function validateImportRequestIds(items: Array<{ import_request_id?: unknown }>): { ids: string[] | null } | { error: string } {
  const withId = items.filter(i => i.import_request_id != null)
  if (withId.length === 0) return { ids: null }
  if (withId.length !== items.length) return { error: '登録 ID のない行が含まれています' }
  const ids = items.map(i => i.import_request_id)
  if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) return { error: '登録 ID の形式が正しくありません' }
  const lower = (ids as string[]).map(id => id.toLowerCase())
  if (new Set(lower).size !== lower.length) return { error: '同じ登録 ID の行が含まれています' }
  return { ids: lower }
}

/** 登録する 1 行（route が売価まで決めたもの） */
export type ImportInsertRow = {
  project_id: string
  company_id: string
  group_id: string | null
  name: string
  unit: string
  quantity: number
  cost_price: number | null
  selling_price: number | null
  selling_price_mode: 'auto' | 'manual'
  internal_memo: string | null
  vendor_name: string | null
  source: 'import'
  sort_order: number
  import_request_id: string
}

type ExistingRow = Record<string, unknown> & {
  id: string; import_request_id: string; project_id: string; group_id: string | null; deleted_at: string | null
  name: string; quantity: number; unit: string; cost_price: number | null; vendor_name: string | null; internal_memo: string | null; source: string
}

const num = (v: unknown) => (v == null ? null : Number(v))

/**
 * 保存済みの行が、今回の要求と同じ中身か。並び順（再送では置く位置を決め直す）・売価（掛け率の変更で変わる）は比べない
 */
export function sameImportContent(existing: ExistingRow, row: ImportInsertRow): boolean {
  return existing.project_id === row.project_id
    && (existing.group_id ?? null) === row.group_id
    && existing.source === 'import'
    && existing.name === row.name
    && num(existing.quantity) === num(row.quantity)
    && existing.unit === row.unit
    && num(existing.cost_price) === num(row.cost_price)
    && (existing.vendor_name ?? null) === row.vendor_name
    && (existing.internal_memo ?? null) === row.internal_memo
}

/** route が使う Supabase クライアントの一部 */
type Client = {
  from: (table: string) => {
    select: (cols: string) => { eq: (c: string, v: unknown) => { in: (c: string, v: unknown[]) => PromiseLike<{ data: unknown; error: DbError | null }> } }
    insert: (rows: unknown[]) => { select: (cols: string) => PromiseLike<{ data: unknown; error: DbError | null }> }
  }
}

export type IdempotentInsertResult =
  | { kind: 'ok'; items: Record<string, unknown>[]; created: number; replayed: number }
  | { kind: 'unavailable' }
  | { kind: 'error'; status: number; body: { error: string; code?: string; not_saved: boolean; import_request_id?: string } }

/** 同時の登録と競合したときに、保存済みの行を読み直してやり直す回数 */
const MAX_ATTEMPTS = 3

/**
 * 登録 ID 付きで登録する。同じ ID が保存済みならそれを返し、中身が違えば断る。
 * 返す items は要求の順（保存済みの行と今回登録した行を混ぜる）
 */
export async function insertImportRowsIdempotent(supabase: Client, companyId: string, rows: ImportInsertRow[], returnColumns: string): Promise<IdempotentInsertResult> {
  const ids = rows.map(r => r.import_request_id)
  const cols = `${returnColumns},project_id,deleted_at,import_request_id`
  const inserted = new Map<string, Record<string, unknown>>()

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // ── 保存済みの行（削除済みも含めて見る。RLS で自社の行だけが見える） ──
    const found = await supabase.from('estimate_items').select(cols).eq('company_id', companyId).in('import_request_id', ids)
    if (found.error) {
      if (isMissingImportRequestColumn(found.error)) return { kind: 'unavailable' }
      // まだ何も登録していない（この要求の INSERT は成功していない）
      return { kind: 'error', status: 500, body: { error: '登録済みの明細を確かめられませんでした。もう一度お試しください', not_saved: true } }
    }
    const existing = new Map(((found.data ?? []) as ExistingRow[]).map(r => [String(r.import_request_id).toLowerCase(), r]))

    for (const row of rows) {
      const e = existing.get(row.import_request_id)
      if (!e) continue
      if (e.deleted_at != null) {
        return { kind: 'error', status: 409, body: { error: 'この明細は以前に登録され、その後削除されています。もう一度追加する場合は、取り込みパネルで確認してから追加してください', code: 'import_request_deleted', not_saved: true, import_request_id: row.import_request_id } }
      }
      if (!sameImportContent(e, row)) {
        return { kind: 'error', status: 409, body: { error: 'この明細は前回の送信で、違う内容で登録されています。見積の明細を確かめてください', code: 'import_request_conflict', not_saved: true, import_request_id: row.import_request_id } }
      }
    }

    const missing = rows.filter(r => !existing.has(r.import_request_id))
    if (missing.length === 0) {
      const items = rows.map(r => strip(existing.get(r.import_request_id)!))
      return { kind: 'ok', items, created: inserted.size, replayed: rows.length - inserted.size }
    }

    // ── 足りない行だけ 1 文で登録する（失敗したら 1 件も入らない） ──
    // 一意インデックスのロックを取る順を ID の順にそろえる（ID が一部重なる一括追加どうしが同時に来ても、互いに待ち合わない）。
    // 並び順は各行の sort_order で決まるので、送る順は表示に影響しない
    const ordered = [...missing].sort((a, b) => (a.import_request_id < b.import_request_id ? -1 : a.import_request_id > b.import_request_id ? 1 : 0))
    const res = await supabase.from('estimate_items').insert(ordered).select(cols)
    if (!res.error) {
      for (const r of (res.data ?? []) as ExistingRow[]) inserted.set(String(r.import_request_id).toLowerCase(), r)
      const items = rows.map(r => strip(inserted.get(r.import_request_id) ?? existing.get(r.import_request_id)!))
      return { kind: 'ok', items, created: inserted.size, replayed: rows.length - inserted.size }
    }
    // 同じ ID の同時登録と競合した → 保存済みの行を読み直して、同じ判定をやり直す
    // デッドロック（40P01）・直列化の失敗（40001）は文ごと取り消されている（1 件も入っていない）のでやり直す
    if (res.error.code === '23505' || res.error.code === '40P01' || res.error.code === '40001') continue
    if (isMissingImportRequestColumn(res.error)) return { kind: 'unavailable' }
    if (res.error.code === '42703') {
      return { kind: 'error', status: 500, body: { error: '社内メモ欄のデータベース更新が未適用のため取り込めません。管理者に連絡してください。', not_saved: true } }
    }
    // コードのあるエラーは DB が断った（この文は 1 件も登録していない）。コードのないエラーは結果が分からない
    return isDefiniteDbError(res.error)
      ? { kind: 'error', status: 500, body: { error: res.error.message, not_saved: true } }
      : { kind: 'error', status: 503, body: { error: 'データベースとの通信が途切れました。登録されたか確かめてください', not_saved: false } }
  }
  // 競合が続いた（まだ何も登録していない）
  return { kind: 'error', status: 500, body: { error: '同時に同じ明細の登録があり、確かめられませんでした。もう一度お試しください', not_saved: true } }
}

function strip(r: Record<string, unknown>): Record<string, unknown> {
  const { project_id: _p, deleted_at: _d, ...rest } = r
  void _p; void _d
  return rest
}
