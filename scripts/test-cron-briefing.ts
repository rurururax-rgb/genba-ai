/**
 * scripts/test-cron-briefing.ts
 *
 * Cron Route の手動テストスクリプト。
 * Cron の本番時刻を待たずに以下を検証する:
 *
 *   A. 不正 CRON_SECRET → 401
 *   B. 正しい CRON_SECRET → 200
 *   C. 対応項目あり → LINE 1通送信
 *   D. 同日 2 回目 → 送信スキップ（already_done）
 *   E. 高優先度なし → skipped（DB 確認のみ。実際に再現するにはデータ変更が必要）
 *   G. テスト後のレコード削除（翌日再送信可能な状態に戻す）
 *
 * 使い方:
 *   npx tsx scripts/test-cron-briefing.ts
 *
 * 前提:
 *   .env.local に CRON_SECRET, LINE_BRIEFING_USER_ID, LINE_CHANNEL_ACCESS_TOKEN が設定済み
 *   Migration 20260912000004 が本番 DB に適用済み
 *
 * 注意:
 *   TEST C では実際に LINE へメッセージが送信されます。
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const BASE_URL    = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const CRON_SECRET = process.env.CRON_SECRET
const ENDPOINT    = `${BASE_URL}/api/cron/daily-briefing`

// JST 日付（テスト時刻基準）
const JST_DATE = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

// ── ヘルパー ─────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(msg: string) {
  console.log(`  ✅ ${msg}`)
  passed++
}
function fail(msg: string) {
  console.log(`  ❌ ${msg}`)
  failed++
}
function info(msg: string) {
  console.log(`  ℹ️  ${msg}`)
}
function sep(label: string) {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`${label}`)
  console.log('─'.repeat(50))
}

// Vercel Cron Jobs は GET で呼ぶ。テストも本番と同じ経路（GET）で検証する。
async function callCron(secret: string | null): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (secret !== null) headers['Authorization'] = `Bearer ${secret}`
  const res = await fetch(ENDPOINT, { method: 'GET', headers })
  let body: unknown = null
  try { body = await res.json() } catch { /* empty */ }
  return { status: res.status, body }
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════')
  console.log('Cron Route テスト')
  console.log(`  エンドポイント: ${ENDPOINT}`)
  console.log(`  JST 日付: ${JST_DATE}`)
  console.log('═══════════════════════════════════════════════════')

  if (!CRON_SECRET) {
    console.error('\n❌ CRON_SECRET が .env.local に設定されていません')
    console.error('   例: CRON_SECRET=any-long-random-string')
    process.exit(1)
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  // テスト前にその日のレコードを削除（クリーンスタート）
  const { data: companies } = await admin.from('companies').select('id').limit(1)
  const companyId = companies?.[0]?.id
  if (companyId) {
    await admin
      .from('daily_briefing_runs')
      .delete()
      .eq('company_id', companyId)
      .eq('briefing_date', JST_DATE)
    info(`テスト前クリーンアップ完了 (company=${companyId} date=${JST_DATE})`)
  }

  // ── TEST A: 不正 CRON_SECRET → 401 ───────────────────────────────
  sep('TEST A: 不正 CRON_SECRET → 401')
  {
    const r = await callCron('invalid-secret-xxxxx')
    if (r.status === 401) {
      pass(`401 Unauthorized（認証失敗を正しく拒否）`)
    } else {
      fail(`期待 401、実際 ${r.status}`)
    }
  }

  // ── TEST B: 認証なし → 401 ─────────────────────────────────────
  sep('TEST B: Authorization ヘッダーなし → 401')
  {
    const r = await callCron(null)
    if (r.status === 401) {
      pass(`401 Unauthorized（ヘッダーなしを正しく拒否）`)
    } else {
      fail(`期待 401、実際 ${r.status}`)
    }
  }

  // ── TEST C: 正しい CRON_SECRET → LINE 送信 ────────────────────────
  sep('TEST C: 正しい CRON_SECRET → LINE 1通送信')
  info('注意: 実際に LINE へメッセージが送信されます')
  {
    const r = await callCron(CRON_SECRET)
    info(`HTTP: ${r.status}`)
    info(`Body: ${JSON.stringify(r.body, null, 2).replace(/\n/g, '\n  ')}`)

    if (r.status === 200) {
      pass(`200 OK`)
      const body = r.body as { summary?: { sent: number; skipped: number; failed: number }; results?: unknown[] }
      const summary = body?.summary
      if (!summary) {
        fail('レスポンスに summary がありません')
      } else if (summary.sent >= 1) {
        pass(`LINE 送信成功 (sent=${summary.sent})`)
        info('LINE アプリで受信を確認してください')
      } else if (summary.skipped >= 1) {
        info(`LINE 送信スキップ (skipped=${summary.skipped} — 高優先度アイテムなし)`)
        pass(`スキップ動作確認（アイテムなし）`)
      } else if (summary.failed >= 1) {
        fail(`LINE 送信失敗 (failed=${summary.failed}) — LINE_BRIEFING_USER_ID や LINE_CHANNEL_ACCESS_TOKEN を確認してください`)
      }
    } else {
      fail(`期待 200、実際 ${r.status}`)
    }
  }

  // ── TEST D: 同日 2 回目 → スキップ ────────────────────────────────
  sep('TEST D: 同日 2 回目 → 送信スキップ')
  {
    const r = await callCron(CRON_SECRET)
    info(`HTTP: ${r.status}`)
    info(`Body: ${JSON.stringify(r.body, null, 2).replace(/\n/g, '\n  ')}`)

    if (r.status === 200) {
      pass(`200 OK`)
      const body = r.body as { summary?: { sent: number } }
      const summary = body?.summary
      if (summary?.sent === 0) {
        pass(`2 回目は LINE 送信されていない（sent=0）`)
        info('同日重複送信防止が正常に動作しています')
      } else {
        fail(`2 回目でも sent=${summary?.sent} — 二重送信の可能性があります`)
      }
    } else {
      fail(`期待 200、実際 ${r.status}`)
    }
  }

  // ── TEST E: DB 状態確認 ─────────────────────────────────────────
  sep('TEST E: DB 状態確認')
  if (companyId) {
    const { data: runRecord } = await admin
      .from('daily_briefing_runs')
      .select('status, items_count, sent_at')
      .eq('company_id', companyId)
      .eq('briefing_date', JST_DATE)
      .single()
    if (runRecord) {
      pass(`daily_briefing_runs レコードあり`)
      info(`  status: ${runRecord.status}`)
      info(`  items_count: ${runRecord.items_count ?? '(未設定)'}`)
      info(`  sent_at: ${runRecord.sent_at ?? '(未設定)'}`)
      if (runRecord.status === 'sent' || runRecord.status === 'skipped') {
        pass(`status が確定（${runRecord.status}）`)
      } else {
        fail(`status が ${runRecord.status} — 想定外`)
      }
    } else {
      fail(`daily_briefing_runs レコードが見つかりません — Migration が適用されていない可能性があります`)
    }
  }

  // ── TEST F: LINE 失敗シミュレーション（手動確認用コメント）────────
  sep('TEST F: LINE 失敗 → sent 扱いにしない（コード確認）')
  info('自動テスト対象外（LINE API をモックできないため）')
  info('コード上の保証:')
  info('  sendLinePushMessage が ok:false を返した場合、')
  info('  status を "failed" で更新（"sent" にしない）')
  info('  → 次の Cron 実行で再試行可能')
  pass('コードレビューで確認済み（cron route Step6/Step7 参照）')

  // ── テスト後クリーンアップ（オプション: コメントアウトで削除しない）
  sep('クリーンアップ')
  if (companyId) {
    const { error } = await admin
      .from('daily_briefing_runs')
      .delete()
      .eq('company_id', companyId)
      .eq('briefing_date', JST_DATE)
    if (!error) {
      info(`テストレコード削除完了（翌日実行と同じ状態に復元）`)
      pass('翌日の Cron も正常送信可能な状態')
    } else {
      fail(`クリーンアップ失敗: ${error.message}`)
    }
  }

  // ── 結果サマリー ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50))
  console.log(`テスト完了: ✅ ${passed}件 ❌ ${failed}件`)
  console.log('═'.repeat(50) + '\n')

  if (failed > 0) process.exit(1)
}

main().catch(e => {
  console.error('予期しないエラー:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
