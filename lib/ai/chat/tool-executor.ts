/**
 * チャットエージェント ツール実行レイヤー
 *
 * - getServerClient()（RLS有効）のみ使用。admin.ts は不使用
 * - project_id / company_id は呼び出し元（route.ts）がセッションから注入
 * - 各関数は ToolResult<T> を返し、route.ts が serializeToolResult() で文字列化する
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifySearchResults,
  isFound,
  type SearchEstimatesArgs,
  type SearchCatalogArgs,
  type SearchCostLedgerArgs,
  type AddEstimateItemArgs,
  type EditEstimateItemArgs,
  type DeleteEstimateItemArgs,
  type UpdateCostLedgerArgs,
  type CopyItemsFromProjectArgs,
  type InsertCatalogItemArgs,
  type SearchMaterialWebArgs,
  type AddToMaterialMasterArgs,
  type SearchEstimatesResult,
  type SearchCatalogResult,
  type SearchCostLedgerResult,
  type AddEstimateItemResult,
  type EditEstimateItemResult,
  type DeleteEstimateItemResult,
  type UpdateCostLedgerResult,
  type CopyItemsFromProjectResult,
  type InsertCatalogItemResult,
  type MaterialWebHit,
  type MaterialMasterWrite,
  type EstimateItemHit,
  type CatalogItemHit,
  type CostLedgerItemHit,
  type EstimateItemWrite,
  type BulkEstimateItemsWrite,
  type CostLedgerWrite,
  type ConfirmableChange,
  type QuickReply,
  type ToolResult,
} from './types'
import {
  TOOL_NAME,
  PROJECT_SCOPED_TOOLS,
  COMPANY_SCOPED_TOOLS,
  serializeToolResult,
} from './tool-schemas'
import {
  getCompanyProjectSummary,
  getProjectSummaryDetail,
  listCompanyProjects,
} from '@/lib/services/company-summary'
import { getCompanyBillingStatus } from '@/lib/services/billing-status'

// ─────────────────────────────────────────────────────────
// 実行コンテキスト（route.ts から渡される認証済み情報）
// ─────────────────────────────────────────────────────────

export type ExecutorContext = {
  /**
   * 現在開いている案件ID（URL から取得）。
   * null の場合は「会社全体モード」: company-scoped ツールのみ使用可能。
   */
  projectId: string | null
  /** 認証ユーザーの所属会社ID（company_members から取得） */
  companyId: string
  /** RLS 有効な Supabase クライアント（getServerClient() の戻り値） */
  supabase: SupabaseClient
}

// ─────────────────────────────────────────────────────────
// ① search_estimates
// ─────────────────────────────────────────────────────────

export async function executeSearchEstimates(
  args: SearchEstimatesArgs,
  ctx: ExecutorContext,
): Promise<SearchEstimatesResult> {
  const limit     = Math.min(args.limit ?? 10, 30)
  const threshold = args.similarity_threshold ?? 0.15

  const { data, error } = await ctx.supabase.rpc('search_estimate_items', {
    p_project_id: ctx.projectId,
    p_query:      args.query,
    p_limit:      limit,
    p_threshold:  threshold,
    p_group_id:   args.group_id ?? null,
  })

  if (error) {
    console.error('[search_estimates] RPC error:', error.message)
    return {
      status: 'not_found',
      query: args.query,
      hint: 'データベースエラーが発生しました。別のキーワードをお試しください。',
    }
  }

  return classifySearchResults<EstimateItemHit>(
    (data ?? []) as EstimateItemHit[],
    args.query,
    limit,
  )
}

// ─────────────────────────────────────────────────────────
// ② search_catalog
// ─────────────────────────────────────────────────────────

export async function executeSearchCatalog(
  args: SearchCatalogArgs,
  ctx: ExecutorContext,
): Promise<SearchCatalogResult> {
  const limit     = Math.min(args.limit ?? 10, 30)
  const threshold = args.similarity_threshold ?? 0.20

  const { data, error } = await ctx.supabase.rpc('search_catalog_items', {
    p_company_id: ctx.companyId,
    p_query:      args.query,
    p_limit:      limit,
    p_threshold:  threshold,
    p_category:   args.category ?? null,
  })

  if (error) {
    console.error('[search_catalog] RPC error:', error.message)
    return {
      status: 'not_found',
      query: args.query,
      hint: 'データベースエラーが発生しました。別のキーワードをお試しください。',
    }
  }

  return classifySearchResults<CatalogItemHit>(
    (data ?? []) as CatalogItemHit[],
    args.query,
    limit,
  )
}

// ─────────────────────────────────────────────────────────
// ③ search_cost_ledger
// ─────────────────────────────────────────────────────────

export async function executeSearchCostLedger(
  args: SearchCostLedgerArgs,
  ctx: ExecutorContext,
): Promise<SearchCostLedgerResult> {
  const limit     = Math.min(args.limit ?? 10, 30)
  const threshold = args.similarity_threshold ?? 0.15

  const { data, error } = await ctx.supabase.rpc('search_cost_ledger_items', {
    p_project_id: ctx.projectId,
    p_query:      args.query,
    p_limit:      limit,
    p_threshold:  threshold,
  })

  if (error) {
    console.error('[search_cost_ledger] RPC error:', error.message)
    return {
      status: 'not_found',
      query: args.query,
      hint: 'データベースエラーが発生しました。別のキーワードをお試しください。',
    }
  }

  return classifySearchResults<CostLedgerItemHit>(
    (data ?? []) as CostLedgerItemHit[],
    args.query,
    limit,
  )
}

