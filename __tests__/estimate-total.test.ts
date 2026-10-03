import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateEstimateTotals, liveAmount, type EstimateTotalItem } from '@/lib/estimate/totals'
import { executeGetEstimateTotal } from '@/lib/ai/chat/estimate-total'
import { dispatchTool } from '@/lib/ai/chat/tool-executor'
import {
  chatTools,
  companyTools,
  PROJECT_SCOPED_TOOLS,
  TOOL_NAME,
  ESTIMATE_TOTAL_PROMPT_RULES,
} from '@/lib/ai/chat/tool-schemas'

// ── Fixture: 税込合計 ¥7,996,802 を再現（小計 6,731,320 / 諸経費 8% / 端数値引 6）──
const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'

const ITEMS_7996802: EstimateTotalItem[] = [
  { quantity: 1,     selling_price: 450_000,   amount: 450_000 },   // 足場
  { quantity: 182.5, selling_price: 3_800,     amount: 693_500 },   // 外壁塗装（小数数量）
  { quantity: 1,     selling_price: 1_280_000, amount: 1_280_000 }, // ユニットバス
  { quantity: 96.3,  selling_price: 7_450,     amount: 717_435 },   // 屋根
  { quantity: 1,     selling_price: null,      amount: null },      // 見出し行
  { quantity: 1,     selling_price: null,      amount: 1_250_000 }, // 売価なし → amount
  { quantity: 2.5,   selling_price: 1_333,     amount: 3_333 },     // 3332.5 → 四捨五入
  { quantity: 1,     selling_price: 2_337_052, amount: 2_337_052 }, // キッチン
]

// リファクタ前の EstimateTab の計算式をそのまま写したもの（Before/After parity 用）
function legacyEstimateTabTotals(
  items: EstimateTotalItem[],
  miscExpenseOverride: number | null,
  roundingDiscount: number,
) {
  const legacyLive = (i: EstimateTotalItem) =>
    i.selling_price != null ? Math.round(i.quantity * i.selling_price) : (i.amount ?? 0)
  const subtotal    = items.reduce((acc, i) => acc + legacyLive(i), 0)
  const miscExpense = miscExpenseOverride != null ? miscExpenseOverride : Math.round(subtotal * 0.08)
  const taxBase     = subtotal + miscExpense - roundingDiscount
  const tax         = Math.floor(taxBase * 0.1)
  return { subtotal, miscExpense, taxBase, tax, total: taxBase + tax }
}

