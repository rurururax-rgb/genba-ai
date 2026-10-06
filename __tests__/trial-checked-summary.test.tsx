import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateEstimateTotals } from '@/lib/estimate/totals'
import {
  toBillingFact,
  formatBillingFact,
  fetchCurrentSchedule,
  fetchNextSchedule,
  getEstimateAndSchedule,
  todayInJapan,
  formatScheduleDate,
} from '@/lib/project/checked-summary'
import { ProjectCheckedSummary } from '@/components/projects/ProjectCheckedSummary'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects/p1' }))

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'

// ── 最小 Supabase モック（select / eq / is / gte / order / limit / maybeSingle。書き込みメソッドは持たない）──
type Row = Record<string, unknown>
function mockSupabase(tables: Record<string, Row[]>, failTable?: string) {
  const client = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const orders: Array<[string, boolean]> = []
      let limit = Infinity
      const run = () => {
        if (table === failTable) return { data: null, error: { message: 'boom' } }
        const rows = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        rows.sort((a, b) => {
          for (const [col, asc] of orders) {
            const x = a[col] as string | number, y = b[col] as string | number
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1)
          }
          return 0
        })
        return { data: rows.slice(0, limit), error: null }
      }
      const builder = {
        select: () => builder,
        eq:  (col: string, v: unknown) => { filters.push(r => r[col] === v); return builder },
        is:  (col: string) => { filters.push(r => r[col] == null); return builder },
        gte: (col: string, v: string) => { filters.push(r => r[col] != null && (r[col] as string) >= v); return builder },
        lte: (col: string, v: string) => { filters.push(r => r[col] != null && (r[col] as string) <= v); return builder },
        order: (col: string, o?: { ascending?: boolean }) => { orders.push([col, o?.ascending !== false]); return builder },
        limit: (n: number) => { limit = n; return builder },
        maybeSingle: async () => {
          const res = run()
          return res.error ? res : { data: (res.data as Row[])[0] ?? null, error: null }
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      }
      return builder
    },
  }
  return client as unknown as SupabaseClient
}

const TODAY = '2026-10-04'

