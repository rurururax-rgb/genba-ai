/**
 * lib/services/company-summary.ts
 *
 * 会社全体の業務サマリーを取得するサービス関数。
 * 「要対応」の判定はLLMに任せず、ここで決定論的に計算する。
 *
 * 使用箇所:
 *   - /api/projects/summary (Dashboard API)
 *   - lib/ai/chat/tool-executor.ts (AI Tool: get_unpaid_milestones 等)
 *
 * セキュリティ: 呼び出し元が getServerClient() で取得した supabase を渡す。
 *   RLS が有効なため company_id フィルタは DB 側で自動的に適用される。
 *
 * ── データソース設計メモ ────────────────────────────────────────
 *
 * ① project_billing_milestones: 支払いスケジュール管理テーブル
 *    - 案件ごとに 契約金/着工金/中間金/完工金 の4行が自動生成される
 *    - invoice_date / invoice_amount: 請求予定日・請求予定額
 *    - payment_date / payment_amount: 実際の入金日・入金額
 *    - 「請求済みだが未入金」= invoice_date IS NOT NULL
 *                              AND invoice_amount IS NOT NULL
 *                              AND payment_date IS NULL
 *
 * ② invoice_documents: 顧客向け正式請求書ドキュメント
 *    - items（JSONB）・invoice_number・payment_due_at 等を持つ
 *    - status: 'draft' | 'issued' | 'paid'
 *    - ① との直接 FK は存在しない（project_id のみが共通キー）
 *    - Phase 2 では JOIN しない。独立して集計する。
 *
 * ── total_unpaid_amount の定義 ──────────────────────────────────
 *
 * total_unpaid_amount = 「請求済みだが未入金」の milestone 合計額
 *   = invoice_date IS NOT NULL AND invoice_amount IS NOT NULL
 *     AND payment_date IS NULL の invoice_amount 合計
 *
 * ※ 将来の請求予定（invoice_date が未来）も含む。
 *    「遅延分のみ」は overdue_milestones で別途管理。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getCompanyBillingStatus } from './billing-status'

// ── 型定義 ────────────────────────────────────────────────

/** 未入金マイルストーン（請求日設定済み、金額設定済み、入金未完了） */
export type UnpaidMilestone = {
  milestone_id:   string
  project_id:     string
  project_name:   string
  type:           string       // 契約金 / 着工金 / 中間金 / 完工金
  invoice_date:   string       // ISO date string (YYYY-MM-DD)
  invoice_amount: number
  is_overdue:     boolean      // invoice_date が今日より前
  days_overdue:   number       // is_overdue = true のとき日数。それ以外は 0
}

/** draft ステータスの invoice_documents がある案件 */
export type DraftInvoice = {
  project_id:    string
  project_name:  string
  invoice_count: number
}

/** issued ステータスで未入金の invoice_documents がある案件 */
export type IssuedUnpaidInvoice = {
  project_id:   string
  project_name: string
}

export type CompanySummary = {
  /** 進行中案件数（status != 'done'） */
  active_projects:       number
  /**
   * 請求済みだが未入金の合計（invoice_date + invoice_amount が設定され payment_date がない milestones の合計）
   * ※ 将来の請求予定分を含む。遅延分のみは overdue_milestones を参照。
   */
  total_unpaid_amount:   number
  /** 遅延分のみ（invoice_date < today かつ未入金） */
  overdue_only_amount:   number
  /** 未入金マイルストーン一覧（請求日設定済み）。遅延の大きい順にソート済み */
  unpaid_milestones:     UnpaidMilestone[]
  /** overdue のみ（unpaid_milestones の部分集合。後方互換性のために残す） */
  overdue_milestones:    UnpaidMilestone[]
  /** 下書き請求書がある案件 */
  draft_invoices:        DraftInvoice[]
  /** 正式発行済み（issued）だが paid になっていない案件 */
  issued_unpaid_invoices: IssuedUnpaidInvoice[]
}

// ── メイン集計関数（billing-status.ts に委譲）────────────────────