// ── 最小 Supabase モック（select / eq / is / maybeSingle のみ。書き込みメソッドは持たない）──
type Row = Record<string, unknown>
function mockSupabase(tables: Record<string, Row[]>, failTable?: string) {
  const calls: Array<{ table: string; filters: Array<[string, string, unknown]> }> = []
  const client = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = []
      calls.push({ table, filters })
      const run = () => {
        if (table === failTable) return { data: null, error: { message: 'boom' } }
        const rows = (tables[table] ?? []).filter(r =>
          filters.every(([op, col, v]) => (op === 'eq' ? r[col] === v : r[col] == null)),
        )
        return { data: rows, error: null }
      }
      const builder = {
        select: () => builder,
        eq:     (col: string, v: unknown) => { filters.push(['eq', col, v]); return builder },
        is:     (col: string, v: unknown) => { filters.push(['is', col, v]); return builder },
        maybeSingle: async () => {
          const r = run()
          return { data: r.data?.[0] ?? null, error: r.error }
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

function dbFixture() {
  return {
    estimate_items: [
      ...ITEMS_7996802.map(i => ({ ...i, project_id: PROJECT_A, deleted_at: null })),
      { quantity: 1, selling_price: 9_999_999, amount: 9_999_999, project_id: PROJECT_A, deleted_at: '2026-01-01' }, // 削除済み
      { quantity: 1, selling_price: 5_000_000, amount: 5_000_000, project_id: PROJECT_B, deleted_at: null },        // 別案件
    ],
    projects: [
      { id: PROJECT_A, misc_expense_override: null, rounding_discount: 6, deleted_at: null },
      { id: PROJECT_B, misc_expense_override: 0,    rounding_discount: 0, deleted_at: null },
    ],
  }
}

// ─────────────────────────────────────────────────────────

describe('calculateEstimateTotals', () => {
  it('reproduces the production example ¥7,996,802 with each component asserted', () => {
    const t = calculateEstimateTotals(ITEMS_7996802, { miscExpenseOverride: null, roundingDiscount: 6 })
    expect(t.itemSubtotal).toBe(6_731_320)
    expect(t.overhead).toBe(538_506)           // round(6,731,320 × 0.08 = 538,505.6)
    expect(t.roundingDiscount).toBe(6)
    expect(t.preTaxTotal).toBe(7_269_820)
    expect(t.tax).toBe(726_982)                // floor(7,269,820 × 0.1)
    expect(t.totalIncludingTax).toBe(7_996_802)
  })

  it('uses misc_expense_override instead of 8% when set (including 0)', () => {
    const t = calculateEstimateTotals(ITEMS_7996802, { miscExpenseOverride: 0, roundingDiscount: 0 })
    expect(t.overhead).toBe(0)
    expect(t.preTaxTotal).toBe(6_731_320)
    expect(t.tax).toBe(673_132)
    expect(t.totalIncludingTax).toBe(7_404_452)
  })

  it('floors the tax', () => {
    const t = calculateEstimateTotals([{ quantity: 1, selling_price: 1_009, amount: null }], { miscExpenseOverride: 0, roundingDiscount: 0 })
    expect(t.tax).toBe(100) // 100.9 → 100
  })

  it('returns all zeros for an empty estimate', () => {
    const t = calculateEstimateTotals([], { miscExpenseOverride: null, roundingDiscount: 0 })
    expect(t).toEqual({ itemSubtotal: 0, overhead: 0, roundingDiscount: 0, preTaxTotal: 0, tax: 0, totalIncludingTax: 0 })
  })

  it('liveAmount: selling_price wins, amount is the fallback, null/null is 0', () => {
    expect(liveAmount({ quantity: 2.5, selling_price: 1_333, amount: 1 })).toBe(3_333)
    expect(liveAmount({ quantity: 3, selling_price: null, amount: 777 })).toBe(777)
    expect(liveAmount({ quantity: 3, selling_price: null, amount: null })).toBe(0)
  })

  it('matches the pre-refactor EstimateTab formula exactly (Before/After parity)', () => {
    const cases: Array<[EstimateTotalItem[], number | null, number]> = [
      [ITEMS_7996802, null, 6],
      [ITEMS_7996802, 500_000, 0],
      [ITEMS_7996802, 0, 12_345],
      [[], null, 0],
      [[{ quantity: 0.333, selling_price: 12_345.5, amount: null }, { quantity: 7, selling_price: 99, amount: null }], null, 1],
    ]
    for (const [items, override, discount] of cases) {
      const before = legacyEstimateTabTotals(items, override, discount)
      const after  = calculateEstimateTotals(items, { miscExpenseOverride: override, roundingDiscount: discount })
      expect(after.itemSubtotal).toBe(before.subtotal)
      expect(after.overhead).toBe(before.miscExpense)
      expect(after.preTaxTotal).toBe(before.taxBase)
      expect(after.tax).toBe(before.tax)
      expect(after.totalIncludingTax).toBe(before.total)
    }
  })
})

describe('executeGetEstimateTotal (get_estimate_total)', () => {
  it('returns the same numbers as the shared function used by EstimateTab', async () => {
    const { client } = mockSupabase(dbFixture())
    const r = await executeGetEstimateTotal(client, PROJECT_A)
    const screen = calculateEstimateTotals(ITEMS_7996802, { miscExpenseOverride: null, roundingDiscount: 6 })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.item_count).toBe(ITEMS_7996802.length)
    expect(r.item_subtotal).toBe(screen.itemSubtotal)
    expect(r.overhead).toBe(screen.overhead)
    expect(r.overhead_source).toBe('default_rate')
    expect(r.rounding_discount).toBe(screen.roundingDiscount)
    expect(r.pre_tax_total).toBe(screen.preTaxTotal)
    expect(r.tax).toBe(screen.tax)
    expect(r.total_including_tax).toBe(7_996_802)
  })

  it('scopes to the current project and excludes deleted rows', async () => {
    const { client, calls } = mockSupabase(dbFixture())
    const r = await executeGetEstimateTotal(client, PROJECT_B)
    expect(r.status === 'ok' && r.item_count).toBe(1)
    expect(r.status === 'ok' && r.total_including_tax).toBe(5_500_000)
    expect(r.status === 'ok' && r.overhead_source).toBe('override')
    const itemsCall = calls.find(c => c.table === 'estimate_items')!
    expect(itemsCall.filters).toContainEqual(['eq', 'project_id', PROJECT_B])
    expect(itemsCall.filters).toContainEqual(['is', 'deleted_at', null])
    const projectCall = calls.find(c => c.table === 'projects')!
    expect(projectCall.filters).toContainEqual(['eq', 'id', PROJECT_B])
  })

  it('reports item_count = 0 for a project with no estimate rows', async () => {
    const db = dbFixture()
    db.projects.push({ id: 'empty', misc_expense_override: null, rounding_discount: 0, deleted_at: null })
    const { client } = mockSupabase(db)
    const r = await executeGetEstimateTotal(client, 'empty')
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.item_count).toBe(0)
    expect(r.status === 'ok' && r.total_including_tax).toBe(0)
  })

  it('returns status=error (not item_count 0) when the query fails or the project is not visible', async () => {
    const failing = await executeGetEstimateTotal(mockSupabase(dbFixture(), 'estimate_items').client, PROJECT_A)
    expect(failing.status).toBe('error')
    const otherCompany = await executeGetEstimateTotal(mockSupabase({ estimate_items: [], projects: [] }).client, PROJECT_A)
    expect(otherCompany.status).toBe('error')
  })
})

describe('get_estimate_total tool wiring', () => {
  it('is a project-mode tool with no input (no project_id / company_id / amounts from the AI)', () => {
    const tool = chatTools.find(t => t.name === TOOL_NAME.GET_ESTIMATE_TOTAL)
    expect(tool).toBeDefined()
    expect(tool!.input_schema.properties).toEqual({})
    expect(tool!.input_schema.required).toBeUndefined()
    expect(PROJECT_SCOPED_TOOLS.has(TOOL_NAME.GET_ESTIMATE_TOTAL)).toBe(true)
    expect(companyTools.some(t => t.name === TOOL_NAME.GET_ESTIMATE_TOTAL)).toBe(false)
  })

  it('tool description covers the total/tax/overhead questions', () => {
    const desc = chatTools.find(t => t.name === TOOL_NAME.GET_ESTIMATE_TOTAL)!.description!
    for (const phrase of ['見積金額を教えて', '税込', '税抜', '諸経費']) expect(desc).toContain(phrase)
  })

  it('search_estimates no longer claims to answer totals and explains not_found', () => {
    const desc = chatTools.find(t => t.name === TOOL_NAME.SEARCH_ESTIMATES)!.description!
    expect(desc).not.toContain('見積の合計')
    expect(desc).toContain('get_estimate_total')
    expect(desc).toContain('見積項目が存在しない」ことを意味しない')
  })

  it('project-mode prompt rules route total questions to get_estimate_total', () => {
    expect(ESTIMATE_TOTAL_PROMPT_RULES).toContain('get_estimate_total')
    expect(ESTIMATE_TOTAL_PROMPT_RULES).toContain('この案件の見積はいくら')
    expect(ESTIMATE_TOTAL_PROMPT_RULES).toContain('item_count が 0 のときだけ')
    expect(ESTIMATE_TOTAL_PROMPT_RULES).toContain('not_found')
  })

  it('dispatchTool uses the server-injected project_id and ignores AI input', async () => {
    const { client, calls } = mockSupabase(dbFixture())
    const res = await dispatchTool(TOOL_NAME.GET_ESTIMATE_TOTAL, { project_id: PROJECT_B }, {
      projectId: PROJECT_A, companyId: 'c', supabase: client,
    })
    const parsed = JSON.parse(res.serialized)
    expect(parsed.total_including_tax).toBe(7_996_802)
    expect(res.pending).toBeUndefined()
    expect(calls.find(c => c.table === 'estimate_items')!.filters).toContainEqual(['eq', 'project_id', PROJECT_A])
  })

  it('dispatchTool rejects get_estimate_total in company mode', async () => {
    const { client, calls } = mockSupabase(dbFixture())
    const res = await dispatchTool(TOOL_NAME.GET_ESTIMATE_TOTAL, {}, { projectId: null, companyId: 'c', supabase: client })
    expect(JSON.parse(res.serialized).status).toBe('error')
    expect(calls).toHaveLength(0)
  })
})
