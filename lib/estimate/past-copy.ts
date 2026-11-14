/**
 * 過去見積の明細を、別の案件の見積へコピーするときの行の組み立て（純粋関数）。
 *
 * Supabase / fetch / React は持たない。DB への保存・所有確認は呼び出し側（API ルート）の責任。
 * 売価の計算は lib/estimate/pricing.ts を使う（掛け率の計算をここで二重に持たない）。
 *
 * 引き継ぎルール（STEP 0 で合意済み）:
 * - 売価 manual: 元の売価をそのまま使う。0 円も有効な売価として扱う。
 * - 売価 auto  : コピー先案件の標準掛け率で計算し直す。過去案件の個別掛け率（markup_rate_override）は引き継がない。
 * - 原価が未登録（null）の auto 行: 売価を作らない（null）。過去の売価は比較用に返すだけ。
 * - 見出し・メモ行（row_type が item 以外）: 金額を持たせない。
 * - お客様向け備考（memo）・社内メモ（internal_memo）: 初期設定ではコピーしない。
 * - source は既存の 'past_item'。id・案件・会社・工種・並び順・LINE イベントはコピー元から引き継がない。
 */

import { calculateSellingPrice, DEFAULT_MARKUP_RATE, type SellingPriceMode } from './pricing'

export type PastItemRowType = 'item' | 'header' | 'note'

/** コピー元の明細（DB から読み直した値だけを渡す。クライアントから受け取った金額は使わない） */
export type PastItemSource = {
  name:                  string
  quantity:              number | null
  unit:                  string | null
  cost_price:            number | null
  selling_price:         number | null
  selling_price_mode:    SellingPriceMode | null
  markup_rate_override?: number | null
  vendor_name?:          string | null
  category?:             string | null
  row_type?:             PastItemRowType | null
  memo?:                 string | null
  internal_memo?:        string | null
}

export type PastCopyOptions = {
  /** お客様向け備考もコピーする（初期値 false） */
  includeMemo?:         boolean
  /** 社内メモもコピーする（初期値 false） */
  includeInternalMemo?: boolean
}

/**
 * コピー後の売価の決まり方
 * - manual_kept      : 元の売価をそのまま使う（manual）
 * - auto_recalculated: 原価 × コピー先案件の標準掛け率で計算し直す
 * - no_cost          : auto だが原価が未登録のため売価を作らない
 * - not_priced       : 見出し・メモ行（金額なし）
 */
export type PastCopyPriceBasis = 'manual_kept' | 'auto_recalculated' | 'no_cost' | 'not_priced'

/** コピー前に「過去の売価」と「コピー後の売価」を比べるための値 */
export type PastCopyPricePreview = {
  basis:               PastCopyPriceBasis
  selling_price_mode:  SellingPriceMode
  past_selling_price:  number | null
  new_selling_price:   number | null
  /** new - past。どちらかが null なら null */
  difference:          number | null
  /** 過去の売価とコピー後の売価が違う（片方だけ null の場合も true） */
  changed:             boolean
  /** コピー先案件で使う掛け率（auto で計算したときだけ。それ以外は null） */
  applied_markup_rate: number | null
}

export type PastCopyTarget = {
  projectId:         string
  companyId:         string
  /** コピー先の工種。null は未分類（その他） */
  groupId:           string | null
  sortOrder:         number
  /** コピー先案件の標準掛け率（projects.markup_rate）。不正・未設定なら DEFAULT_MARKUP_RATE */
  projectMarkupRate: number | null | undefined
}

