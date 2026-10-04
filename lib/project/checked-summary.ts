import type { SupabaseClient } from '@supabase/supabase-js'
import { executeGetEstimateTotal } from '@/lib/ai/chat/estimate-total'

/**
 * 案件画面「RAGZが確認しました」の 3 項目（見積・請求・次の工程）。
 *
 * - 確定した事実だけを返す。業務判断（請求漏れ・遅延・注意など）はしない
 * - 取得に失敗した項目は null（画面では「—」）。0円・未作成などに読み替えて推測しない
 * - すべて RLS 有効なクライアントで読む（service_role は使わない）
 */

export type BillingFact = '未作成' | '下書きあり' | '発行済み' | '入金済み' | '作成済み'

export type NextScheduleFact = { name: string; start_date: string }

/**
 * 工程の表示事実。
 * - current: 今日が開始日〜終了日に入っている工程（完了にしたものは除く）。others は同じく施工期間中の残り件数
 * - next:    施工期間中の工程がないときの、今日以降で最も近い工程
 */
export type ScheduleFact =
  | { kind: 'current'; name: string; start_date: string; end_date: string; others: number }
  | { kind: 'next'; name: string; start_date: string }

export type CheckedSummary = {
  /** 税込合計。見積画面と同じ共有計算（calculateEstimateTotals）の結果。取得失敗時は null */
  estimateTotal: number | null
  /** 見積明細の行数。0 なら「見積なし」。取得失敗時は null */
  estimateItemCount: number | null
  /** 最新の請求書の状態。取得失敗時は null */
  billing: BillingFact | null
  /** 施工期間中の工程、なければ今日以降で最も近い工程。工程なし・取得失敗時は null */
  schedule: ScheduleFact | null
}

/** 最新の請求書（invoice_documents.status）を事実ラベルへ。status の意味は既存定義（draft / issued / paid）のまま */
export function toBillingFact(latest: { status: string | null } | null | undefined): BillingFact {
  if (!latest) return '未作成'
  switch (latest.status) {
    case 'draft':  return '下書きあり'
    case 'issued': return '発行済み'
    case 'paid':   return '入金済み'
    default:       return '作成済み'
  }
}

/**
 * 請求の表示文言。発行済みの請求書に支払期限が入っていれば日付を添える（例: 発行済み（支払期限 9/3））。
 * 期限超過などの判断語は付けない
 */
export function formatBillingFact(billing: BillingFact | null, paymentDueAt: string | null | undefined): string | null {
  if (billing == null) return null
  if (billing === '発行済み' && paymentDueAt && /^\d{4}-\d{2}-\d{2}/.test(paymentDueAt)) {
    return `発行済み（支払期限 ${formatScheduleDate(paymentDueAt)}）`
  }
  return billing
}

/** 日本時間の今日（YYYY-MM-DD）。サーバーが UTC でも日付境界を JST で判定する */
export function todayInJapan(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** "2026-10-08" → "10/8" */
export function formatScheduleDate(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
}

/**
 * 今日が開始日〜終了日に入っている工程。工程表と同じ sort_order 順の先頭 1 件と、残りの件数。
 * 状態を「完了」にした工程は施工中として出さない（工程表の表示と矛盾させない）
 */
export async function fetchCurrentSchedule(
  supabase: SupabaseClient,
  projectId: string,
  today: string,
): Promise<Extract<ScheduleFact, { kind: 'current' }> | null> {
  const { data, error } = await supabase
    .from('schedule_items')
    .select('name, start_date, end_date, status')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .lte('start_date', today)
    .gte('end_date', today)
    .order('sort_order', { ascending: true })
  if (error) {
    console.error('[checked-summary] current schedule query failed:', error.message)
    return null
  }
  const rows = ((data ?? []) as { name: string; start_date: string | null; end_date: string | null; status: string | null }[])
    .filter(r => r.start_date && r.end_date && r.status !== 'done')
  const first = rows[0]
  if (!first) return null
  return { kind: 'current', name: first.name, start_date: first.start_date!, end_date: first.end_date!, others: rows.length - 1 }
}

/** 今日以降で start_date が最も近い工程 1 件。同日は工程表と同じ sort_order 順 */
export async function fetchNextSchedule(
  supabase: SupabaseClient,
  projectId: string,
  today: string,
): Promise<NextScheduleFact | null> {
  const { data, error } = await supabase
    .from('schedule_items')
    .select('name, start_date')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .gte('start_date', today)
    .order('start_date', { ascending: true })
    .order('sort_order', { ascending: true })
    .limit(1)
  if (error) {
    console.error('[checked-summary] schedule query failed:', error.message)
    return null
  }
  const row = (data ?? [])[0] as { name: string; start_date: string | null } | undefined
  return row?.start_date ? { name: row.name, start_date: row.start_date } : null
}

/** 見積合計と工程（施工中 → なければ次の工程）を取得する。請求は案件画面が既に取得している最新請求書から作る */
export async function getEstimateAndSchedule(
  supabase: SupabaseClient,
  projectId: string,
  today: string = todayInJapan(),
): Promise<Omit<CheckedSummary, 'billing'>> {
  const [estimate, current, next] = await Promise.all([
    executeGetEstimateTotal(supabase, projectId),
    fetchCurrentSchedule(supabase, projectId, today),
    fetchNextSchedule(supabase, projectId, today),
  ])
  return {
    estimateTotal:     estimate.status === 'ok' ? estimate.total_including_tax : null,
    estimateItemCount: estimate.status === 'ok' ? estimate.item_count : null,
    schedule:          current ?? (next ? { kind: 'next', ...next } : null),
  }
}