// ─────────────────────────────────────────────────────────
// write系ツール
// DB への書き込みは行わず PendingChangeResult を返す
// ─────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined) =>
  v != null ? `¥${v.toLocaleString('ja-JP')}` : '未設定'

// ── ④ add_estimate_item ───────────────────────────────────

export async function executeAddEstimateItem(
  args: AddEstimateItemArgs,
  ctx: ExecutorContext,
): Promise<AddEstimateItemResult> {
  const proposed: EstimateItemWrite = {
    name:          args.name,
    quantity:      args.quantity ?? 1,
    unit:          args.unit ?? '式',
    selling_price: args.selling_price ?? null,
    group_id:      args.group_id ?? null,
    memo:          args.memo ?? null,
    // サーバー注入（confirm-change で使用）
    project_id: ctx.projectId ?? undefined,
    company_id: ctx.companyId,
  }

  const priceStr = args.selling_price != null ? fmt(args.selling_price) : '単価未設定'
  const diff_summary =
    `「${args.name}」（${proposed.quantity}${proposed.unit}、${priceStr}）を見積に追加します`

  return {
    status: 'pending_change',
    change_type: 'create',
    target_table: 'estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed,
  }
}

// ── ⑤ edit_estimate_item ──────────────────────────────────

export async function executeEditEstimateItem(
  args: EditEstimateItemArgs,
  ctx: ExecutorContext,
): Promise<EditEstimateItemResult> {
  // 現在の値を取得して original に入れる
  const { data: current, error } = await ctx.supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, selling_price, amount, memo, cost_price, vendor_name, group_id, project_id')
    .eq('id', args.item_id)
    .is('deleted_at', null)
    .single()

  if (error || !current) {
    return { status: 'not_found', query: args.item_id, hint: '指定されたIDの見積項目が見つかりません。' }
  }
  // 念のためプロジェクト確認（RLS が通っても他案件を防ぐ）
  if (current.project_id !== ctx.projectId) {
    return { status: 'not_found', query: args.item_id, hint: 'この案件の見積項目ではありません。' }
  }

  // 変更するフィールドだけを proposed に入れる
  const proposed: EstimateItemWrite = { id: args.item_id }
  if (args.name          !== undefined) proposed.name          = args.name
  if (args.quantity      !== undefined) proposed.quantity      = args.quantity
  if (args.unit          !== undefined) proposed.unit          = args.unit
  if (args.selling_price !== undefined) proposed.selling_price = args.selling_price
  if (args.memo          !== undefined) proposed.memo          = args.memo
  if (args.cost_price    !== undefined) proposed.cost_price    = args.cost_price
  if (args.vendor_name   !== undefined) proposed.vendor_name   = args.vendor_name

  // diff_summary（変更フィールドを列挙）
  const LABELS: Record<string, string> = {
    name: '品名', quantity: '数量', unit: '単位',
    selling_price: '単価', memo: '備考',
    cost_price: '原価', vendor_name: '業者名',
  }
  const changes = Object.entries(proposed)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => {
      const prev = (current as Record<string, unknown>)[k]
      const label = LABELS[k] ?? k
      if (k === 'selling_price' || k === 'cost_price') {
        return `${label} ${fmt(prev as number)} → ${fmt(v as number)}`
      }
      return `${label} 「${prev ?? '—'}」→「${v ?? '—'}」`
    })
    .join('、')

  const diff_summary = `「${current.name}」の${changes || '内容'}を変更します`

  return {
    status: 'pending_change',
    change_type: 'update',
    target_table: 'estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed,
    original: {
      id:            current.id,
      name:          current.name,
      quantity:      current.quantity,
      unit:          current.unit,
      selling_price: current.selling_price,
      amount:        current.amount,
      memo:          current.memo,
      cost_price:    current.cost_price,
      vendor_name:   current.vendor_name,
    },
  }
}

// ── ⑥ delete_estimate_item ───────────────────────────────

export async function executeDeleteEstimateItem(
  args: DeleteEstimateItemArgs,
  ctx: ExecutorContext,
): Promise<DeleteEstimateItemResult> {
  const { data: current, error } = await ctx.supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, selling_price, amount, project_id')
    .eq('id', args.item_id)
    .is('deleted_at', null)
    .single()

  if (error || !current) {
    return { status: 'not_found', query: args.item_id, hint: '指定されたIDの見積項目が見つかりません。' }
  }
  if (current.project_id !== ctx.projectId) {
    return { status: 'not_found', query: args.item_id, hint: 'この案件の見積項目ではありません。' }
  }

  const diff_summary =
    `「${current.name}」（${fmt(current.selling_price)}）を見積から削除します`

  return {
    status: 'pending_change',
    change_type: 'delete',
    target_table: 'estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed: { id: args.item_id },
    original: {
      id:            current.id,
      name:          current.name,
      quantity:      current.quantity,
      unit:          current.unit,
      selling_price: current.selling_price,
      amount:        current.amount,
    },
  }
}

// ── ⑦ update_cost_ledger ─────────────────────────────────