/** estimate_items に INSERT する行（id・amount・作成日時は DB が決める） */
export type PastCopyInsertRow = {
  project_id:           string
  company_id:           string
  group_id:             string | null
  sort_order:           number
  name:                 string
  quantity:             number
  unit:                 string
  cost_price:           number | null
  selling_price:        number | null
  selling_price_mode:   SellingPriceMode
  markup_rate_override: null
  vendor_name:          string | null
  category:             string | null
  row_type:             PastItemRowType
  memo:                 string | null
  internal_memo:        string | null
  source:               'past_item'
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

/** 既存ルート（import・confirm-change）と同じく、0 以下・未設定・非数は DEFAULT_MARKUP_RATE */
export function resolveTargetMarkupRate(projectMarkupRate: number | null | undefined): number {
  return projectMarkupRate != null && Number.isFinite(projectMarkupRate) && projectMarkupRate > 0
    ? projectMarkupRate
    : DEFAULT_MARKUP_RATE
}

export function normalizeRowType(v: unknown): PastItemRowType {
  return v === 'header' || v === 'note' ? v : 'item'
}

/** コピー後の売価を決める（保存はしない。プレビューにもそのまま使う） */
export function planPastItemPrice(
  source: Pick<PastItemSource, 'cost_price' | 'selling_price' | 'selling_price_mode' | 'row_type'>,
  projectMarkupRate: number | null | undefined,
): PastCopyPricePreview {
  const past = finiteOrNull(source.selling_price)
  const finish = (
    basis: PastCopyPriceBasis, mode: SellingPriceMode, next: number | null, rate: number | null,
  ): PastCopyPricePreview => ({
    basis,
    selling_price_mode:  mode,
    past_selling_price:  past,
    new_selling_price:   next,
    difference:          past != null && next != null ? next - past : null,
    changed:             past !== next,
    applied_markup_rate: rate,
  })

  if (normalizeRowType(source.row_type) !== 'item') return finish('not_priced', 'auto', null, null)

  // selling_price_mode は DB で NOT NULL（既定 'auto'）。念のため null は auto として扱う
  if (source.selling_price_mode === 'manual') return finish('manual_kept', 'manual', past, null)

  const cost = finiteOrNull(source.cost_price)
  if (cost == null) return finish('no_cost', 'auto', null, null)

  const rate = resolveTargetMarkupRate(projectMarkupRate)
  return finish('auto_recalculated', 'auto', calculateSellingPrice(cost, rate), rate)
}

/** コピー元 1 行から、コピー先に INSERT する行と売価の比較を作る */
export function buildPastItemCopy(
  source: PastItemSource,
  target: PastCopyTarget,
  options: PastCopyOptions = {},
): { row: PastCopyInsertRow; price: PastCopyPricePreview } {
  const rowType = normalizeRowType(source.row_type)
  const price = planPastItemPrice(source, target.projectMarkupRate)
  const isItem = rowType === 'item'
  const quantity = finiteOrNull(source.quantity)

  const row: PastCopyInsertRow = {
    project_id:           target.projectId,
    company_id:           target.companyId,
    group_id:             target.groupId,
    sort_order:           target.sortOrder,
    name:                 source.name ?? '',
    quantity:             quantity ?? 1,
    unit:                 source.unit?.trim() ? source.unit : '式',
    cost_price:           isItem ? finiteOrNull(source.cost_price) : null,
    selling_price:        price.new_selling_price,
    selling_price_mode:   price.selling_price_mode,
    markup_rate_override: null,
    vendor_name:          isItem ? source.vendor_name ?? null : null,
    category:             source.category ?? null,
    row_type:             rowType,
    memo:                 options.includeMemo ? source.memo ?? null : null,
    internal_memo:        options.includeInternalMemo ? source.internal_memo ?? null : null,
    source:               'past_item',
  }
  return { row, price }
}

// ── 検索入力の検証（API ルートと単体テストで共通） ─────────────────────────

export const PAST_SEARCH_MAX_QUERY_LENGTH = 50
export const PAST_SEARCH_MAX_TERMS = 5
export const PAST_SEARCH_DEFAULT_LIMIT = 20
export const PAST_SEARCH_MAX_LIMIT = 30

/** ILIKE の特殊文字（% _ \）をエスケープする（PostgreSQL の既定エスケープ文字は \） */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`)
}

export type PastSearchInput =
  | { ok: true; terms: string[]; limit: number }
  | { ok: false; error: string }

/**
 * 検索語・件数の検証。全角スペースも区切りとして扱い、空白で区切った語をすべて含む明細を探す（AND）。
 * - 検索語は前後の空白を除いて 1〜50 文字、語数は 5 まで（重複は 1 つにまとめる）
 * - 全角・半角の変換はしない（DB の品名に全角英数字が残っているため、変換すると一致しなくなる）
 * - limit は 1〜30 の整数。省略時 20
 */
export function parsePastSearchInput(rawQuery: string | null, rawLimit: string | null): PastSearchInput {
  const q = (rawQuery ?? '').trim()
  if (q.length === 0) return { ok: false, error: '検索語を入力してください' }
  if (q.length > PAST_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, error: `検索語は${PAST_SEARCH_MAX_QUERY_LENGTH}文字以内で入力してください` }
  }
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))]
  if (terms.length > PAST_SEARCH_MAX_TERMS) {
    return { ok: false, error: `検索語は${PAST_SEARCH_MAX_TERMS}語以内で入力してください` }
  }

  let limit = PAST_SEARCH_DEFAULT_LIMIT
  if (rawLimit != null && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) return { ok: false, error: '件数の指定が正しくありません' }
    const n = Number(rawLimit)
    if (n < 1 || n > PAST_SEARCH_MAX_LIMIT) return { ok: false, error: '件数の指定が正しくありません' }
    limit = n
  }
  return { ok: true, terms, limit }
}

// ── コピー前のプレビューからの変更検知 ─────────────────────────────────────

/**
 * コピー元の明細とコピー先の掛け率から作る「指紋」。検索（プレビュー）時に返し、コピー時に送り返してもらう。
 * サーバーで読み直した値から作り直して一致しなければ、プレビュー後にコピー元の明細またはコピー先の掛け率が
 * 変わったとみなし、登録せずに 409 を返す（利用者が確認していない金額で登録しないため）。
 *
 * 変更検知のためのもので、認可・改ざん防止には使わない（会社・案件の確認は API が DB で行う）。
 * 対象: 品名・数量・単位・原価・売価・売価モード・業者名・分類・行の種類・コピー先の掛け率。
 * 備考・社内メモは含めない（検索結果に出さないため、プレビューで確認できる値ではない）。
 */
export function pastItemFingerprint(
  source: Pick<PastItemSource, 'name' | 'quantity' | 'unit' | 'cost_price' | 'selling_price' | 'selling_price_mode' | 'vendor_name' | 'category' | 'row_type'>,
  projectMarkupRate: number | null | undefined,
): string {
  const canonical = JSON.stringify([
    1, // 指紋の形式（対象の項目を変えたら上げる）
    source.name ?? '',
    finiteOrNull(source.quantity),
    source.unit ?? null,
    finiteOrNull(source.cost_price),
    finiteOrNull(source.selling_price),
    source.selling_price_mode === 'manual' ? 'manual' : 'auto',
    source.vendor_name ?? null,
    source.category ?? null,
    normalizeRowType(source.row_type),
    resolveTargetMarkupRate(projectMarkupRate),
  ])
  return `v1-${cyrb53(canonical).toString(16).padStart(14, '0')}`
}

/** 53 bit の文字列ハッシュ（cyrb53。依存なし・ブラウザでも動く）。変更検知用で暗号用途ではない */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// ── コピー API の入力検証（POST /api/estimate-items/copy-from-past） ─────────────

export const PAST_COPY_MAX_ITEMS = 50

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINGERPRINT_RE = /^v1-[0-9a-f]{1,32}$/

export type PastCopyRequest = {
  projectId:           string
  groupId:             string | null
  /** 利用者が指定した順（この順で末尾に追加する） */
  items:               Array<{ sourceItemId: string; fingerprint: string }>
  includeMemo:         boolean
  includeInternalMemo: boolean
}

const BODY_KEYS = new Set(['project_id', 'group_id', 'items', 'include_memo', 'include_internal_memo'])
const ITEM_KEYS = new Set(['source_item_id', 'fingerprint'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * コピー API の入力を検証する。登録内容を決める値（売価・原価・会社・並び順など）は受け付けない。
 * 想定外のキーがあれば拒否する（クライアントから送られた金額を黙って無視するより、送らせない）。
 * - project_id: UUID（必須）／ group_id: UUID または null（必須。null は未分類「その他」）
 * - items: 1〜50 件。各要素は { source_item_id: UUID, fingerprint: 検索結果の copy_preview.fingerprint }。重複 ID は拒否
 * - include_memo / include_internal_memo: 省略可。指定するなら boolean
 */
export function parsePastCopyRequest(body: unknown): { ok: true; value: PastCopyRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error })
  if (!isPlainObject(body)) return bad('リクエストの形式が正しくありません')
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) return bad(`受け付けない項目があります: ${k}`)

  const { project_id, group_id, items, include_memo, include_internal_memo } = body
  if (typeof project_id !== 'string' || !UUID_RE.test(project_id)) return bad('コピー先の案件の指定が正しくありません')
  if (!('group_id' in body)) return bad('コピー先の工種を指定してください（未分類は null）')
  if (group_id !== null && (typeof group_id !== 'string' || !UUID_RE.test(group_id))) return bad('コピー先の工種の指定が正しくありません')
  if (include_memo !== undefined && typeof include_memo !== 'boolean') return bad('include_memo は true / false で指定してください')
  if (include_internal_memo !== undefined && typeof include_internal_memo !== 'boolean') return bad('include_internal_memo は true / false で指定してください')

  if (!Array.isArray(items) || items.length === 0) return bad('コピーする明細を選んでください')
  if (items.length > PAST_COPY_MAX_ITEMS) return bad(`一度にコピーできるのは${PAST_COPY_MAX_ITEMS}件までです`)
  const seen = new Set<string>()
  const parsed: PastCopyRequest['items'] = []
  for (const it of items) {
    if (!isPlainObject(it)) return bad('明細の指定が正しくありません')
    for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) return bad(`受け付けない項目があります: items.${k}`)
    const { source_item_id, fingerprint } = it
    if (typeof source_item_id !== 'string' || !UUID_RE.test(source_item_id)) return bad('明細の指定が正しくありません')
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return bad('確認用の値（fingerprint）が正しくありません。検索し直してください')
    const id = source_item_id.toLowerCase()
    if (seen.has(id)) return bad('同じ明細が重複して指定されています')
    seen.add(id)
    parsed.push({ sourceItemId: id, fingerprint })
  }
  return {
    ok: true,
    value: {
      projectId: project_id.toLowerCase(),
      groupId: group_id === null ? null : (group_id as string).toLowerCase(),
      items: parsed,
      includeMemo: include_memo === true,
      includeInternalMemo: include_internal_memo === true,
    },
  }
}

/**
 * 工種の末尾に n 行を追加するときの sort_order（既存行の最大値 + 1000 から 1000 刻み）。
 * 既存行の並べ替えはしない。INT の範囲を超えるなら null（呼び出し側で登録を止める）。
 */
export function planAppendSortOrders(currentMax: number | null, count: number, step = 1000): number[] | null {
  const start = currentMax == null ? 0 : currentMax + step
  const orders = Array.from({ length: count }, (_, i) => start + i * step)
  return orders.every(o => Number.isSafeInteger(o) && o >= -2147483648 && o <= 2147483647) ? orders : null
}