// ── 見積 ────────────────────────────────────────────────────────────────
describe('見積：共有計算と一致', () => {
  const items = [
    { project_id: PROJECT_A, deleted_at: null, quantity: 182.5, selling_price: 3_800, amount: 693_500 },
    { project_id: PROJECT_A, deleted_at: null, quantity: 1, selling_price: null, amount: 1_250_000 },
    { project_id: PROJECT_A, deleted_at: null, quantity: 2.5, selling_price: 1_333, amount: 3_333 },
    { project_id: PROJECT_A, deleted_at: '2026-01-01', quantity: 1, selling_price: 999_999, amount: 999_999 },
    { project_id: PROJECT_B, deleted_at: null, quantity: 1, selling_price: 5_000_000, amount: 5_000_000 },
  ]
  const project = { id: PROJECT_A, deleted_at: null, misc_expense_override: null, rounding_discount: 6 }

  it('summary の税込合計 = calculateEstimateTotals の税込合計（他案件・削除済みを含めない）', async () => {
    const supabase = mockSupabase({ estimate_items: items, projects: [project], schedule_items: [] })
    const { estimateTotal } = await getEstimateAndSchedule(supabase, PROJECT_A, TODAY)
    const expected = calculateEstimateTotals(items.slice(0, 3), { miscExpenseOverride: null, roundingDiscount: 6 })
    expect(estimateTotal).toBe(expected.totalIncludingTax)
  })

  it('見積明細なし：crash せず 0円（明細0件という事実）', async () => {
    const supabase = mockSupabase({ estimate_items: [], projects: [project], schedule_items: [] })
    const { estimateTotal } = await getEstimateAndSchedule(supabase, PROJECT_A, TODAY)
    expect(estimateTotal).toBe(calculateEstimateTotals([], { miscExpenseOverride: null, roundingDiscount: 6 }).totalIncludingTax)
  })

  it('取得失敗：0円にせず null（画面は「—」）', async () => {
    const supabase = mockSupabase({ estimate_items: items, projects: [project], schedule_items: [] }, 'estimate_items')
    const { estimateTotal } = await getEstimateAndSchedule(supabase, PROJECT_A, TODAY)
    expect(estimateTotal).toBeNull()
  })

  it('表示：null は「—」で金額を出さない / 値はカンマ区切り税込', () => {
    const none = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={null} estimateItemCount={null} billing={null} schedule={null} />)
    expect(none).toContain('RUGZが確認しました')
    expect(none).not.toContain('0円')
    expect((none.match(/—/g) ?? []).length).toBe(3)
    const html = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={7_996_802} estimateItemCount={12} billing="下書きあり" schedule={{ kind: 'next', name: '内装解体', start_date: '2026-10-08' }} />)
    expect(html).toContain('7,996,802円（税込）')
    expect(html).toContain('下書きあり')
    expect(html).toContain('次の工程')
    expect(html).toContain('10/8 内装解体')
  })

  it('見積明細 0 件は「0円（税込）」ではなく「見積なし」', () => {
    const html = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={0} estimateItemCount={0} billing="未作成" schedule={null} />)
    expect(html).toContain('見積なし')
    expect(html).not.toContain('0円')
  })

  it('施工中の工程：期間と工程名、複数あれば「ほかN件」', () => {
    const one = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={1} estimateItemCount={1} billing="未作成"
      schedule={{ kind: 'current', name: '庭石ハツリ', start_date: '2026-10-01', end_date: '2026-10-09', others: 0 }} />)
    expect(one).toContain('施工中')
    expect(one).toContain('10/1〜10/9 庭石ハツリ')
    expect(one).not.toContain('ほか')
    expect(one).not.toContain('次の工程')
    const two = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={1} estimateItemCount={1} billing="未作成"
      schedule={{ kind: 'current', name: '庭石ハツリ', start_date: '2026-10-01', end_date: '2026-10-09', others: 1 }} />)
    expect(two).toContain('10/1〜10/9 庭石ハツリ ほか1件')
  })

  it('表示のみ：ボタン・リンク・判断語を含まない', () => {
    const html = renderToStaticMarkup(<ProjectCheckedSummary estimateTotal={1} estimateItemCount={1} billing="発行済み（支払期限 9/3）" schedule={null} />)
    expect(html).not.toMatch(/<button|<a /)
    for (const word of ['請求漏れ', '遅れ', '注意', '危険', 'おすすめ', '原価未入力', '超過', '期限切れ']) expect(html).not.toContain(word)
  })

  it('見積エディタは明細の取得完了まで合計（genba:total）を通知しない', () => {
    // 読込中の空配列から算出した 0円 を summary に流さないためのガード（effect は node 環境で実行できないため構造で確認）
    const src = readFileSync(path.join(process.cwd(), 'components/projects/EstimateTab.tsx'), 'utf8')
    expect(src).toMatch(/if \(!itemsLoaded\) return\s*\n\s*window\.dispatchEvent\(new CustomEvent\('genba:total'/)
    expect(src).toContain('setItemsLoaded(true)')
    expect(src).toContain("new CustomEvent('genba:estimate-count'")
  })

  it('取得結果に明細行数を含む（失敗時は null）', async () => {
    const ok = await getEstimateAndSchedule(mockSupabase({ estimate_items: items, projects: [project], schedule_items: [] }), PROJECT_A, TODAY)
    expect(ok.estimateItemCount).toBe(3)
    const ng = await getEstimateAndSchedule(mockSupabase({ estimate_items: items, projects: [project], schedule_items: [] }, 'estimate_items'), PROJECT_A, TODAY)
    expect(ng.estimateItemCount).toBeNull()
  })
})

// ── 請求 ────────────────────────────────────────────────────────────────
describe('請求：最新請求書の状態をそのまま', () => {
  it.each([
    [undefined, '未作成'],
    [null, '未作成'],
    [{ status: 'draft' }, '下書きあり'],
    [{ status: 'issued' }, '発行済み'],
    [{ status: 'paid' }, '入金済み'],
    [{ status: null }, '作成済み'],
    [{ status: 'something_new' }, '作成済み'],
  ])('%j → %s', (latest, expected) => {
    expect(toBillingFact(latest as { status: string | null } | null | undefined)).toBe(expected)
  })

  it('発行済みは支払期限を添える（判断語なし）。期限なし・他状態・取得失敗はそのまま', () => {
    expect(formatBillingFact('発行済み', '2026-09-03')).toBe('発行済み（支払期限 9/3）')
    expect(formatBillingFact('発行済み', '2026-09-03T00:00:00+09:00')).toBe('発行済み（支払期限 9/3）')
    expect(formatBillingFact('発行済み', null)).toBe('発行済み')
    expect(formatBillingFact('発行済み', 'not-a-date')).toBe('発行済み')
    expect(formatBillingFact('入金済み', '2026-09-03')).toBe('入金済み')
    expect(formatBillingFact(null, '2026-09-03')).toBeNull()
  })
})