export async function executeUpdateCostLedger(
  args: UpdateCostLedgerArgs,
  ctx: ExecutorContext,
): Promise<UpdateCostLedgerResult> {
  const { data: current, error } = await ctx.supabase
    .from('cost_ledger_items')
    .select('id, name, budget_cost, actual_cost, vendor_name, note, project_id')
    .eq('id', args.item_id)
    .is('deleted_at', null)
    .single()

  if (error || !current) {
    return { status: 'not_found', query: args.item_id, hint: '指定されたIDの原価台帳項目が見つかりません。' }
  }
  if (current.project_id !== ctx.projectId) {
    return { status: 'not_found', query: args.item_id, hint: 'この案件の原価台帳項目ではありません。' }
  }

  const proposed: CostLedgerWrite = { id: args.item_id }
  if (args.budget_cost !== undefined) proposed.budget_cost = args.budget_cost
  if (args.actual_cost !== undefined) proposed.actual_cost = args.actual_cost
  if (args.vendor_name !== undefined) proposed.vendor_name = args.vendor_name
  if (args.note        !== undefined) proposed.note        = args.note

  const LABELS: Record<string, string> = {
    budget_cost: '実行予算', actual_cost: '実績原価',
    vendor_name: '業者名', note: 'メモ',
  }
  const changes = Object.entries(proposed)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => {
      const prev = (current as Record<string, unknown>)[k]
      const label = LABELS[k] ?? k
      if (k === 'budget_cost' || k === 'actual_cost') {
        return `${label} ${fmt(prev as number)} → ${fmt(v as number)}`
      }
      return `${label} 「${prev ?? '—'}」→「${v ?? '—'}」`
    })
    .join('、')

  const diff_summary = `「${current.name}」の${changes || '内容'}を更新します`

  return {
    status: 'pending_change',
    change_type: 'update',
    target_table: 'cost_ledger_items',
    diff_summary,
    confirmation_required: true,
    proposed,
    original: {
      id:          current.id,
      name:        current.name,
      budget_cost: current.budget_cost,
      actual_cost: current.actual_cost,
      vendor_name: current.vendor_name,
      note:        current.note,
    },
  }
}

// ── ⑧ copy_items_from_project ────────────────────────────

export async function executeCopyItemsFromProject(
  args: CopyItemsFromProjectArgs,
  ctx: ExecutorContext,
): Promise<CopyItemsFromProjectResult> {
  // ① 案件を検索（自社内のみ — RLS が保証）
  const keyword = `%${args.project_keyword}%`
  const { data: projects, error: pErr } = await ctx.supabase
    .from('projects')
    .select('id, name, customer_name, site_address')
    .eq('company_id', ctx.companyId)
    .is('deleted_at', null)
    .or(`name.ilike.${keyword},customer_name.ilike.${keyword},site_address.ilike.${keyword}`)
    .limit(6)

  if (pErr || !projects?.length) {
    return {
      status: 'not_found',
      query: args.project_keyword,
      hint: '一致する案件が見つかりませんでした。案件名・顧客名・住所のキーワードで検索します。別のキーワードをお試しください。',
    }
  }

  // 現在の案件は除外
  const candidates = projects.filter(p => p.id !== ctx.projectId)
  if (!candidates.length) {
    return {
      status: 'not_found',
      query: args.project_keyword,
      hint: '現在開いている案件以外に一致する案件が見つかりませんでした。',
    }
  }

  // 複数案件が候補→曖昧扱いで選ばせる
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: candidates.map(p => ({
        id: p.id,
        name: p.name,
        customer_name: p.customer_name,
        site_address: p.site_address,
        // classifySearchResults 互換にするため _similarity を付与
        _similarity: 0.5,
      })) as unknown as BulkEstimateItemsWrite[],
      disambiguation_hint:
        `「${args.project_keyword}」に一致する案件が${candidates.length}件あります。` +
        `どの案件からコピーしますか？\n` +
        candidates.map((p, i) => `${i + 1}. ${p.name}（${p.customer_name ?? p.site_address ?? '詳細なし'}）`).join('\n'),
    }
  }

  const srcProject = candidates[0]

  // ② グループを検索
  const { data: groups, error: gErr } = await ctx.supabase
    .from('estimate_groups')
    .select('id, label, sort_order')
    .eq('project_id', srcProject.id)
    .is('deleted_at', null)
    .order('sort_order')

  if (gErr || !groups?.length) {
    return {
      status: 'not_found',
      query: args.project_keyword,
      hint: `「${srcProject.name}」にはグループが存在しません。`,
    }
  }

  // group_keyword で絞り込み
  let targetGroups = groups
  if (args.group_keyword) {
    const kw = args.group_keyword.toLowerCase()
    targetGroups = groups.filter(g => g.label.toLowerCase().includes(kw))
    if (!targetGroups.length) {
      return {
        status: 'not_found',
        query: args.group_keyword,
        hint:
          `「${srcProject.name}」に「${args.group_keyword}」に一致するグループがありません。` +
          `存在するグループ: ${groups.map(g => `「${g.label}」`).join('、')}`,
      }
    }
    if (targetGroups.length > 1) {
      return {
        status: 'ambiguous',
        candidates: targetGroups.map(g => ({
          id: g.id, name: g.label, _similarity: 0.5,
        })) as unknown as BulkEstimateItemsWrite[],
        disambiguation_hint:
          `「${args.group_keyword}」に一致するグループが${targetGroups.length}件あります。` +
          `どのグループをコピーしますか？\n` +
          targetGroups.map((g, i) => `${i + 1}. ${g.label}`).join('\n'),
      }
    }
  } else if (groups.length > 1) {
    // group_keyword 未指定かつ複数グループ → リスト提示
    return {
      status: 'ambiguous',
      candidates: groups.map(g => ({
        id: g.id, name: g.label, _similarity: 0.5,
      })) as unknown as BulkEstimateItemsWrite[],
      disambiguation_hint:
        `「${srcProject.name}」に${groups.length}件のグループがあります。` +
        `どのグループをコピーしますか？\n` +
        groups.map((g, i) => `${i + 1}. ${g.label}`).join('\n'),
    }
  }

  const srcGroup = targetGroups[0]

  // ③ グループ内の明細を取得
  const { data: srcItems, error: iErr } = await ctx.supabase
    .from('estimate_items')
    .select('name, quantity, unit, selling_price, cost_price, vendor_name, memo')
    .eq('project_id', srcProject.id)
    .eq('group_id', srcGroup.id)
    .is('deleted_at', null)
    .order('sort_order')

  if (iErr || !srcItems?.length) {
    return {
      status: 'not_found',
      query: srcGroup.label,
      hint: `「${srcGroup.label}」に明細項目が存在しません。`,
    }
  }

  const proposed: BulkEstimateItemsWrite = {
    items: srcItems.map(it => ({
      name:          it.name,
      quantity:      it.quantity,
      unit:          it.unit,
      selling_price: it.selling_price,
      cost_price:    it.cost_price,
      vendor_name:   it.vendor_name,
      memo:          it.memo,
    })),
    target_group_id:    args.target_group_id ?? null,
    project_id:         ctx.projectId!,  // project-scoped ツールなので必ず非null
    company_id:         ctx.companyId,
    source_project_name: srcProject.name,
    source_group_label:  srcGroup.label,
  }

  const totalAmt = srcItems.reduce((acc, it) => acc + (it.selling_price ?? 0) * (it.quantity ?? 1), 0)
  const diff_summary =
    `「${srcProject.name}」の「${srcGroup.label}」から${srcItems.length}件をコピーします` +
    (totalAmt ? `（合計参考 ¥${totalAmt.toLocaleString('ja-JP')}）` : '')

  return {
    status: 'pending_change',
    change_type: 'bulk_create',
    target_table: 'estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed,
  }
}