export async function getCompanyProjectSummary(
  supabase: SupabaseClient
): Promise<CompanySummary> {
  const billing = await getCompanyBillingStatus(supabase)

  // billing-status の型を Dashboard 向けの CompanySummary に変換
  const draftMap = new Map<string, DraftInvoice>()
  for (const inv of billing.draft_invoices) {
    const existing = draftMap.get(inv.project_id)
    if (existing) existing.invoice_count++
    else draftMap.set(inv.project_id, {
      project_id:    inv.project_id,
      project_name:  inv.project_name,
      invoice_count: 1,
    })
  }

  const issuedUnpaidMap = new Map<string, IssuedUnpaidInvoice>()
  for (const inv of billing.issued_invoices) {
    if (!issuedUnpaidMap.has(inv.project_id)) {
      issuedUnpaidMap.set(inv.project_id, {
        project_id:   inv.project_id,
        project_name: inv.project_name,
      })
    }
  }

  return {
    active_projects:       billing.active_projects,
    total_unpaid_amount:   billing.total_unpaid_amount,
    overdue_only_amount:   billing.overdue_only_amount,
    unpaid_milestones:     billing.unpaid_milestones.map(m => ({
      milestone_id:   m.milestone_id,
      project_id:     m.project_id,
      project_name:   m.project_name,
      type:           m.type,
      invoice_date:   m.invoice_date!,
      invoice_amount: m.invoice_amount!,
      is_overdue:     m.is_overdue,
      days_overdue:   m.days_overdue,
    })),
    overdue_milestones:    billing.overdue_milestones.map(m => ({
      milestone_id:   m.milestone_id,
      project_id:     m.project_id,
      project_name:   m.project_name,
      type:           m.type,
      invoice_date:   m.invoice_date!,
      invoice_amount: m.invoice_amount!,
      is_overdue:     m.is_overdue,
      days_overdue:   m.days_overdue,
    })),
    draft_invoices:         [...draftMap.values()],
    issued_unpaid_invoices: [...issuedUnpaidMap.values()],
  }
}

// ── 案件個別サマリー（AI Tool用）────────────────────────────

export type ProjectSummaryDetail = {
  project_id:      string
  project_name:    string
  status:          string
  customer_name:   string | null
  site_address:    string | null
  estimate_total:  number
  milestone_total: number   // 請求予定額合計（invoice_amount の合計）
  paid_total:      number   // 入金済み合計（payment_amount の合計）
  unpaid_total:    number   // 未入金合計（請求日設定済みのみ）
  milestones: Array<{
    type:           string
    invoice_date:   string | null
    invoice_amount: number | null
    payment_date:   string | null
    payment_amount: number | null
  }>
}

export async function getProjectSummaryDetail(
  supabase: SupabaseClient,
  projectId: string,
  companyId: string
): Promise<ProjectSummaryDetail | null> {

  const [projectRes, estimateRes, milestonesRes] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, status, customer_name, site_address')
      .eq('id', projectId)
      .is('deleted_at', null)
      .single(),

    supabase
      .from('estimate_items')
      .select('amount')
      .eq('project_id', projectId)
      .is('deleted_at', null),

    supabase
      .from('project_billing_milestones')
      .select('type, invoice_date, invoice_amount, payment_date, payment_amount')
      .eq('project_id', projectId)
      .order('sort_order'),
  ])

  if (!projectRes.data) return null

  // company_id 確認（RLS に加えて明示的に検証）
  const { data: authUser } = await supabase.auth.getUser()
  if (!authUser.user) return null

  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', authUser.user.id)
    .single()

  if (!member || member.company_id !== companyId) return null

  const estimate_total = (estimateRes.data ?? []).reduce(
    (s: number, i: { amount: number | null }) => s + (i.amount ?? 0), 0
  )
  const milestones = (milestonesRes.data ?? []) as Array<{
    type: string
    invoice_date: string | null
    invoice_amount: number | null
    payment_date: string | null
    payment_amount: number | null
  }>

  // milestone_total: invoice_amount が設定済みの合計
  const milestone_total = milestones.reduce((s, m) => s + (m.invoice_amount ?? 0), 0)
  const paid_total      = milestones.reduce((s, m) => s + (m.payment_amount ?? 0), 0)
  // unpaid_total: 請求日設定済みで未入金のもの
  const unpaid_total    = milestones
    .filter(m => m.invoice_date !== null && m.invoice_amount !== null && m.payment_date === null)
    .reduce((s, m) => s + (m.invoice_amount ?? 0), 0)

  return {
    project_id:     projectRes.data.id,
    project_name:   projectRes.data.name,
    status:         projectRes.data.status,
    customer_name:  projectRes.data.customer_name,
    site_address:   projectRes.data.site_address,
    estimate_total,
    milestone_total,
    paid_total,
    unpaid_total,
    milestones,
  }
}

// ── 全案件一覧（AI Tool用）────────────────────────────────

export type ProjectStatusRow = {
  project_id:    string
  name:          string
  status:        string
  customer_name: string | null
  updated_at:    string
}

export async function listCompanyProjects(
  supabase: SupabaseClient,
  statusFilter?: string
): Promise<ProjectStatusRow[]> {
  let query = supabase
    .from('projects')
    .select('id, name, status, customer_name, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(50)

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  }

  const { data } = await query
  return (data ?? []).map((p: { id: string; name: string; status: string; customer_name: string | null; updated_at: string }) => ({
    project_id:    p.id,
    name:          p.name,
    status:        p.status,
    customer_name: p.customer_name,
    updated_at:    p.updated_at,
  }))
}
