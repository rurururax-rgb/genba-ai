/**
 * lib/services/billing-status.ts
 *
 * 請求・入金状態の定義と、両テーブルを統合した会社全体の請求状況サービス。
 *
 * ── 状態定義（DB根拠）──────────────────────────────────────────────
 *
 * 【project_billing_milestones ベースの状態】
 *   未設定（不明）  : invoice_date = null AND invoice_amount = null
 *                     ※「入金済み」ではない。請求スケジュールが未登録なだけ。
 *   請求予定        : invoice_date IS NOT NULL AND invoice_date > today AND payment_date IS NULL
 *   請求済み・未入金: invoice_date IS NOT NULL AND invoice_date <= today AND payment_date IS NULL
 *   遅延（超過）    : 上記かつ invoice_date < today（days_overdue > 0）
 *   入金済み        : payment_date IS NOT NULL
 *
 * 【invoice_documents ベースの状態】
 *   下書き          : status = 'draft'
 *   発行済み・入金確認待ち : status = 'issued'
 *                     ※ paid への遷移まで入金確認はできない。「入金済み」ではない。
 *   入金確認済み    : status = 'paid'
 *
 * ── 重要な原則 ──────────────────────────────────────────────────────
 *
 * milestone の invoice_date = null は「入金済み」を意味しない。
 * 「請求スケジュールが未設定」を意味する。
 *
 * invoice_documents.status = 'issued' は「請求書を発行したが入金は未確認」を意味する。
 * milestone_unpaid_count = 0 であっても issued invoice があれば未回収リスクがある。
 *
 * DashboardとAI Toolは同じ getCompanyBillingStatus() を使うことで整合を保証する。
 *
 * 取得に失敗したときは集計を返さず BillingFetchError を投げる（呼び出し側で「取得できなかった」と示す）。
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ── 状態ラベル（表示・AI向け） ────────────────────────────────────

/** milestone の1行の請求状態 */
export type MilestoneState =
  | 'unset'     // invoice_date = null（未設定・スケジュール未登録）
  | 'scheduled' // 請求予定（invoice_date が未来）
  | 'unpaid'    // 請求済み・未入金（期限内）
  | 'overdue'   // 請求済み・未入金（期限超過）
  | 'paid'      // 入金済み（payment_date あり）

/** invoice_documents 1件の状態 */
export type InvoiceDocState =
  | 'draft'   // 下書き
  | 'issued'  // 発行済み・入金確認待ち
  | 'paid'    // 入金確認済み

// ── 型定義 ──────────────────────────────────────────────────────────

export type MilestoneStatus = {
  milestone_id:   string
  project_id:     string
  project_name:   string
  type:           string    // 契約金 / 着工金 / 中間金 / 完工金
  state:          MilestoneState
  invoice_date:   string | null
  invoice_amount: number | null
  payment_date:   string | null
  is_overdue:     boolean
  days_overdue:   number    // is_overdue = false のとき 0
}

export type InvoiceDocStatus = {
  invoice_id:   string
  project_id:   string
  project_name: string
  state:        InvoiceDocState
  invoice_number: string | null
  customer_name:  string | null
  issued_at:      string | null   // 発行日
  payment_due_at: string | null   // 支払期限
}

/** 会社全体の請求状況（DashboardとAI Toolが共用する単一の真実） */
export type CompanyBillingStatus = {
  // ── project_billing_milestones ───────────────────────────
  /** milestone 未設定（invoice_date = null）の件数 */
  milestone_unset_count:    number
  /** 未入金 milestone（invoice_date 設定済み、payment_date なし） */
  unpaid_milestones:        MilestoneStatus[]
  /** そのうち遅延（invoice_date < today） */
  overdue_milestones:       MilestoneStatus[]
  /** milestone 合計未入金額 */
  total_unpaid_amount:      number
  /** milestone 遅延分のみの合計 */
  overdue_only_amount:      number

  // ── invoice_documents ───────────────────────────────────
  /** 下書き請求書 */
  draft_invoices:           InvoiceDocStatus[]
  /**
   * 発行済み・入金確認待ち請求書
   * ⚠ status='issued' は「入金確認済み」ではない。
   * 入金確認は status='paid' への変更で初めて完了する。
   */
  issued_invoices:          InvoiceDocStatus[]
  /** 入金確認済み請求書（status='paid'）件数 */
  paid_invoice_count:       number

  // ── 統合サマリー ─────────────────────────────────────────
  /** 進行中案件数 */
  active_projects:          number
  /**
   * 入金が確認できていない状態が1件以上ある（要対応の目安）
   * = unpaid_milestones.length > 0 OR issued_invoices.length > 0 OR draft_invoices.length > 0
   */
  has_pending_billing:      boolean
}