// ── ⑨ insert_catalog_item ────────────────────────────────

export async function executeInsertCatalogItem(
  args: InsertCatalogItemArgs,
  ctx: ExecutorContext,
): Promise<InsertCatalogItemResult> {
  // ─── グループIDの解決 ────────────────────────────────────
  // グループは必須ではない。見つからない・曖昧な場合は null で進み、
  // 担当者が見積エディタ上でドラッグ&ドロップで移動してもらう。
  let resolvedGroupId: string | null = args.target_group_id ?? null
  let resolvedGroupLabel: string | null = null

  if (!resolvedGroupId && args.target_group_keyword) {
    const kw = args.target_group_keyword.trim()

    const { data: groups } = await ctx.supabase
      .from('estimate_groups')
      .select('id, label')
      .eq('project_id', ctx.projectId)
      .is('deleted_at', null)
      .ilike('label', `%${kw}%`)
      .order('sort_order')
      .limit(5)

    if (groups && groups.length > 0) {
      // 複数ヒットしても先頭を使う（止めない）
      resolvedGroupId    = groups[0].id
      resolvedGroupLabel = groups[0].label ?? null
    }
    // グループが見つからない場合は null のまま継続（エラーにしない）
  }

  // ─── カタログ検索（ID指定時は直接ルックアップ） ──────────────
  let cat: CatalogItemHit

  if (args.catalog_item_id) {
    // ユーザーが候補ボタンから特定品目を選んだケース → fuzzy検索をスキップ
    const { data: row, error: idErr } = await ctx.supabase
      .from('company_estimate_items')
      .select('id, name, category, unit, cost_price, selling_price, usage_count, last_used_at')
      .eq('id', args.catalog_item_id)
      .eq('company_id', ctx.companyId)
      .single()

    if (idErr || !row) {
      return { status: 'not_found', query: args.catalog_query, hint: '指定された品目が見つかりませんでした。' }
    }
    cat = { ...(row as CatalogItemHit), _similarity: 1.0 }
  } else {
    // 通常の fuzzy 検索
    const limit     = 10
    const threshold = 0.20

    const { data, error } = await ctx.supabase.rpc('search_catalog_items', {
      p_company_id: ctx.companyId,
      p_query:      args.catalog_query,
      p_limit:      limit,
      p_threshold:  threshold,
      p_category:   null,
    })

    if (error) {
      return { status: 'not_found', query: args.catalog_query, hint: 'カタログ検索でエラーが発生しました。' }
    }

    const hits = (data ?? []) as CatalogItemHit[]
    const classified = classifySearchResults<CatalogItemHit>(hits, args.catalog_query, limit)

    // not_found / ambiguous はそのまま返す（LLM がユーザーに提示する）
    if (!isFound(classified)) {
      return classified as unknown as InsertCatalogItemResult
    }

    // found でも複数件ある場合はユーザーに候補選択させる（最大4件）
    if (classified.items.length > 1) {
      const top4      = classified.items.slice(0, 4)
      const remaining = classified.items.length - top4.length
      const hint =
        `「${args.catalog_query}」に近いカタログ品目が${classified.items.length}件見つかりました。` +
        `どれを見積に追加しますか？` +
        (remaining > 0 ? `（他に${remaining}件）` : '')
      return {
        status: 'ambiguous',
        candidates: top4 as unknown as EstimateItemWrite[],
        disambiguation_hint: hint,
      }
    }

    cat = classified.best_match
  }

  // ─── cat 確定後の共通処理 ──────────────────────────────────
  const qty      = args.quantity ?? 1
  const grpLabel = resolvedGroupLabel ?? (resolvedGroupId ? resolvedGroupId : 'グループなし')

  const proposed: EstimateItemWrite = {
    name:          cat.name,
    quantity:      qty,
    unit:          cat.unit,
    selling_price: cat.selling_price,
    cost_price:    cat.cost_price,
    group_id:      resolvedGroupId,
    project_id:    ctx.projectId ?? undefined,
    company_id:    ctx.companyId,
  }

  const diff_summary =
    `カタログ「${cat.name}」（${qty}${cat.unit}、${fmt(cat.selling_price)}）を` +
    (resolvedGroupId ? `「${grpLabel}」グループに追加します` : 'グループなしで追加します（後で移動可）')

  return {
    status: 'pending_change',
    change_type: 'create',
    target_table: 'estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed,
  }
}

