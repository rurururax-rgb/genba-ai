/**
 * チャットエージェント ツール定義 — 型スキーマ
 *
 * 設計方針:
 *  - project_id は API ルート側でセッションから注入する（ツール引数に含めない）
 *  - セキュリティ: getServerClient() (RLS 有効) のみ使用。admin.ts は使わない
 *  - AI は候補・下書きを返すだけ。変更確定は人間（CLAUDE.md 原則）
 *  - status の判定ロジックは tool-executor.ts に集約し、型はここで宣言のみ
 */

// ─────────────────────────────────────────────────────────
// read系ツール引数型
// project_id はサーバー側でセッションから注入するため含めない
// ─────────────────────────────────────────────────────────

export type SearchEstimatesArgs = {
  /** 検索キーワード（品名・規格・備考の断片でも可） */
  query: string
  /** グループIDで絞り込む場合のみ指定（省略可） */
  group_id?: string | null
  /** 返す最大件数（省略時: 10） */
  limit?: number
  /**
   * pg_trgm 類似度の最小値（0〜1）
   * 日本語は文字分割数が少ないため 0.15 前後が妥当
   * 省略時: 0.15
   */
  similarity_threshold?: number
}

export type SearchCatalogArgs = {
  /** 検索キーワード（品名・カテゴリ等） */
  query: string
  /** カテゴリで絞り込む場合のみ指定（省略可） */
  category?: string
  /** 返す最大件数（省略時: 10） */
  limit?: number
  /** pg_trgm 類似度の最小値（省略時: 0.2） */
  similarity_threshold?: number
}

export type SearchCostLedgerArgs = {
  /** 検索キーワード（品名または業者名） */
  query: string
  /** 返す最大件数（省略時: 10） */
  limit?: number
  /** pg_trgm 類似度の最小値（省略時: 0.15） */
  similarity_threshold?: number
}

// ─────────────────────────────────────────────────────────
// write系ツール引数型
// item_id は LLM が search_estimates 等で取得した値を渡す
// project_id / company_id はサーバー側で注入（スキーマに含めない）
// ─────────────────────────────────────────────────────────

export type AddEstimateItemArgs = {
  name: string
  quantity?: number
  unit?: string
  selling_price?: number | null
  group_id?: string | null
  memo?: string | null
}

export type EditEstimateItemArgs = {
  /** search_estimates の best_match.id から取得した値を必ず渡す */
  item_id: string
  name?: string
  quantity?: number
  unit?: string
  selling_price?: number | null
  memo?: string | null
  cost_price?: number | null
  vendor_name?: string | null
}

export type DeleteEstimateItemArgs = {
  /** search_estimates の best_match.id から取得した値を必ず渡す */
  item_id: string
}

export type UpdateCostLedgerArgs = {
  /** search_cost_ledger の best_match.id から取得した値を必ず渡す */
  item_id: string
  budget_cost?: number | null
  actual_cost?: number | null
  vendor_name?: string | null
  note?: string | null
}

export type CopyItemsFromProjectArgs = {
  /** コピー元案件を特定するキーワード（案件名・顧客名・住所の断片） */
  project_keyword: string
  /** コピー対象グループを特定するキーワード（グループ名の断片。省略時はグループ選択をユーザーに委ねる） */
  group_keyword?: string
  /** 追加先グループID（現在の案件。省略時はグループなし） */
  target_group_id?: string | null
}

export type InsertCatalogItemArgs = {
  /** カタログ検索キーワード（品名） */
  catalog_query: string
  /**
   * カタログ品目ID（UUID）。
   * ユーザーが ambiguous 候補から特定品目を選んだとき、AIがここに渡す。
   * 指定された場合は fuzzy 検索をスキップして直接その品目を使う。
   */
  catalog_item_id?: string | null
  /**
   * 追加先グループID（UUID）。
   * search_estimates の結果から group_id が分かっている場合に指定する。
   * 分からない場合は target_group_keyword を使うこと。
   */
  target_group_id?: string | null
  /**
   * 追加先グループ名のキーワード（例: "水回り"）。
   * executor が estimate_groups を検索してグループIDを解決する。
   * target_group_id が指定されている場合はそちらを優先する。
   */
  target_group_keyword?: string | null
  /** 数量（省略時: 1） */
  quantity?: number
}

