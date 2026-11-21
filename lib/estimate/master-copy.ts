/**
 * 自社資材マスター（company_estimate_items）の商品を見積明細に追加するときの決まり（純粋関数）。
 *
 * Supabase / fetch / React は持たない。DB への保存・所有確認は呼び出し側（API ルート）の責任。
 * 売価の計算は lib/estimate/pricing.ts を使う（掛け率の計算をここで二重に持たない）。
 *
 * 売価の決まり（既存の取込 POST /api/estimate-items/import と同じ考え方）:
 * - 初期値: マスターに売価（0 より大きい）があれば「マスターの売価で固定」（manual）。
 *           無ければ「掛け率で計算」（auto = 原価 × 案件の標準掛け率。原価も無ければ売価なし）。
 * - 利用者は追加前に数量・原価・売価の決め方（と manual の売価）を変えられる。
 * - auto の売価はサーバーが原価 × 案件の標準掛け率で計算する（クライアントの計算結果は使わない）。
 * - 個別掛け率（markup_rate_override）は付けない。
 * - 品名・単位・分類はサーバーがマスターから読み直す。仕様・URL・メモは PR-1 では見積に入れない。
 * - source は 'master'（既存の 'manual' / 'ai' / 'past_item' / 'import' と区別する）。
 */

import { calculateSellingPrice, DEFAULT_MARKUP_RATE, type SellingPriceMode } from './pricing'