// ── ⑩ search_material_web ────────────────────────────────
//
// Brave Search API で catalabo.org を直接検索し、建材情報を返す。
// - DB への永続化なし（その場で検索して返すだけ）
// - Claude API を使わないため高速・低コスト

const KATALABO_DOMAINS = ['catalabo.org', 'app.icata.net'] as const

export async function executeSearchMaterialWeb(
  args: SearchMaterialWebArgs,
): Promise<ToolResult<MaterialWebHit>> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) {
    console.error('[search_material_web] BRAVE_SEARCH_API_KEY not set')
    return { status: 'not_found', query: args.query, hint: 'Web検索の設定が不完全です。管理者にお問い合わせください。' }
  }

  const q = `site:catalabo.org ${args.query}`
  let data: Record<string, unknown>
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
      {
        headers: {
          'Accept':               'application/json',
          'X-Subscription-Token': apiKey,
        },
      },
    )
    if (!res.ok) {
      console.error('[search_material_web] Brave API error:', res.status)
      return { status: 'not_found', query: args.query, hint: 'Web検索でエラーが発生しました。' }
    }
    data = await res.json() as Record<string, unknown>
  } catch (e) {
    console.error('[search_material_web] fetch error:', e)
    return { status: 'not_found', query: args.query, hint: 'Web検索でエラーが発生しました。' }
  }

  type BraveResult = { title?: string; url?: string; description?: string }
  const rawResults = ((data.web as Record<string, unknown> | undefined)?.results ?? []) as BraveResult[]

  // catalabo.org / app.icata.net 以外を除外
  const katalabResults = rawResults.filter(r => {
    if (!r.url) return false
    try {
      const host = new URL(r.url).hostname
      return KATALABO_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
    } catch { return false }
  })

  if (katalabResults.length === 0) {
    return { status: 'not_found', query: args.query, hint: 'カタラボで該当する資材が見つかりませんでした。別のキーワードをお試しください。' }
  }

  const hits: MaterialWebHit[] = katalabResults.map(r => ({
    // タイトルからサイト名サフィックス（「| 【カタラボ】…」）を除去して品名に使う
    name:          (r.title ?? '').replace(/\s*[|｜]\s*【?カタラボ.*$/, '').trim() || '不明',
    model:         null,
    selling_price: null,
    url:           r.url ?? null,
    source:        'カタラボ',
    _similarity:   0.5,
  }))

  return {
    status:     'found',
    items:      hits,
    best_match: hits[0],
    has_more:   hits.length >= 5,
  }
}

// ── ⑪ add_to_material_master ─────────────────────────────

export async function executeAddToMaterialMaster(
  args: AddToMaterialMasterArgs,
  ctx: ExecutorContext,
): Promise<ToolResult<MaterialMasterWrite>> {
  const proposed: MaterialMasterWrite = {
    name:          args.name,
    spec:          args.spec ?? null,
    selling_price: args.selling_price ?? null,
    cost_price:    args.cost_price ?? null,
    url:           args.url ?? null,
    category:      args.category ?? null,
    unit:          args.unit ?? '式',
    company_id:    ctx.companyId,
  }

  const priceStr = args.selling_price != null ? fmt(args.selling_price) : '単価未設定'
  const specPart = args.spec ? `（${args.spec}）` : ''
  const diff_summary =
    `「${args.name}」${specPart}（${priceStr}）を資材マスターに登録します`

  return {
    status: 'pending_change',
    change_type: 'create',
    target_table: 'company_estimate_items',
    diff_summary,
    confirmation_required: true,
    proposed,
  }
}

// ─────────────────────────────────────────────────────────
// DispatchResult 型（route.ts が pending_change / suggestions を収集するために使う）
// ─────────────────────────────────────────────────────────