// ── 施工中の工程 ────────────────────────────────────────────────────────
describe('施工中：今日が開始日〜終了日に入る工程を優先', () => {
  const base = { project_id: PROJECT_A, deleted_at: null, status: 'planned' }
  const rows = [
    { ...base, name: '既設デッキ撤去', start_date: '2026-10-01', end_date: '2026-10-15', sort_order: 2 },
    { ...base, name: '庭石ハツリ',     start_date: '2026-10-01', end_date: '2026-10-09', sort_order: 1 },
    { ...base, name: '完了済み',       start_date: '2026-10-01', end_date: '2026-10-20', sort_order: 0, status: 'done' },
    { ...base, name: '削除済み',       start_date: '2026-10-01', end_date: '2026-10-20', sort_order: 0, deleted_at: '2026-09-01' },
    { ...base, name: '終了日未定',     start_date: '2026-10-01', end_date: null,         sort_order: 0 },
    { ...base, name: '外構仕上げ',     start_date: '2026-10-19', end_date: '2026-10-25', sort_order: 3 },
  ]

  it('施工期間中が複数 → sort_order 先頭＋残り件数（完了・削除・日付未定は除く）', async () => {
    const cur = await fetchCurrentSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, TODAY)
    expect(cur).toEqual({ kind: 'current', name: '庭石ハツリ', start_date: '2026-10-01', end_date: '2026-10-09', others: 1 })
  })

  it('開始日・終了日当日も施工中に含む', async () => {
    expect((await fetchCurrentSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, '2026-10-09'))?.others).toBe(1)
    expect((await fetchCurrentSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, '2026-10-10'))?.name).toBe('既設デッキ撤去')
  })

  it('施工中がなければ次の工程にフォールバック', async () => {
    const { schedule } = await getEstimateAndSchedule(mockSupabase({ estimate_items: [], projects: [], schedule_items: rows }), PROJECT_A, '2026-10-16')
    expect(schedule).toEqual({ kind: 'next', name: '外構仕上げ', start_date: '2026-10-19' })
  })

  it('施工中があれば施工中を優先', async () => {
    const { schedule } = await getEstimateAndSchedule(mockSupabase({ estimate_items: [], projects: [], schedule_items: rows }), PROJECT_A, TODAY)
    expect(schedule?.kind).toBe('current')
  })

  it('取得失敗 → null', async () => {
    expect(await fetchCurrentSchedule(mockSupabase({ schedule_items: rows }, 'schedule_items'), PROJECT_A, TODAY)).toBeNull()
  })
})

// ── 次の工程 ────────────────────────────────────────────────────────────
describe('次の工程：今日以降で最も近い 1 件', () => {
  const base = { project_id: PROJECT_A, deleted_at: null }
  const rows = [
    { ...base, name: '着工前打合せ', start_date: '2026-10-01', sort_order: 0 }, // 過去
    { ...base, name: '外壁塗装',     start_date: '2026-10-20', sort_order: 1 },
    { ...base, name: '内装解体',     start_date: '2026-10-08', sort_order: 3 },
    { ...base, name: '養生',         start_date: '2026-10-08', sort_order: 2 }, // 同日・sort_order が先
    { ...base, name: '日付未定',     start_date: null,         sort_order: 0 },
    { ...base, name: '削除済み',     start_date: '2026-10-05', sort_order: 0, deleted_at: '2026-09-01' },
    { project_id: PROJECT_B, deleted_at: null, name: '別案件の工程', start_date: '2026-10-04', sort_order: 0 },
  ]

  it('future 工程が複数 → 最も近い日付、同日は工程表と同じ sort_order 順', async () => {
    const next = await fetchNextSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, TODAY)
    expect(next).toEqual({ name: '養生', start_date: '2026-10-08' })
  })

  it('今日の工程は「今日以降」に含む', async () => {
    const next = await fetchNextSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, '2026-10-01')
    expect(next?.name).toBe('着工前打合せ')
  })

  it('別 project の工程を表示しない', async () => {
    const next = await fetchNextSchedule(mockSupabase({ schedule_items: rows }), PROJECT_B, '2026-10-05')
    expect(next).toBeNull()
  })

  it('future 工程なし / 取得失敗 → null（画面は「—」）', async () => {
    expect(await fetchNextSchedule(mockSupabase({ schedule_items: rows }), PROJECT_A, '2026-11-01')).toBeNull()
    expect(await fetchNextSchedule(mockSupabase({ schedule_items: [] }), PROJECT_A, TODAY)).toBeNull()
    expect(await fetchNextSchedule(mockSupabase({ schedule_items: rows }, 'schedule_items'), PROJECT_A, TODAY)).toBeNull()
  })

  it('日付は日本時間で判定・M/D 表示', () => {
    expect(todayInJapan(new Date('2026-10-03T15:30:00Z'))).toBe('2026-10-04') // UTC 15:30 = JST 翌 0:30
    expect(formatScheduleDate('2026-10-08')).toBe('10/8')
  })
})