/** マスターの商品（DB から読み直した値） */
export type MasterItemSource = {
  name:          string
  spec:          string | null
  unit:          string | null
  cost_price:    number | null
  selling_price: number | null
  category:      string | null
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

/** 0 以下・未設定・非数は DEFAULT_MARKUP_RATE（既存の import・過去見積のコピーと同じ） */
export function resolveMarkupRate(projectMarkupRate: number | null | undefined): number {
  return projectMarkupRate != null && Number.isFinite(projectMarkupRate) && projectMarkupRate > 0
    ? projectMarkupRate
    : DEFAULT_MARKUP_RATE
}

export type MasterPricePreview = {
  /** 初期の売価の決め方 */
  selling_price_mode: SellingPriceMode
  /** 初期の原価（マスターの原価） */
  cost_price:         number | null
  /** 初期の売価（manual はマスターの売価、auto は原価 × 掛け率。原価が無ければ null） */
  selling_price:      number | null
  /** auto で使う、この案件の標準掛け率 */
  markup_rate:        number
}

/** 追加画面の初期値（マスターの値とこの案件の掛け率から決める） */
export function planMasterItemPrice(
  master: Pick<MasterItemSource, 'cost_price' | 'selling_price'>,
  projectMarkupRate: number | null | undefined,
): MasterPricePreview {
  const rate = resolveMarkupRate(projectMarkupRate)
  const cost = finiteOrNull(master.cost_price)
  const selling = finiteOrNull(master.selling_price)
  // 取込と同じく、売価 0 は「売価が無い」とみなして掛け率で計算する
  if (selling != null && selling > 0) {
    return { selling_price_mode: 'manual', cost_price: cost, selling_price: selling, markup_rate: rate }
  }
  return { selling_price_mode: 'auto', cost_price: cost, selling_price: calculateSellingPrice(cost, rate), markup_rate: rate }
}

/** 利用者が決めた原価・売価の決め方から、保存する売価を決める（auto はサーバーで計算し直す） */
export function resolveMasterSellingPrice(
  mode: SellingPriceMode,
  costPrice: number | null,
  manualSellingPrice: number | null,
  projectMarkupRate: number | null | undefined,
): number | null {
  if (mode === 'manual') return manualSellingPrice
  return calculateSellingPrice(costPrice, resolveMarkupRate(projectMarkupRate))
}

/** 金額（数量 × 売価）。見積エディタと同じく小数は四捨五入して表示用にする */
export function masterLineAmount(quantity: number | null, sellingPrice: number | null): number | null {
  if (quantity == null || sellingPrice == null || !Number.isFinite(quantity) || !Number.isFinite(sellingPrice)) return null
  return Math.round(quantity * sellingPrice)
}

// ── 変更検知 ─────────────────────────────────────────────────────────

/**
 * マスターの商品とこの案件の掛け率から作る「指紋」。検索時に返し、追加時に送り返してもらう。
 * 一致しなければ、画面に出した後にマスターの内容か案件の掛け率が変わったとみなし、登録せずに 409 を返す。
 * 変更検知のためのもので、認可・改ざん防止には使わない（会社・案件の確認は API が DB で行う）。
 */
export function masterItemFingerprint(master: MasterItemSource, projectMarkupRate: number | null | undefined): string {
  const canonical = JSON.stringify([
    1, // 指紋の形式（対象の項目を変えたら上げる）
    master.name ?? '',
    master.spec ?? null,
    master.unit ?? null,
    finiteOrNull(master.cost_price),
    finiteOrNull(master.selling_price),
    master.category ?? null,
    resolveMarkupRate(projectMarkupRate),
  ])
  return `m1-${cyrb53(canonical).toString(16).padStart(14, '0')}`
}

/** 53 bit の文字列ハッシュ（cyrb53。past-copy.ts と同じ）。変更検知用で暗号用途ではない */
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

// ── 検索入力の検証（GET /api/estimate-items/search-master） ──────────────────

export const MASTER_SEARCH_MAX_QUERY_LENGTH = 50
export const MASTER_SEARCH_MAX_TERMS = 5
export const MASTER_SEARCH_DEFAULT_LIMIT = 30
export const MASTER_SEARCH_MAX_LIMIT = 50

export type MasterSearchInput =
  | { ok: true; terms: string[]; limit: number }
  | { ok: false; error: string }

/**
 * 検索語・件数の検証。空の検索語は「よく使う順の一覧」として受け付ける（terms = []）。
 * 全角スペースも区切りとして扱い、空白で区切った語をすべて品名に含む商品を探す（AND）。
 * - 検索語は 50 文字・5 語まで（重複は 1 つにまとめる）
 * - limit は 1〜50 の整数。省略時 30
 */
export function parseMasterSearchInput(rawQuery: string | null, rawLimit: string | null): MasterSearchInput {
  const q = (rawQuery ?? '').trim()
  if (q.length > MASTER_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, error: `検索語は${MASTER_SEARCH_MAX_QUERY_LENGTH}文字以内で入力してください` }
  }
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))]
  if (terms.length > MASTER_SEARCH_MAX_TERMS) {
    return { ok: false, error: `検索語は${MASTER_SEARCH_MAX_TERMS}語以内で入力してください` }
  }
  let limit = MASTER_SEARCH_DEFAULT_LIMIT
  if (rawLimit != null && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) return { ok: false, error: '件数の指定が正しくありません' }
    const n = Number(rawLimit)
    if (n < 1 || n > MASTER_SEARCH_MAX_LIMIT) return { ok: false, error: '件数の指定が正しくありません' }
    limit = n
  }
  return { ok: true, terms, limit }
}

// ── 追加 API の入力検証（POST /api/estimate-items/add-from-master） ─────────────

/** 数量・金額の上限（DB の numeric は受け付けるが、画面・合計の計算が壊れない範囲に抑える） */
export const MASTER_MAX_QUANTITY = 1_000_000
export const MASTER_MAX_PRICE = 1_000_000_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINGERPRINT_RE = /^m1-[0-9a-f]{1,32}$/

export type MasterAddRequest = {
  projectId:        string
  /** 追加先の工種。null は未分類（その他） */
  groupId:          string | null
  masterItemId:     string
  fingerprint:      string
  quantity:         number
  costPrice:        number | null
  sellingPriceMode: SellingPriceMode
  /** manual のときだけ。auto ではサーバーが計算する */
  sellingPrice:     number | null
}