// ─────────────────────────────────────────────────────────
// write系ヒット型（PendingChangeResult に入れる proposed / original の形）
// ─────────────────────────────────────────────────────────

/**
 * copy_items_from_project の proposed 型（bulk_create で使用）
 * confirm-change が items を一括 INSERT する
 */
export type BulkEstimateItemsWrite = {
  items: EstimateItemWrite[]
  target_group_id: string | null
  project_id: string   // 現在の案件ID（executor が注入）
  company_id: string   // executor が注入
  source_project_name?: string
  source_group_label?: string
}

/** estimate_items の書き込み型（create / update / delete 共用） */
export type EstimateItemWrite = {
  id?: string
  name?: string
  quantity?: number
  unit?: string
  selling_price?: number | null
  amount?: number | null
  memo?: string | null
  cost_price?: number | null
  vendor_name?: string | null
  group_id?: string | null
  project_id?: string
  company_id?: string
}

/** cost_ledger_items の書き込み型 */
export type CostLedgerWrite = {
  id: string
  name?: string
  budget_cost?: number | null
  actual_cost?: number | null
  vendor_name?: string | null
  note?: string | null
}

// ─────────────────────────────────────────────────────────
// 外部資材検索ツール型
// ─────────────────────────────────────────────────────────

export type SearchMaterialWebArgs = {
  /** 検索キーワード（品名・メーカー・型番など） */
  query: string
}

export type AddToMaterialMasterArgs = {
  name: string
  spec?: string | null
  cost_price?: number | null
  selling_price?: number | null
  url?: string | null
  category?: string | null
  unit?: string | null
}

/** Web検索で返ってきた資材候補 */
export type MaterialWebHit = {
  name: string
  model?: string | null
  selling_price?: number | null
  url?: string | null
  source?: string | null
  /** ToolResult 互換のためダミー値 0.5 を持つ */
  _similarity: number
}

/** company_estimate_items への書き込み型 */
export type MaterialMasterWrite = {
  id?: string
  name: string
  spec?: string | null
  cost_price?: number | null
  selling_price?: number | null
  url?: string | null
  category?: string | null
  unit?: string
  company_id?: string
}

// ─────────────────────────────────────────────────────────
// QuickReply — 候補選択ボタン（ambiguous 時・確認質問時）
// ─────────────────────────────────────────────────────────

/**
 * AI が曖昧な候補を返したとき、または yes/no 確認質問をしたとき、
 * ChatPanel に渡すボタン定義。
 * label: ボタン表示テキスト / message: クリック時に自動送信される文字列
 */
export type QuickReply = {
  label: string
  /** クリック時に自動送信されるメッセージ（url が設定されている場合は使わない） */
  message: string
  /** primary: 塗り潰し（推奨選択肢）、default: 枠線のみ */
  variant?: 'primary' | 'default'
  /** 設定時: クリックで新しいタブを開く（message は使わない） */
  url?: string
  /** ボタン右肩に表示する小バッジ（例: 'カタラボ'）。外部ソース識別に使う */
  badge?: string
}

// ─────────────────────────────────────────────────────────
// ConfirmableChange — フロントエンドに返す確定待ち変更情報
// ─────────────────────────────────────────────────────────

/**
 * API route が生成してフロントエンドに返す。
 * ChatPanel がこれをもとに「確定する」「キャンセル」カードを表示する。
 * 「確定する」が押されたとき POST /api/ai/chat/confirm-change に送る。
 */