export type DispatchResult = {
  /** Claude API の tool_result content に渡す JSON 文字列 */
  serialized: string
  /** write系ツールが返した PendingChange 情報（read系は undefined） */
  pending?: Omit<ConfirmableChange, 'id'>
  /** ambiguous 時にフロントエンドで候補ボタンを表示するためのリスト */
  suggestions?: QuickReply[]
}

// ─────────────────────────────────────────────────────────
// 候補ボタン生成ヘルパー
// ─────────────────────────────────────────────────────────

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

/** 資材マスター登録ボタン用のメッセージを生成 */
function buildRegistrationMessage(c: Record<string, unknown>): string {
  const name  = (c.name as string) ?? '不明'
  const parts: string[] = []
  if (c.model)         parts.push(`型番: ${c.model}`)
  if (c.spec)          parts.push(`仕様: ${c.spec}`)
  if (c.selling_price) parts.push(`参考単価: ¥${(c.selling_price as number).toLocaleString('ja-JP')}`)
  if (c.url)           parts.push(`URL: ${c.url}`)
  const detail = parts.length > 0 ? `（${parts.join('、')}）` : ''
  return `「${name}」${detail}を資材マスターに登録してください`
}

/**
 * Web 検索結果（カタラボ）用ボタン生成
 * - URL あり → タップで新しいタブを開くリンクボタン（badge: 'カタラボ'）
 * - URL なし → テキスト選択ボタン
 * 詳細テーブルはチャットに出さず、ボタンに集約する
 */
function buildMaterialWebSuggestions(items: Array<Record<string, unknown>>): QuickReply[] {
  return items.slice(0, 4).map((c) => {
    const name  = (c.name  as string | null) ?? '不明'
    const model = (c.model as string | null) ?? null
    const url   = (c.url   as string | null) ?? null
    const label = model ? `${name}（${model}）` : name

    if (url) {
      return {
        label,
        message: `「${name}」を選択します`,  // URL ボタンでは使わない（フォールバック）
        url,
        badge: 'カタラボ',
      } satisfies QuickReply
    }
    return {
      label,
      message: `「${name}」を選択します`,
      badge: 'カタラボ',
    } satisfies QuickReply
  })
}

/**
 * ambiguous ツール結果用の候補ボタン生成
 * - 最大 4 件を選択ボタンとして表示
 * - 超過分は「他にN件」ボタンで通知
 */
function buildSuggestions(
  candidates: Array<Record<string, unknown>>,
  toolName: string,
): QuickReply[] {
  const top4      = candidates.slice(0, 4)
  const remaining = candidates.length - top4.length

  const suggestions: QuickReply[] = top4.map((c, i) => {
    const id    = (c.id            as string | null) ?? null
    const name  = (c.name          as string | null) ?? `候補${i + 1}`
    const price = (c.selling_price as number | null) ?? null
    const priceStr = price != null
      ? `（¥${price.toLocaleString('ja-JP')}）`
      : ''
    // INSERT_CATALOG_ITEM の場合は catalog_item_id をメッセージに埋め込んで
    // 再検索ループを防ぐ（AIが catalog_item_id として抽出して直接ルックアップする）
    const message = toolName === TOOL_NAME.INSERT_CATALOG_ITEM && id
      ? `「${name}」を見積に追加して [catalog_id:${id}]`
      : toolName === TOOL_NAME.INSERT_CATALOG_ITEM
      ? `「${name}」を見積に追加して`
      : `「${name}」を選択します`
    return {
      label:   `${CIRCLED[i] ?? `${i + 1}.`} ${name}${priceStr}`,
      message,
    }
  })

  if (remaining > 0) {
    suggestions.push({
      label:   `他に${remaining}件あります`,
      message: 'もっと候補を見せてください',
      variant: 'default',
    })
  }

  return suggestions
}

// ─────────────────────────────────────────────────────────
// ディスパッチャー
// ─────────────────────────────────────────────────────────

type AnyHit = EstimateItemHit | CatalogItemHit | CostLedgerItemHit | EstimateItemWrite | BulkEstimateItemsWrite | CostLedgerWrite | MaterialWebHit | MaterialMasterWrite

