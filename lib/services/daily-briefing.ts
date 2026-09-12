/**
 * lib/services/daily-briefing.ts
 *
 * 「今日やること」の決定論的判定サービス。
 * TodayActionItem[] を生成し、Dashboard と日次ブリーフィング（LINE通知）の両方で使う。
 *
 * ── 設計方針 ────────────────────────────────────────────────────────
 * - 全判定は決定論的ルール（DBクエリ）。AIに判定させない。
 * - recommendedAction はルール側で固定。AIが発明しない。
 * - billing-status.ts の結果を引数で受け取り、二重クエリを避ける。
 * - billing-status.ts が扱わない3ルール（billing_missing/schedule_mismatch/inactive）
 *   をここで追加する。
 *
 * ── 工程未確定ルールの設計制約（重要）──────────────────────────────
 * projects テーブルに着工予定日（DATE型）カラムが存在しない。
 * construction_period カラムは TEXT型（例:「約2ヶ月」）であり日付判定に使えない。
 * そのため「着工が近い AND schedule_items = 0」の判定は現状不可能。
 *
 * 代替ルール（schedule_mismatch）:
 *   status = 'scheduled'（工程作成済みフラグ）かつ schedule_items = 0 件
 *   → ステータスと実データが矛盾している状態のみを対象とする。
 *
 * 将来対応: projects に construction_start_date DATE カラムを追加すれば
 *           「着工7日前 AND schedule_items = 0」の判定が可能になる。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyBillingStatus } from './billing-status'
import { getCompanyBillingStatus } from './billing-status'

// ── 型定義 ───────────────────────────────────────────────────────────

/** 今日やることの種別 */
export type TodayActionType =
  | 'invoice_overdue'       // 請求書：支払期限超過（最高優先）
  | 'invoice_issued_unpaid' // 請求書：発行済み・入金確認待ち
  | 'milestone_overdue'     // 請求スケジュール：期限超過・未入金
  | 'invoice_draft'         // 請求書：下書き→発行が必要
  | 'billing_missing'       // 請求漏れ（請求予定日超過 or 完了案件 なのに請求書なし）
  | 'schedule_mismatch'     // 工程矛盾（status=scheduled なのに工程項目ゼロ）
  | 'inactive'              // 動きなし（7日以上更新なし）

/** 優先度 1=最高 〜 5=最低 */
export type ActionPriority = 1 | 2 | 3 | 4 | 5

export type TodayActionItem = {
  type:              TodayActionType
  priority:          ActionPriority
  projectId:         string
  projectName:       string
  /** 短い状態説明（UIラベル） */
  title:             string
  /** なぜ今日対応が必要か（決定論的文言） */
  reason:            string
  /** 次にすべき具体的アクション（決定論的。AIが発明しない） */
  recommendedAction: string
  /** 直接遷移先 URL */
  actionUrl:         string
}

// ── ルール設定 ────────────────────────────────────────────────────────

const RULE_CONFIG: Record<TodayActionType, {
  priority:          ActionPriority
  recommendedAction: string
}> = {
  invoice_overdue:       { priority: 1, recommendedAction: '顧客に入金確認の連絡をする' },
  invoice_issued_unpaid: { priority: 2, recommendedAction: '入金状況を確認する' },
  milestone_overdue:     { priority: 2, recommendedAction: '請求書を作成して発行する' },
  invoice_draft:         { priority: 3, recommendedAction: '請求書を確認して発行する' },
  billing_missing:       { priority: 3, recommendedAction: '請求書を作成する' },
  schedule_mismatch:     { priority: 4, recommendedAction: '工程を登録する' },
  inactive:              { priority: 5, recommendedAction: '案件状況を確認する' },
}

// ── メイン関数 ────────────────────────────────────────────────────────

/**
 * 「今日やること」アイテム一覧を生成する。
 *
 * @param supabase   呼び出し元が用意した supabase クライアント（RLS有効 or admin）
 * @param billing    事前取得済みの CompanyBillingStatus（省略時は内部で取得）
 * @param companyId  明示的な会社フィルタ（admin クライアント使用時に必須。省略時は RLS に委譲）
 */