export type ConfirmableChange = {
  /** クライアント側でのカード追跡用 UUID（サーバーが生成） */
  id: string
  target_table: 'estimate_items' | 'cost_ledger_items' | 'company_estimate_items' | 'invoice_documents'
  change_type: 'create' | 'update' | 'delete' | 'bulk_create'
  diff_summary: string
  proposed: Record<string, unknown>
  original?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────
// 検索ヒットアイテム型
// _similarity は pg_trgm スコア（0〜1）。サーバー内部で判定に使い
// LLM には提示しない（レスポンス JSON から除外推奨）
// ─────────────────────────────────────────────────────────

export type EstimateItemHit = {
  id: string
  name: string
  quantity: number
  unit: string
  selling_price: number | null
  amount: number | null
  /** 内部専用: LLM 出力・顧客向け表示に含めないこと */
  cost_price: number | null
  /** 内部専用: LLM 出力・顧客向け表示に含めないこと */
  vendor_name: string | null
  group_id: string | null
  /** グループ名（JOIN で取得、グループ未所属なら null） */
  group_label: string | null
  source: string
  memo: string | null
  /** pg_trgm スコア（サーバー内部判定用） */
  _similarity: number
}

export type CatalogItemHit = {
  id: string
  name: string
  category: string | null
  unit: string
  cost_price: number | null
  selling_price: number | null
  usage_count: number
  last_used_at: string | null
  _similarity: number
}

export type CostLedgerItemHit = {
  id: string
  name: string
  quantity: number
  unit: string
  estimate_cost: number | null
  budget_cost: number | null
  actual_cost: number | null
  /** 内部専用 */
  vendor_name: string | null
  note: string | null
  /** 紐づく見積項目のID（null = 手動登録） */
  estimate_item_id: string | null
  _similarity: number
}

// ─────────────────────────────────────────────────────────
// 判定定数
// ─────────────────────────────────────────────────────────

/**
 * 1位と2位の similarity 差がこれ未満なら「曖昧」と判定する。
 * 例: 1位=0.42、2位=0.36 → 差=0.06 < 0.1 → ambiguous
 */
export const AMBIGUITY_MARGIN = 0.10

// ─────────────────────────────────────────────────────────
// ツール結果型（汎用ディスクリミネーテッドユニオン）
//
// read系ツール: found / ambiguous / not_found のみ使用
// write系ツール（将来実装）: pending_change も使用
//
// TRead  = 検索ヒット型（EstimateItemHit 等）
// TWrite = 変更提案型（省略時は TRead と同型）
//          write系ツールで差分だけ持つ Partial<T> 等を渡してもよい
// ─────────────────────────────────────────────────────────

/** スコア明確な 1 位が存在する場合 */
type FoundResult<TRead> = {
  status: 'found'
  /** スコア順に並んだアイテム一覧。先頭が最有力 */
  items: TRead[]
  /** best_match を明示して LLM が迷わないよう分離 */
  best_match: TRead
  /**
   * true の場合、limit を超えた候補が存在する可能性がある。
   * LLM は「他にも候補があるかもしれません」と伝えること。
   */
  has_more: boolean
}

/** 上位候補のスコアが拮抗しており、どれが正解か不明な場合 */
type AmbiguousResult<TRead> = {
  status: 'ambiguous'
  candidates: TRead[]
  /**
   * LLM がユーザーに提示する選択肢の案内文。
   * 例: "「ユニットバス交換」と「ユニットバス取付」が近いです。どちらですか？"
   */
  disambiguation_hint: string
}

/** 該当なし */
type NotFoundResult = {
  status: 'not_found'
  /** 元のクエリ（LLM が言い換えを提案するために使う） */
  query: string
  /**
   * 言い換え・絞り込みのヒント（省略可）。
   * 将来: company_synonyms テーブルから生成
   */
  suggestions?: string[]
  hint?: string
}

/**
 * 未確定変更（write系ツール専用 — read系では status: 'pending_change' を返さない）
 *
 * AI が変更を即実行せず「叩き台」として返す。
 * ユーザーが確認ボタンを押して初めて実際の書き込みが走る設計。
 * これにより「AIは整理係・判断者は人間」の原則を型レベルで強制する。
 */
type PendingChangeResult<TWrite> = {
  status: 'pending_change'
  proposed: TWrite
  change_type: 'create' | 'update' | 'delete' | 'bulk_create'
  /**
   * 人間が読める変更の要約（必須）。
   * 例: "「外壁塗装 一式」の単価を ¥380,000 → ¥420,000 に変更します"
   */
  diff_summary: string
  confirmation_required: true
  /** update / delete の場合のみ: 変更前の値 */
  original?: TWrite
  /** confirm-change エンドポイントがどのテーブルを操作するかを識別する */
  target_table: 'estimate_items' | 'cost_ledger_items' | 'company_estimate_items' | 'invoice_documents'
}

/** ツール結果の汎用ユニオン型 */
export type ToolResult<TRead, TWrite = TRead> =
  | FoundResult<TRead>
  | AmbiguousResult<TRead>
  | NotFoundResult
  | PendingChangeResult<TWrite>

/** read系ツール固有の結果型エイリアス */
export type SearchEstimatesResult  = ToolResult<EstimateItemHit>
export type SearchCatalogResult    = ToolResult<CatalogItemHit>
export type SearchCostLedgerResult = ToolResult<CostLedgerItemHit>

/** write系ツール固有の結果型エイリアス */
export type AddEstimateItemResult          = ToolResult<EstimateItemWrite>
export type EditEstimateItemResult         = ToolResult<EstimateItemWrite>
export type DeleteEstimateItemResult       = ToolResult<EstimateItemWrite>
export type UpdateCostLedgerResult         = ToolResult<CostLedgerWrite>
export type CopyItemsFromProjectResult     = ToolResult<BulkEstimateItemsWrite>
export type InsertCatalogItemResult        = ToolResult<EstimateItemWrite>

// ─────────────────────────────────────────────────────────
// ユーティリティ: status の型ガード
// ─────────────────────────────────────────────────────────

export function isFound<T>(r: ToolResult<T>): r is FoundResult<T> {
  return r.status === 'found'
}
export function isAmbiguous<T>(r: ToolResult<T>): r is AmbiguousResult<T> {
  return r.status === 'ambiguous'
}
export function isNotFound<T>(r: ToolResult<T>): r is NotFoundResult {
  return r.status === 'not_found'
}
export function isPendingChange<T>(r: ToolResult<T>): r is PendingChangeResult<T> {
  return r.status === 'pending_change'
}

// ─────────────────────────────────────────────────────────
// ユーティリティ: サーバー側で results を分類する共通関数
// ─────────────────────────────────────────────────────────

/**
 * pg_trgm で取得したヒット列を ToolResult に変換する。
 *
 * 判定ロジック:
 *   0件          → not_found
 *   1件          → found（best_match = items[0]）
 *   複数、かつ
 *     上位2件の similarity 差 >= AMBIGUITY_MARGIN → found（明確な1位あり）
 *     上位2件の similarity 差 <  AMBIGUITY_MARGIN → ambiguous
 *
 * @param items  pg_trgm スコア降順に並んでいることを前提とする
 * @param query  元の検索クエリ（not_found 時に格納）
 * @param limit  呼び出し時の上限値（has_more 判定に使う）
 */
export function classifySearchResults<T extends { _similarity: number }>(
  items: T[],
  query: string,
  limit: number,
): ToolResult<T> {
  if (items.length === 0) {
    return {
      status: 'not_found',
      query,
      hint: '検索ワードを短くするか、別の表記でお試しください。',
    }
  }

  if (items.length === 1) {
    return {
      status: 'found',
      items,
      best_match: items[0],
      has_more: false,
    }
  }

  const topScore    = items[0]._similarity
  const secondScore = items[1]._similarity
  const margin      = topScore - secondScore

  if (margin >= AMBIGUITY_MARGIN) {
    return {
      status: 'found',
      items,
      best_match: items[0],
      has_more: items.length >= limit,
    }
  }

  // スコアが拮抗 → 曖昧
  return {
    status: 'ambiguous',
    candidates: items,
    disambiguation_hint:
      `「${query}」に近い候補が${items.length}件見つかりました。` +
      `どれを参照しますか？`,
  }
}
