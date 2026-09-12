/**
 * GET  /api/cron/daily-briefing  ← Vercel Cron Jobs が呼ぶ正式エンドポイント
 * POST /api/cron/daily-briefing  ← 手動テスト用（同じ処理を実行）
 *
 * Vercel Cron から毎朝 8:00 JST に呼ばれ、
 * 「今日やること」の高・中優先度アイテムを LINE に通知する。
 *
 * ── 認証 ────────────────────────────────────────────────────────────
 * Authorization: Bearer ${CRON_SECRET} が必須（GET / POST 共通）。
 * CRON_SECRET 自体はログに出力しない。
 *
 * ── 二重送信防止（UNIQUE + status 遷移）────────────────────────────
 * daily_briefing_runs(company_id, briefing_date) UNIQUE 制約で保証する。
 *
 * 正常フロー:
 *   INSERT status='pending' → 処理 → status='sent'|'skipped'|'failed'
 *
 * 二重実行（同日 2 回目）:
 *   INSERT → 23505 UNIQUE conflict
 *   → 既存 status を確認
 *   → 'sent'/'skipped'/'pending' → スキップ（200 already_done）
 *   → 'failed' → UPDATE WHERE status='failed'（原子的に再試行権取得）
 *                 取得できなければスキップ
 *
 * ── CLAUDE.md 準拠 ──────────────────────────────────────────────────
 * admin.ts 使用: CLAUDE.md 許可リスト（Phase 3 承認済み）の4箇所目
 * AI は使わない（Step 4 まで決定論的テンプレートのみ）
 * 自動送信するのは日次ブリーフィングのみ（顧客・請求書・発注は対象外）
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getDailyBriefingItems, filterHighPriorityItems, formatBriefingMessage } from '@/lib/services/daily-briefing'
import { sendLinePushMessage, maskUserId } from '@/lib/line/push'

// ── JST 日付取得（Cron 実行時刻 23:00 UTC = 翌日 8:00 JST） ──────────
function getJstDate(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// ── 認証チェック ───────────────────────────────────────────────────────
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.warn('[Cron] CRON_SECRET が未設定のため全リクエストを拒否します')
    return false
  }
  const auth = request.headers.get('authorization') ?? ''
  return auth === `Bearer ${secret}`
}

// ── 1社分のブリーフィング処理 ─────────────────────────────────────────
async function processBriefingForCompany(
  companyId: string,
  jstDate: string,
): Promise<{
  result:    'sent' | 'skipped' | 'already_done' | 'failed' | 'in_progress'
  reason?:   string
  itemCount?: number
}> {
  // ── Step 1: 送信権を取得（INSERT 試行）────────────────────────────

  const { error: insertErr } = await supabaseAdmin
    .from('daily_briefing_runs')
    .insert({
      company_id:    companyId,
      briefing_date: jstDate,
      status:        'pending',
    })

  if (insertErr) {
    if (insertErr.code !== '23505') {
      console.error(`[Cron] INSERT 失敗 company=${companyId} date=${jstDate}:`, insertErr.message)
      return { result: 'failed', reason: `DB INSERT error: ${insertErr.message}` }
    }

    // UNIQUE conflict → 既存行の status を確認
    const { data: existing } = await supabaseAdmin
      .from('daily_briefing_runs')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('briefing_date', jstDate)
      .single()

    const existingStatus = existing?.status as string | undefined

    if (existingStatus === 'sent' || existingStatus === 'skipped') {
      console.log(`[Cron] スキップ（${existingStatus}済み） company=${companyId} date=${jstDate}`)
      return { result: 'already_done', reason: existingStatus }
    }

    if (existingStatus === 'pending') {
      console.log(`[Cron] スキップ（別プロセスが処理中） company=${companyId} date=${jstDate}`)
      return { result: 'in_progress' }
    }

    if (existingStatus === 'failed') {
      // 前回失敗 → 原子的に再試行権を取得（WHERE status='failed' が排他ロックとして機能）
      const { data: retried } = await supabaseAdmin
        .from('daily_briefing_runs')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .eq('briefing_date', jstDate)
        .eq('status', 'failed')
        .select('id')

      if (!retried || retried.length === 0) {
        console.log(`[Cron] スキップ（retry 権を別プロセスが取得） company=${companyId} date=${jstDate}`)
        return { result: 'in_progress' }
      }
      console.log(`[Cron] 前回失敗から再試行 company=${companyId} date=${jstDate}`)
    } else {
      console.warn(`[Cron] 想定外の status="${existingStatus}" company=${companyId} date=${jstDate}`)
      return { result: 'in_progress' }
    }
  }

  // ── Step 2: 今日やること取得 ──────────────────────────────────────
  let items
  try {
    items = await getDailyBriefingItems(supabaseAdmin, undefined, companyId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Cron] getDailyBriefingItems 失敗 company=${companyId}:`, msg)
    await supabaseAdmin
      .from('daily_briefing_runs')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('briefing_date', jstDate)
    return { result: 'failed', reason: msg }
  }

  const highItems = filterHighPriorityItems(items)

  // ── Step 3: 高優先度なし → スキップ ──────────────────────────────
  if (highItems.length === 0) {
    await supabaseAdmin
      .from('daily_briefing_runs')
      .update({ status: 'skipped', items_count: 0, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('briefing_date', jstDate)
    console.log(`[Cron] スキップ（高優先度アイテムなし） company=${companyId} date=${jstDate} 全件=${items.length}`)
    return { result: 'skipped', reason: 'no_high_priority_items', itemCount: 0 }
  }

  // ── Step 4: LINE 送信先 userId を取得 ────────────────────────────
  const lineUserId = process.env.LINE_BRIEFING_USER_ID
  if (!lineUserId) {
    console.error('[Cron] LINE_BRIEFING_USER_ID が未設定です')
    await supabaseAdmin
      .from('daily_briefing_runs')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('briefing_date', jstDate)
    return { result: 'failed', reason: 'LINE_BRIEFING_USER_ID not set' }
  }

  // ── Step 5: テンプレートメッセージ生成 ───────────────────────────
  const messageText = formatBriefingMessage(items, jstDate)

  // ── Step 6: LINE 送信 ─────────────────────────────────────────────
  console.log(
    `[Cron] LINE 送信開始 → to=${maskUserId(lineUserId)} items=${highItems.length} company=${companyId}`
  )

  const pushResult = await sendLinePushMessage({ to: lineUserId, text: messageText })

  if (!pushResult.ok) {
    await supabaseAdmin
      .from('daily_briefing_runs')
      .update({
        status:      'failed',
        items_count: highItems.length,
        updated_at:  new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('briefing_date', jstDate)
    console.error(`[Cron] LINE 送信失敗 company=${companyId}: ${pushResult.reason}`)
    return { result: 'failed', reason: pushResult.reason, itemCount: highItems.length }
  }

  // ── Step 7: 送信成功 → status='sent' で記録 ─────────────────────
  await supabaseAdmin
    .from('daily_briefing_runs')
    .update({
      status:      'sent',
      items_count: highItems.length,
      sent_at:     new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('briefing_date', jstDate)

  console.log(
    `[Cron] LINE 送信成功 → to=${maskUserId(lineUserId)} items=${highItems.length} company=${companyId} date=${jstDate}`
  )
  return { result: 'sent', itemCount: highItems.length }
}

// ── 共通処理（GET / POST 共用）────────────────────────────────────────
async function runDailyBriefing(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    console.warn('[Cron] 認証失敗 — 不正または未設定の CRON_SECRET')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const jstDate = getJstDate()
  console.log(`[Cron] daily-briefing 開始 date=${jstDate}`)

  const { data: companies, error: compErr } = await supabaseAdmin
    .from('companies')
    .select('id, name')

  if (compErr || !companies || companies.length === 0) {
    console.error('[Cron] 会社一覧取得失敗:', compErr?.message ?? 'no data')
    return NextResponse.json({ error: 'Failed to fetch companies' }, { status: 500 })
  }

  console.log(`[Cron] 対象会社: ${companies.length}件`)

  const results: Array<{
    company_id:   string
    company_name: string
    result:       string
    reason?:      string
    item_count?:  number
  }> = []

  for (const company of companies as Array<{ id: string; name: string }>) {
    const r = await processBriefingForCompany(company.id, jstDate)
    results.push({
      company_id:   company.id,
      company_name: company.name,
      result:       r.result,
      reason:       r.reason,
      item_count:   r.itemCount,
    })
  }

  const sentCount    = results.filter(r => r.result === 'sent').length
  const skippedCount = results.filter(r => r.result === 'skipped' || r.result === 'already_done').length
  const failedCount  = results.filter(r => r.result === 'failed').length

  console.log(
    `[Cron] 完了 date=${jstDate} — 送信=${sentCount} スキップ=${skippedCount} 失敗=${failedCount}`
  )

  return NextResponse.json({
    date:    jstDate,
    summary: { sent: sentCount, skipped: skippedCount, failed: failedCount },
    results,
  })
}

// ── Vercel Cron Jobs はGETで呼ぶ ─────────────────────────────────────
export async function GET(request: NextRequest) {
  return runDailyBriefing(request)
}

// ── 手動テスト用 POST ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  return runDailyBriefing(request)
}