// ── 自由チャットの入口 ─────────────────────────────────────────────────
describe('Trial UI：自由チャットの入口を出さない（基盤は残す）', () => {
  it('サイドバー（案件画面）に AIアシスタント の入口がない', async () => {
    const { Sidebar } = await import('@/components/shell/Sidebar')
    const html = renderToStaticMarkup(<Sidebar />)
    expect(html).not.toContain('M21 15a2 2 0 01-2 2H7l-4 4V5') // チャットアイコン
  })

  it('案件一覧（今日やること）に AIに相談 の入口がない', async () => {
    const { DashboardSummarySection } = await import('@/components/projects/DashboardSummarySection')
    const item = {
      type: 'invoice_draft', priority: 3, projectId: PROJECT_A, projectName: 'キッチン改修',
      title: '請求書：下書きあり（未発行）', reason: '下書きのままです', recommendedAction: '請求書を確認して発行する',
      actionUrl: `/projects/${PROJECT_A}`,
    }
    const html = renderToStaticMarkup(
      <DashboardSummarySection summary={{ active_projects: 1 } as never} actionItems={[item] as never} />,
    )
    expect(html).not.toContain('AIに相談')
    expect(html).not.toMatch(/<button/)
    expect(html).toContain(`/projects/${PROJECT_A}`) // 案件への通常の導線は残る
  })

  it('Action Honesty：見出しは「今日の確認」、全種別の CTA は遷移先どおり「案件を見る」で、実行しない行動を書かない', async () => {
    const { DashboardSummarySection } = await import('@/components/projects/DashboardSummarySection')
    const RECOMMENDED: Record<string, string> = {
      invoice_overdue: '顧客に入金確認の連絡をする', invoice_issued_unpaid: '入金状況を確認する',
      milestone_overdue: '請求書を作成して発行する', invoice_draft: '請求書を確認して発行する',
      billing_missing: '請求書を作成する', schedule_mismatch: '工程を登録する', inactive: '案件状況を確認する',
    }
    const items = Object.entries(RECOMMENDED).map(([type, recommendedAction], i) => ({
      type, priority: (i % 5) + 1, projectId: `p${i}`, projectName: `案件${i}`,
      title: 'タイトル', reason: '理由', recommendedAction, actionUrl: `/projects/p${i}`,
    }))
    const html = renderToStaticMarkup(
      <DashboardSummarySection summary={{ active_projects: 7 } as never} actionItems={items as never} />,
    )
    expect(html).toContain('今日の確認')
    expect(html).not.toContain('今日やること')
    for (const text of Object.values(RECOMMENDED)) expect(html).not.toContain(text)
    // 各リンクは案件画面へ遷移し、文言は「案件を見る」
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)]
    expect(links.map(m => m[1]).sort()).toEqual(items.map(i => i.actionUrl).sort()) // 表示は優先度順
    for (const m of links) expect(m[2]).toContain('案件を見る')
  })

  it('チャット API・UI・Tool 群は削除していない', () => {
    for (const f of [
      'app/api/ai/chat/route.ts',
      'app/api/ai/chat/confirm-change/route.ts',
      'components/projects/ChatPanel.tsx',
      'components/projects/CompanyChat.tsx',
      'lib/ai/chat/tool-executor.ts',
      'lib/ai/chat/tool-schemas.ts',
      'lib/ai/chat/estimate-total.ts',
    ]) expect(existsSync(path.join(process.cwd(), f)), f).toBe(true)
  })
})