// ── 内部型 ───────────────────────────────────────────────────────────

type RawMilestone = {
  id:             string
  project_id:     string
  company_id:     string | null
  type:           string
  invoice_date:   string | null
  invoice_amount: number | null
  payment_date:   string | null
  projects:       EmbeddedProject | null
}

type RawInvoice = {
  id:             string
  project_id:     string
  company_id:     string | null
  invoice_number: string | null
  customer_name:  string | null
  status:         string
  issued_at:      string | null
  payment_due_at: string | null
  projects:       EmbeddedProject | null
}

type EmbeddedProject = { id: string; name: string; company_id: string | null; deleted_at: string | null }

// ── 取得失敗の扱い ───────────────────────────────────────────────────

/**
 * 請求・入金の情報を DB から取得できなかったことを表す。
 *
 * 取得エラーを `data ?? []` で 0 件として扱うと、「未入金なし」「請求書なし」と誤って表示・通知してしまう
 * （KI-003: 外部キーが増えて PostgREST の埋め込みがあいまいになったときなど）。集計を返さずにこれを投げる。
 * message には取得元とエラーコードだけを入れる（顧客データ・接続情報を含めない）。
 */
export class BillingFetchError extends Error {
  constructor(readonly source: string, readonly code: string) {
    super(`billing fetch failed: ${source} (${code})`)
    this.name = 'BillingFetchError'
  }
}

/** エラーコードは英数字の短いものだけを残す（PostgREST の PGRST201、PostgreSQL の SQLSTATE など） */
function safeErrorCode(code: unknown): string {
  return typeof code === 'string' && /^[A-Z0-9]{1,16}$/.test(code) ? code : 'unknown'
}

/** 取得結果にエラーがあれば、安全なコードだけをログに出して BillingFetchError を投げる */
export function assertBillingFetched(source: string, res: { error: { code?: string } | null }): void {
  if (!res.error) return
  const code = safeErrorCode(res.error.code)
  console.error('[billing] fetch failed', { source, code })
  throw new BillingFetchError(source, code)
}

/**
 * 行に埋め込んだ案件が、行と同じ会社（companyId 指定時はその会社）のものか。
 *
 * project_billing_milestones / invoice_documents の RLS は行の company_id しか見ず、project_id の外部キー検査は
 * RLS を通らないため、「company_id = 自社・project_id = 他社の案件」という行を作れてしまう（KI-002）。
 * admin クライアント（朝のブリーフィング）は RLS を通らないので、そのまま埋め込むと他社の案件名を取得してしまう。
 * 案件名を使う前に必ずこれで確かめ、合わない行は捨てる。
 */
export function isOwnCompanyProjectRow<T extends { company_id: string | null; projects: { company_id: string | null } | null }>(
  row: T,
  companyId?: string,
): row is T & { projects: NonNullable<T['projects']> } {
  if (row.company_id == null || row.projects == null) return false
  if (row.projects.company_id !== row.company_id) return false
  return companyId == null || row.company_id === companyId
}

// ── メイン関数（DashboardとAI Toolが共用） ────────────────────────────

/**
 * @param supabase   呼び出し元が用意した supabase クライアント
 * @param companyId  明示的な会社フィルタ（admin クライアント使用時に必須。省略時は RLS に委譲）
 */
