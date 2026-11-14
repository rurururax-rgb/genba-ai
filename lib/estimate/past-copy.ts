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
