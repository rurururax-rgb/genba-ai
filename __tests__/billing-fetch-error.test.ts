/**
 * KI-003: 請求・入金の取得に失敗したとき、0 件として集計・通知しないこと。
 *
 * PostgREST の埋め込みがあいまい（PGRST201）になると、Supabase の取得結果は { data: null, error } になる。
 * 以前は `data ?? []` で読み、「未入金なし」「請求書なし」として扱っていた。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BillingFetchError, getCompanyBillingStatus } from '@/lib/services/billing-status'
import { getDailyBriefingItems } from '@/lib/services/daily-briefing'
import { dispatchTool } from '@/lib/ai/chat/tool-executor'
import { TOOL_NAME } from '@/lib/ai/chat/tool-schemas'

const COMPANY = '11111111-2222-4333-8444-555555555555'
const SECRET = '顧客名ひみつ'

type Res = { data: unknown; error: { message: string; code?: string } | null; count?: number | null }

/** テーブル名で結果を返す最小の模擬クライアント（チェーンの途中のメソッドはすべて自分を返す） */
function fakeClient(results: Record<string, Res>) {
  const client = {
    from(table: string) {
      const res = results[table] ?? { data: [], error: null, count: 0 }
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'is', 'in', 'not', 'lt', 'lte', 'order', 'limit']) q[m] = () => q
      q.then = (ok: (v: Res) => unknown) => Promise.resolve(res).then(ok)
      return q
    },
  }
  return client as unknown as SupabaseClient
}

// あいまいな埋め込みで PostgREST が返すエラー（message に顧客データが混ざっても、ログには出さない）
const ambiguous: Res = { data: null, error: { code: 'PGRST201', message: `more than one relationship ${SECRET}` } }

afterEach(() => vi.restoreAllMocks())

describe('getCompanyBillingStatus: 取得失敗を 0 件として返さない', () => {
  it.each(['project_billing_milestones', 'invoice_documents', 'projects'])('%s の取得エラー → BillingFetchError', async table => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = getCompanyBillingStatus(fakeClient({ [table]: ambiguous }), COMPANY)
    await expect(p).rejects.toBeInstanceOf(BillingFetchError)
    await expect(p).rejects.toMatchObject({ code: 'PGRST201' })
    // ログは取得元とコードだけ（エラーメッセージ・顧客データを出さない）
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET)
    expect(JSON.stringify(log.mock.calls)).toContain('PGRST201')
  })

  it('コードが想定外の形なら unknown に置き換える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(getCompanyBillingStatus(fakeClient({
      invoice_documents: { data: null, error: { code: `x ${SECRET}`, message: SECRET } },
    }), COMPANY)).rejects.toMatchObject({ code: 'unknown', message: 'billing fetch failed: invoices (unknown)' })
  })

  it('エラーが無ければ従来どおり集計する（空なら 0 件）', async () => {
    const s = await getCompanyBillingStatus(fakeClient({}), COMPANY)
    expect(s.total_unpaid_amount).toBe(0)
    expect(s.has_pending_billing).toBe(false)
  })
})

describe('getDailyBriefingItems: 請求漏れの判定に使う取得の失敗を 0 件として扱わない', () => {
  it('期限超過マイルストーン（案件の埋め込み）の取得エラー → BillingFetchError（cron は failed にして送らない）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const billing = await getCompanyBillingStatus(fakeClient({}), COMPANY)
    await expect(getDailyBriefingItems(fakeClient({ project_billing_milestones: ambiguous }), billing, COMPANY))
      .rejects.toBeInstanceOf(BillingFetchError)
  })

  it('請求書の有無（invoice_documents）の取得エラー → BillingFetchError（請求漏れを誤検出しない）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const billing = await getCompanyBillingStatus(fakeClient({}), COMPANY)
    await expect(getDailyBriefingItems(fakeClient({ invoice_documents: ambiguous }), billing, COMPANY))
      .rejects.toBeInstanceOf(BillingFetchError)
  })
})

describe('AI チャットの請求・入金ツール: 取得失敗を「未入金なし」と答えさせない', () => {
  it('取得エラー → status: error（件数・金額を返さない）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await dispatchTool(TOOL_NAME.GET_UNPAID_MILESTONES, {}, {
      projectId: null, companyId: COMPANY, supabase: fakeClient({ project_billing_milestones: ambiguous }),
    })
    const body = JSON.parse(r.serialized)
    expect(body.status).toBe('error')
    expect(body).not.toHaveProperty('total_unpaid_amount')
    expect(r.serialized).not.toContain(SECRET)
  })
})