export async function getCompanyBillingStatus(
  supabase: SupabaseClient,
  companyId?: string,
): Promise<CompanyBillingStatus> {
  const today = new Date().toISOString().slice(0, 10)

  // ── クエリ構築（companyId がある場合は明示フィルタ、なければ RLS に委譲）──

  let activeQuery = supabase
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .neq('status', 'done')
  if (companyId) activeQuery = activeQuery.eq('company_id', companyId)

  // 案件の埋め込みには既存の単独外部キー名をヒントに付ける。PR-3（20261014000001）で同じ 2 テーブル間に
  // 複合外部キーが増え、ヒントが無いと PostgREST があいまい（PGRST201）として拒否するため（KI-003）
  let milestonesQuery = supabase
    .from('project_billing_milestones')
    .select(`
      id, project_id, company_id, type,
      invoice_date, invoice_amount,
      payment_date,
      projects!project_billing_milestones_project_id_fkey!inner ( id, name, company_id, deleted_at )
    `)
    .is('projects.deleted_at', null)
  // 行だけでなく埋め込む案件も対象会社に絞る（取得後も isOwnCompanyProjectRow で確かめる）
  if (companyId) milestonesQuery = milestonesQuery.eq('company_id', companyId).eq('projects.company_id', companyId)

  let invoicesQuery = supabase
    .from('invoice_documents')
    .select(`
      id, project_id, company_id,
      invoice_number, customer_name,
      status, issued_at, payment_due_at,
      projects!invoice_documents_project_id_fkey!inner ( id, name, company_id, deleted_at )
    `)
    .in('status', ['draft', 'issued', 'paid'])
    .is('projects.deleted_at', null)
  if (companyId) invoicesQuery = invoicesQuery.eq('company_id', companyId).eq('projects.company_id', companyId)

  const [activeRes, milestonesRes, invoicesRes] = await Promise.all([
    activeQuery,
    milestonesQuery,
    invoicesQuery,
  ])

  // 取得に失敗したら 0 件として集計しない（未入金なし・請求書なしと誤って伝えない）
  assertBillingFetched('active_projects', activeRes)
  assertBillingFetched('milestones', milestonesRes)
  assertBillingFetched('invoices', invoicesRes)

  const active_projects = activeRes.count ?? 0

  // ── milestone 状態分類 ──────────────────────────────────

  const allMilestones = ((milestonesRes.data ?? []) as unknown as RawMilestone[])
    .filter(m => isOwnCompanyProjectRow(m, companyId))

  let milestone_unset_count = 0
  const unpaid_milestones: MilestoneStatus[] = []
  let total_unpaid_amount = 0
  let overdue_only_amount = 0

  for (const m of allMilestones) {
    if (!m.invoice_date || m.invoice_amount == null) {
      milestone_unset_count++
      continue
    }
    if (m.payment_date != null) {
      // 入金済み → カウントのみ（unpaid には入れない）
      continue
    }
    // 未入金（invoice_date あり、payment_date なし）
    const isOverdue  = m.invoice_date < today
    const daysOverdue = isOverdue
      ? Math.floor(
          (new Date(today).getTime() - new Date(m.invoice_date).getTime()) / 86_400_000,
        )
      : 0
    const state: MilestoneState = isOverdue ? 'overdue' : m.invoice_date > today ? 'scheduled' : 'unpaid'

    total_unpaid_amount += m.invoice_amount
    if (isOverdue) overdue_only_amount += m.invoice_amount

    unpaid_milestones.push({
      milestone_id:   m.id,
      project_id:     m.project_id,
      project_name:   m.projects.name,
      type:           m.type,
      state,
      invoice_date:   m.invoice_date,
      invoice_amount: m.invoice_amount,
      payment_date:   null,
      is_overdue:     isOverdue,
      days_overdue:   daysOverdue,
    })
  }

  // 遅延の大きい順 → 残りは invoice_date 昇順
  unpaid_milestones.sort((a, b) => {
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1
    return b.days_overdue - a.days_overdue
  })

  const overdue_milestones = unpaid_milestones.filter(m => m.is_overdue)

  // ── invoice_documents 状態分類 ──────────────────────────

  const allInvoices = ((invoicesRes.data ?? []) as unknown as RawInvoice[])
    .filter(inv => isOwnCompanyProjectRow(inv, companyId))

  const draft_invoices:  InvoiceDocStatus[] = []
  const issued_invoices: InvoiceDocStatus[] = []
  let   paid_invoice_count = 0

  for (const inv of allInvoices) {
    const base: InvoiceDocStatus = {
      invoice_id:     inv.id,
      project_id:     inv.project_id,
      project_name:   inv.projects.name,
      state:          inv.status as InvoiceDocState,
      invoice_number: inv.invoice_number,
      customer_name:  inv.customer_name,
      issued_at:      inv.issued_at,
      payment_due_at: inv.payment_due_at,
    }
    if (inv.status === 'draft')  draft_invoices.push(base)
    else if (inv.status === 'issued') issued_invoices.push(base)
    else if (inv.status === 'paid')   paid_invoice_count++
  }

  const has_pending_billing =
    unpaid_milestones.length > 0 ||
    issued_invoices.length > 0 ||
    draft_invoices.length > 0

  return {
    milestone_unset_count,
    unpaid_milestones,
    overdue_milestones,
    total_unpaid_amount,
    overdue_only_amount,
    draft_invoices,
    issued_invoices,
    paid_invoice_count,
    active_projects,
    has_pending_billing,
  }
}