export async function dispatchTool(
  toolName: string,
  toolInput: unknown,
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  let result: ToolResult<AnyHit>

  // ── スコープ保護 ────────────────────────────────────────
  // 会社全体モード（projectId = null）で project-scoped ツールを呼ぼうとした場合は拒否
  if (ctx.projectId === null && PROJECT_SCOPED_TOOLS.has(toolName)) {
    return {
      serialized: JSON.stringify({
        status: 'error',
        message: `ツール "${toolName}" は案件詳細画面でのみ使用できます。会社全体の情報には list_projects_status / get_project_summary 等を使ってください。`,
      }),
    }
  }
  // project-scoped モードで company-scoped ツールを呼ぼうとした場合も拒否
  if (ctx.projectId !== null && COMPANY_SCOPED_TOOLS.has(toolName)) {
    return {
      serialized: JSON.stringify({
        status: 'error',
        message: `ツール "${toolName}" は案件一覧画面の「AIに相談」からのみ使用できます。`,
      }),
    }
  }

  switch (toolName) {
    // ── project-scoped ──────────────────────────────────
    case TOOL_NAME.SEARCH_ESTIMATES:
      result = await executeSearchEstimates(toolInput as SearchEstimatesArgs, ctx)
      break
    case TOOL_NAME.SEARCH_CATALOG:
      result = await executeSearchCatalog(toolInput as SearchCatalogArgs, ctx)
      break
    case TOOL_NAME.SEARCH_COST_LEDGER:
      result = await executeSearchCostLedger(toolInput as SearchCostLedgerArgs, ctx)
      break
    case TOOL_NAME.SEARCH_MATERIAL_WEB:
      result = await executeSearchMaterialWeb(toolInput as SearchMaterialWebArgs) as ToolResult<AnyHit>
      break
    case TOOL_NAME.ADD_ESTIMATE_ITEM:
      result = await executeAddEstimateItem(toolInput as AddEstimateItemArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.EDIT_ESTIMATE_ITEM:
      result = await executeEditEstimateItem(toolInput as EditEstimateItemArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.DELETE_ESTIMATE_ITEM:
      result = await executeDeleteEstimateItem(toolInput as DeleteEstimateItemArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.UPDATE_COST_LEDGER:
      result = await executeUpdateCostLedger(toolInput as UpdateCostLedgerArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.COPY_ITEMS_FROM_PROJECT:
      result = await executeCopyItemsFromProject(toolInput as CopyItemsFromProjectArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.INSERT_CATALOG_ITEM:
      result = await executeInsertCatalogItem(toolInput as InsertCatalogItemArgs, ctx) as ToolResult<AnyHit>
      break
    case TOOL_NAME.ADD_TO_MATERIAL_MASTER:
      result = await executeAddToMaterialMaster(toolInput as AddToMaterialMasterArgs, ctx) as ToolResult<AnyHit>
      break

    // ── company-scoped ──────────────────────────────────
    case TOOL_NAME.LIST_PROJECTS_STATUS:
      return executeListProjectsStatus(toolInput as { status_filter?: string }, ctx)
    case TOOL_NAME.GET_PROJECT_SUMMARY:
      return executeGetProjectSummary(toolInput as { project_id: string }, ctx)
    case TOOL_NAME.GET_INVOICE_STATUS:
      return executeGetInvoiceStatus(toolInput as { project_id: string }, ctx)
    case TOOL_NAME.GET_UNPAID_MILESTONES:
      return executeGetUnpaidMilestones(toolInput as { overdue_only?: boolean }, ctx)
    case TOOL_NAME.CREATE_INVOICE_DRAFT:
      return executeCreateInvoiceDraft(toolInput as { project_id: string; note?: string }, ctx)

    default:
      result = {
        status: 'not_found',
        query: toolName,
        hint: `未知のツール "${toolName}" は使用できません。`,
      }
  }

  const serialized = serializeToolResult(result as ToolResult<AnyHit>)

  // search_material_web: found でも ambiguous でも候補ボタンを生成
  if (toolName === TOOL_NAME.SEARCH_MATERIAL_WEB) {
    const items =
      result.status === 'found'
        ? (result.items as Array<Record<string, unknown>>)
        : result.status === 'ambiguous'
        ? (result.candidates as Array<Record<string, unknown>>)
        : []
    if (items.length > 0) {
      return { serialized, suggestions: buildMaterialWebSuggestions(items) }
    }
    return { serialized }
  }

  // ambiguous の場合、候補ボタンを生成して返す
  if (result.status === 'ambiguous') {
    const candidates = result.candidates as Array<Record<string, unknown>>
    return {
      serialized,
      suggestions: buildSuggestions(candidates, toolName),
    }
  }

  // pending_change の場合、route.ts が ConfirmableChange に変換できるよう中身を返す
  if (result.status === 'pending_change') {
    return {
      serialized,
      pending: {
        target_table: result.target_table,
        change_type:  result.change_type,
        diff_summary: result.diff_summary,
        proposed:     result.proposed as Record<string, unknown>,
        original:     result.original as Record<string, unknown> | undefined,
      },
    }
  }

  return { serialized }
}

// ─────────────────────────────────────────────────────────
// 会社全体モード ツール実装（company-scoped）
// ─────────────────────────────────────────────────────────

// C1: 全案件一覧
async function executeListProjectsStatus(
  args: { status_filter?: string },
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  const rows = await listCompanyProjects(ctx.supabase, args.status_filter)
  return {
    serialized: JSON.stringify({
      status: 'found',
      count: rows.length,
      projects: rows,
    }),
  }
}

// C2: 特定案件サマリー
async function executeGetProjectSummary(
  args: { project_id: string },
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  // project_id が自社案件であることを DB 側（RLS）で保証
  const detail = await getProjectSummaryDetail(ctx.supabase, args.project_id, ctx.companyId)
  if (!detail) {
    return {
      serialized: JSON.stringify({
        status: 'not_found',
        message: '指定された案件が見つかりません。自社の案件IDを指定してください。',
      }),
    }
  }
  return {
    serialized: JSON.stringify({
      status:         'found',
      project_status: detail.status,
      project_id:     detail.project_id,
      project_name:   detail.project_name,
      customer_name:  detail.customer_name,
      site_address:   detail.site_address,
      estimate_total: detail.estimate_total,
      milestone_total: detail.milestone_total,
      paid_total:     detail.paid_total,
      unpaid_total:   detail.unpaid_total,
      milestones:     detail.milestones,
    }),
  }
}

// C3: 請求書ステータス
async function executeGetInvoiceStatus(
  args: { project_id: string },
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  // まず案件が自社のものか確認（RLS で担保されるが明示的にも確認）
  const { data: project } = await ctx.supabase
    .from('projects')
    .select('id, name')
    .eq('id', args.project_id)
    .is('deleted_at', null)
    .single()

  if (!project) {
    return {
      serialized: JSON.stringify({
        status: 'not_found',
        message: '指定された案件が見つかりません。',
      }),
    }
  }

  const { data: invoices } = await ctx.supabase
    .from('invoice_documents')
    .select('id, status, printed_at, created_at, updated_at')
    .eq('project_id', args.project_id)
    .order('updated_at', { ascending: false })

  return {
    serialized: JSON.stringify({
      status: 'found',
      project_id:   project.id,
      project_name: project.name,
      invoices: (invoices ?? []).map(inv => ({
        id:         inv.id,
        status:     inv.status,
        printed_at: inv.printed_at,
        created_at: inv.created_at,
        updated_at: inv.updated_at,
      })),
    }),
  }
}

// C4: 請求・入金状況（billing_milestones + invoice_documents の統合ビュー）
async function executeGetUnpaidMilestones(
  args: { overdue_only?: boolean },
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  const billing = await getCompanyBillingStatus(ctx.supabase)

  const milestones = args.overdue_only
    ? billing.overdue_milestones
    : billing.unpaid_milestones

  return {
    serialized: JSON.stringify({
      status: 'found',

      // ── 支払いスケジュール（project_billing_milestones）────────
      // milestone_unset_count > 0 かつ unpaid_count = 0 でも「入金済み」ではない
      milestone_unset_count:   billing.milestone_unset_count,
      milestone_unpaid_count:  billing.unpaid_milestones.length,
      milestone_overdue_count: billing.overdue_milestones.length,
      total_unpaid_amount:     billing.total_unpaid_amount,
      overdue_only_amount:     billing.overdue_only_amount,
      milestones,

      // ── 発行済み請求書（invoice_documents）────────────────────
      // status='issued' は発行済みだが入金未確認。paid になるまで入金確認はできない。
      invoice_draft_count:  billing.draft_invoices.length,
      invoice_issued_count: billing.issued_invoices.length,
      issued_invoices: billing.issued_invoices.map(i => ({
        project_id:     i.project_id,
        project_name:   i.project_name,
        invoice_number: i.invoice_number,
        issued_at:      i.issued_at,
        payment_due_at: i.payment_due_at,
      })),
      invoice_paid_count: billing.paid_invoice_count,

      // ── 解釈ガイド（AI向け）─────────────────────────────────
      interpretation_guide: [
        'milestone_unset_count > 0: 支払いスケジュールが未設定の行がある（未入金でも入金済みでもない）',
        'milestone_unpaid_count = 0 でも invoice_issued_count > 0 なら「発行済み・入金確認待ち」がある',
        'invoice_documents.status = issued は入金確認が取れていないことを意味する',
        '「すべて入金済み」と断定できるのは milestone全入金 かつ invoice全paidの場合のみ',
      ],
    }),
  }
}

// C5: 請求書下書き作成の提案（Pending Change）
async function executeCreateInvoiceDraft(
  args: { project_id: string; note?: string },
  ctx: ExecutorContext,
): Promise<DispatchResult> {
  // 案件が自社のものか RLS + 明示的確認
  const { data: project } = await ctx.supabase
    .from('projects')
    .select('id, name, customer_name')
    .eq('id', args.project_id)
    .is('deleted_at', null)
    .single()

  if (!project) {
    return {
      serialized: JSON.stringify({
        status: 'error',
        message: '指定された案件が見つかりません。自社の案件IDを指定してください。',
      }),
    }
  }

  // 既存の draft/issued 請求書確認（二重作成防止の事前チェック）
  const { data: existing } = await ctx.supabase
    .from('invoice_documents')
    .select('id, status')
    .eq('project_id', args.project_id)
    .in('status', ['draft', 'issued'])
    .limit(1)

  if (existing && existing.length > 0) {
    return {
      serialized: JSON.stringify({
        status: 'error',
        message: `案件「${project.name}」には既に請求書（${existing[0].status}）が存在します。新規作成はできません。`,
      }),
    }
  }

  // Pending Change として提案（この時点では DB 書き込みをしない）
  const proposed = {
    project_id:    args.project_id,
    project_name:  project.name,
    customer_name: project.customer_name,
    status:        'draft',
    memo:          args.note ?? null,   // DB カラム名は memo
  }

  return {
    serialized: JSON.stringify({
      status: 'pending_change',
      change_type:  'create',
      diff_summary: `案件「${project.name}」に請求書の下書きを作成します。`,
      proposed,
      confirmation_required: true,
      message:      'この請求書下書きを作成してよいですか？確認後に適用されます。',
    }),
    pending: {
      target_table: 'invoice_documents',
      change_type:  'create',
      diff_summary: `案件「${project.name}」に請求書の下書きを作成します。`,
      proposed:     proposed as Record<string, unknown>,
      original:     undefined,
    },
  }
}