export async function getDailyBriefingItems(
  supabase: SupabaseClient,
  billing?: CompanyBillingStatus,
  companyId?: string,
): Promise<TodayActionItem[]> {
  const today = new Date().toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)

  // billing-status の結果を再利用（引数で渡された場合は再クエリしない）
  const billingData = billing ?? await getCompanyBillingStatus(supabase, companyId)

  // ── 追加クエリ構築（companyId がある場合は明示フィルタ）────────────

  let invDocQ = supabase.from('invoice_documents').select('project_id')
  if (companyId) invDocQ = invDocQ.eq('company_id', companyId)

  let overdueMilQ = supabase
    .from('project_billing_milestones')
    .select(`project_id, projects!inner ( id, name, status, deleted_at )`)
    .not('invoice_date', 'is', null)
    .not('invoice_amount', 'is', null)
    .lte('invoice_date', today)
    .is('projects.deleted_at', null)
  if (companyId) overdueMilQ = overdueMilQ.eq('company_id', companyId)

  let doneQ = supabase.from('projects').select('id, name').is('deleted_at', null).eq('status', 'done')
  if (companyId) doneQ = doneQ.eq('company_id', companyId)

  let scheduledQ = supabase.from('projects').select('id, name').is('deleted_at', null).eq('status', 'scheduled')
  if (companyId) scheduledQ = scheduledQ.eq('company_id', companyId)

  let schedItemQ = supabase.from('schedule_items').select('project_id').is('deleted_at', null)
  if (companyId) schedItemQ = schedItemQ.eq('company_id', companyId)

  let inactiveQ = supabase
    .from('projects')
    .select('id, name, updated_at')
    .is('deleted_at', null)
    .neq('status', 'done')
    .lt('updated_at', sevenDaysAgo)
    .order('updated_at', { ascending: true })
    .limit(10)
  if (companyId) inactiveQ = inactiveQ.eq('company_id', companyId)

  // ── 並列実行 ──────────────────────────────────────────────────────
  const [
    invoiceDocProjectsRes,
    overdueMilestoneProjectsRes,
    doneProjectsRes,
    scheduledProjectsRes,
    scheduleItemProjectsRes,
    inactiveRes,
  ] = await Promise.all([
    invDocQ,
    overdueMilQ,
    doneQ,
    scheduledQ,
    schedItemQ,
    inactiveQ,
  ])

  const items: TodayActionItem[] = []

  // ── Rule 1: invoice_overdue（支払期限超過）────────────────────────
  for (const inv of billingData.issued_invoices) {
    if (inv.payment_due_at && inv.payment_due_at < today) {
      const cfg = RULE_CONFIG.invoice_overdue
      items.push({
        type:              'invoice_overdue',
        priority:          cfg.priority,
        projectId:         inv.project_id,
        projectName:       inv.project_name,
        title:             '請求書：支払期限超過',
        reason:            `支払期限 ${inv.payment_due_at} を過ぎています（請求書 ${inv.invoice_number ?? '番号未設定'}）`,
        recommendedAction: cfg.recommendedAction,
        actionUrl:         `/projects/${inv.project_id}`,
      })
    }
  }

  // ── Rule 2: invoice_issued_unpaid（期限内・入金確認待ち）──────────
  for (const inv of billingData.issued_invoices) {
    if (!inv.payment_due_at || inv.payment_due_at >= today) {
      const cfg = RULE_CONFIG.invoice_issued_unpaid
      const dueLine = inv.payment_due_at
        ? `支払期限 ${inv.payment_due_at}`
        : '支払期限未設定'
      items.push({
        type:              'invoice_issued_unpaid',
        priority:          cfg.priority,
        projectId:         inv.project_id,
        projectName:       inv.project_name,
        title:             '請求書：入金確認待ち',
        reason:            `請求書発行済みですが入金が確認されていません（${dueLine}）`,
        recommendedAction: cfg.recommendedAction,
        actionUrl:         `/projects/${inv.project_id}`,
      })
    }
  }

  // ── Rule 3: milestone_overdue（期限超過・未入金）──────────────────
  // 同じ案件に billing_missing が付く場合は除外（請求書作成が最優先）
  // billing_missing 対象 project_id は後で計算するため、ここでは全件追加し後でフィルタ
  const milestoneOverdueItems: TodayActionItem[] = []
  for (const m of billingData.overdue_milestones) {
    const cfg = RULE_CONFIG.milestone_overdue
    milestoneOverdueItems.push({
      type:              'milestone_overdue',
      priority:          cfg.priority,
      projectId:         m.project_id,
      projectName:       m.project_name,
      title:             `請求スケジュール超過：${m.type}`,
      reason:            `請求予定 ${m.invoice_date} から ${m.days_overdue}日超過・未入金`,
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${m.project_id}`,
    })
  }

  // ── Rule 4: invoice_draft（下書き→発行が必要）────────────────────
  // 1案件に複数 draft があっても1件のみ表示
  const draftProjectsSeen = new Set<string>()
  for (const d of billingData.draft_invoices) {
    if (draftProjectsSeen.has(d.project_id)) continue
    draftProjectsSeen.add(d.project_id)
    const cfg = RULE_CONFIG.invoice_draft
    items.push({
      type:              'invoice_draft',
      priority:          cfg.priority,
      projectId:         d.project_id,
      projectName:       d.project_name,
      title:             '請求書：下書きあり（未発行）',
      reason:            '下書き請求書が発行されないままになっています',
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${d.project_id}`,
    })
  }

  // ── Rule 5: billing_missing（請求漏れ）───────────────────────────
  // 請求書（invoice_documents）が1件もない案件に絞る
  const projectsWithInvoice = new Set(
    (invoiceDocProjectsRes.data ?? []).map((r: { project_id: string }) => r.project_id)
  )

  const billingMissingProjects = new Set<string>()

  // Case A: milestone.invoice_date <= today AND no invoice_documents
  type MilestoneRow = {
    project_id: string
    projects: { id: string; name: string; status: string; deleted_at: string | null }
  }
  const seenMilestoneProjects = new Set<string>()
  for (const row of (overdueMilestoneProjectsRes.data ?? []) as unknown as MilestoneRow[]) {
    // skip done projects (Case B handles them)
    if (row.projects.status === 'done') continue
    if (projectsWithInvoice.has(row.project_id)) continue
    if (seenMilestoneProjects.has(row.project_id)) continue
    seenMilestoneProjects.add(row.project_id)
    billingMissingProjects.add(row.project_id)

    const cfg = RULE_CONFIG.billing_missing
    items.push({
      type:              'billing_missing',
      priority:          cfg.priority,
      projectId:         row.project_id,
      projectName:       row.projects.name,
      title:             '請求漏れ：請求書未作成',
      reason:            '請求予定日を過ぎていますが請求書が1件も作成されていません',
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${row.project_id}`,
    })
  }

  // Case B: status='done' AND no invoice_documents
  for (const p of (doneProjectsRes.data ?? []) as Array<{ id: string; name: string }>) {
    if (projectsWithInvoice.has(p.id)) continue
    billingMissingProjects.add(p.id)
    const cfg = RULE_CONFIG.billing_missing
    items.push({
      type:              'billing_missing',
      priority:          cfg.priority,
      projectId:         p.id,
      projectName:       p.name,
      title:             '請求漏れ：完了案件に請求書なし',
      reason:            '案件が完了していますが請求書が1件もありません',
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${p.id}`,
    })
  }

  // milestone_overdue: billing_missing と重複する案件は除外（請求書作成が優先）
  for (const m of milestoneOverdueItems) {
    if (!billingMissingProjects.has(m.projectId)) {
      items.push(m)
    }
  }

  // ── Rule 6: schedule_mismatch（工程矛盾）─────────────────────────
  // status='scheduled' かつ schedule_items = 0
  // ⚠ 設計制約: projects.construction_start_date がないため
  //             「着工が近い AND 工程なし」の判定は不可能。
  //             ステータスと実データの矛盾のみを検出する。
  const projectsWithSchedule = new Set(
    (scheduleItemProjectsRes.data ?? []).map((r: { project_id: string }) => r.project_id)
  )
  for (const p of (scheduledProjectsRes.data ?? []) as Array<{ id: string; name: string }>) {
    if (projectsWithSchedule.has(p.id)) continue
    const cfg = RULE_CONFIG.schedule_mismatch
    items.push({
      type:              'schedule_mismatch',
      priority:          cfg.priority,
      projectId:         p.id,
      projectName:       p.name,
      title:             '工程未登録（状態矛盾）',
      reason:            'ステータスが「工程作成済」ですが工程項目が登録されていません',
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${p.id}`,
    })
  }

  // ── Rule 7: inactive（動きなし7日）───────────────────────────────
  for (const p of (inactiveRes.data ?? []) as Array<{ id: string; name: string; updated_at: string }>) {
    const daysInactive = Math.floor(
      (new Date(today).getTime() - new Date(p.updated_at.slice(0, 10)).getTime()) / 86_400_000
    )
    const cfg = RULE_CONFIG.inactive
    items.push({
      type:              'inactive',
      priority:          cfg.priority,
      projectId:         p.id,
      projectName:       p.name,
      title:             `動きなし（${daysInactive}日）`,
      reason:            `${daysInactive}日以上更新されていません`,
      recommendedAction: cfg.recommendedAction,
      actionUrl:         `/projects/${p.id}`,
    })
  }

  // priority 昇順 → projectName 昇順
  items.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.projectName.localeCompare(b.projectName, 'ja')
  )

  return items
}

// ── ユーティリティ（日次ブリーフィング LINE通知用）─────────────────────

/** 優先度1〜3のアイテムのみ返す（LINE通知で低優先度ノイズを抑える） */
export function filterHighPriorityItems(items: TodayActionItem[]): TodayActionItem[] {
  return items.filter(i => i.priority <= 3)
}

/** 通知すべきかどうか（高・中優先度が1件以上あるか） */
export function shouldNotifyToday(items: TodayActionItem[]): boolean {
  return items.some(i => i.priority <= 3)
}

/**
 * LINE 通知用テキストを決定論的テンプレートで生成する。
 * AI は使わない。Step 4 の AI 要約追加まではこのテンプレートで動作する。
 *
 * 対象: priority 1〜3（高・中）のみ。低優先度（4〜5）は含めない。
 */
export function formatBriefingMessage(
  items: TodayActionItem[],
  jstDateStr: string,  // YYYY-MM-DD
): string {
  const highItems = filterHighPriorityItems(items)
  if (highItems.length === 0) return ''

  // 日付表示（例: 09/13）
  const [, mm, dd] = jstDateStr.split('-')
  const dateLabel = `${mm}/${dd}`

  const lines: string[] = [
    '【現場AI｜今日の要対応】',
    `${dateLabel} 時点`,
    '',
  ]

  highItems.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.projectName}`)
    lines.push(`   ${item.title}`)
    lines.push(`   → ${item.recommendedAction}`)
    if (i < highItems.length - 1) lines.push('')
  })

  lines.push('')
  lines.push(`合計 ${highItems.length}件`)

  return lines.join('\n')
}