const BODY_KEYS = new Set([
  'project_id', 'group_id', 'master_item_id', 'fingerprint',
  'quantity', 'cost_price', 'selling_price_mode', 'selling_price',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

const isPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < MASTER_MAX_PRICE

/**
 * 追加 API の入力を検証する。会社・品名・単位・並び順・source は受け付けない（サーバーが決める）。
 * 想定外のキーがあれば拒否する。
 * - project_id: UUID ／ group_id: UUID または null（必須。null は未分類「その他」）
 * - master_item_id: UUID ／ fingerprint: 検索結果の preview.fingerprint
 * - quantity: 0 より大きい有限の数（上限 1,000,000）
 * - cost_price: 0 以上の数または null
 * - selling_price_mode: 'auto' | 'manual'
 *   - manual: selling_price は 0 以上の数（必須。0 円も有効）
 *   - auto  : selling_price は送らない（null か省略）。原価 × 案件の標準掛け率でサーバーが計算する
 */
export function parseMasterAddRequest(body: unknown): { ok: true; value: MasterAddRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error })
  if (!isPlainObject(body)) return bad('リクエストの形式が正しくありません')
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) return bad(`受け付けない項目があります: ${k}`)

  const { project_id, group_id, master_item_id, fingerprint, quantity, cost_price, selling_price_mode, selling_price } = body
  if (typeof project_id !== 'string' || !UUID_RE.test(project_id)) return bad('追加先の案件の指定が正しくありません')
  if (!('group_id' in body)) return bad('追加先の工種を指定してください（未分類は null）')
  if (group_id !== null && (typeof group_id !== 'string' || !UUID_RE.test(group_id))) return bad('追加先の工種の指定が正しくありません')
  if (typeof master_item_id !== 'string' || !UUID_RE.test(master_item_id)) return bad('資材の指定が正しくありません')
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return bad('確認用の値（fingerprint）が正しくありません。検索し直してください')

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > MASTER_MAX_QUANTITY) {
    return bad('数量は 0 より大きい数で入力してください')
  }
  if (cost_price !== null && !isPrice(cost_price)) return bad('原価は 0 以上の数で入力してください')
  if (selling_price_mode !== 'auto' && selling_price_mode !== 'manual') return bad('売価の決め方の指定が正しくありません')
  if (selling_price_mode === 'manual') {
    if (!isPrice(selling_price)) return bad('売価は 0 以上の数で入力してください')
  } else if (selling_price != null) {
    return bad('掛け率で計算するときは売価を送らないでください')
  }

  return {
    ok: true,
    value: {
      projectId:        project_id.toLowerCase(),
      groupId:          group_id === null ? null : (group_id as string).toLowerCase(),
      masterItemId:     master_item_id.toLowerCase(),
      fingerprint,
      quantity,
      costPrice:        cost_price as number | null,
      sellingPriceMode: selling_price_mode,
      sellingPrice:     selling_price_mode === 'manual' ? (selling_price as number) : null,
    },
  }
}

/** estimate_items に INSERT する行（id・amount・作成日時は DB が決める） */
export type MasterInsertRow = {
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
  vendor_name:          null
  category:             string | null
  row_type:             'item'
  memo:                 null
  internal_memo:        null
  source:               'master'
}

/** マスターの商品と利用者の入力から、INSERT する行を作る */
export function buildMasterItemRow(
  master: MasterItemSource,
  input: Pick<MasterAddRequest, 'quantity' | 'costPrice' | 'sellingPriceMode' | 'sellingPrice'>,
  target: { projectId: string; companyId: string; groupId: string | null; sortOrder: number; projectMarkupRate: number | null | undefined },
): MasterInsertRow {
  return {
    project_id:           target.projectId,
    company_id:           target.companyId,
    group_id:             target.groupId,
    sort_order:           target.sortOrder,
    name:                 master.name,
    quantity:             input.quantity,
    unit:                 master.unit?.trim() ? master.unit : '式',
    cost_price:           input.costPrice,
    selling_price:        resolveMasterSellingPrice(input.sellingPriceMode, input.costPrice, input.sellingPrice, target.projectMarkupRate),
    selling_price_mode:   input.sellingPriceMode,
    markup_rate_override: null,
    vendor_name:          null,
    category:             master.category ?? null,
    row_type:             'item',
    memo:                 null,
    internal_memo:        null,
    source:               'master',
  }
}
