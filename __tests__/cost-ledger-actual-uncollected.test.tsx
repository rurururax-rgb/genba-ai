// @vitest-environment jsdom
/**
 * 原価台帳の「請求粗利率」: 実績原価が 1 行も無ければ「未集計」と出し、0 % や粗利の金額を出さない。
 * 一部の行だけ実績原価があるときは、何項目分の業者請求かを出す（0 円は入力済みとして数える）。
 * fetch は模擬（本番 DB には接続しない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CostLedgerTab } from '@/components/projects/CostLedgerTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (id: string, actual: number | null) => ({
  id, name: `架空の工事${id}`, quantity: 1, unit: '式', estimate_cost: 100000, budget_cost: 100000, completion_cost: null, actual_cost: actual,
  note: null, vendor_name: null, sort_order: 0, source: 'from_estimate', estimate_item_id: `est-${id}`, invoice_count: 0, estimate_removed: false,
})

function ledger(actuals: Array<number | null>) {
  const items = actuals.map((a, i) => item(String(i), a))
  const withActual = items.filter(i => i.actual_cost != null)
  return {
    items, vendorSelling: {},
    summary: {
      estimate_revenue: 500000, estimate_cost_total: 100000 * items.length, contract_amount: 500000, base_contract_amount: 500000,
      additional_amount_1: null, additional_amount_2: null, additional_amount_3: null,
      budget_cost_total: 100000 * items.length, completion_cost_total: 0,
      actual_cost_total: withActual.reduce((s, i) => s + (i.actual_cost ?? 0), 0),
      has_budget_data: true, has_completion_data: false, has_actual_data: withActual.length > 0,
    },
  }
}

let container: HTMLDivElement
let root: Root
let current: ReturnType<typeof ledger>
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/cost-ledger?')) return json(current)
    if (url.startsWith('/api/project-billing')) return json([])
    throw new Error(`unexpected fetch ${url}`)
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function invoiceCard(actuals: Array<number | null>): Promise<string> {
  current = ledger(actuals)
  await act(async () => { root.render(<CostLedgerTab projectId="project-1" />) })
  await flush()
  await flush()
  const label = [...container.querySelectorAll('span')].find(s => s.textContent === '請求粗利率')
  expect(label).toBeTruthy()
  return label!.parentElement!.parentElement!.textContent ?? ''
}

describe('請求粗利率のカード', () => {
  it('実績原価が全行 NULL（初期化直後）: 「未集計」と出し、率・粗利を出さない', async () => {
    const text = await invoiceCard([null, null, null])
    expect(text).toContain('未集計')
    expect(text).not.toContain('%')
    expect(text).not.toContain('売上')   // 売上・業者請求・粗利の金額欄を出さない
  })

  it('一部の行だけ実績原価がある: 何項目分の業者請求かを出す', async () => {
    const text = await invoiceCard([200000, null, null])
    expect(text).toContain('業者請求（3 項目中 1 項目）')
    expect(text).toContain('60.0%')   // (500,000 − 200,000) ÷ 500,000
  })

  it('0 円は入力済みとして数える（NULL と区別）', async () => {
    const text = await invoiceCard([0, 0, 0])
    expect(text).not.toContain('未集計')
    expect(text).toContain('業者請求')
    expect(text).not.toContain('項目中')
    expect(text).toContain('100.0%')
  })
})
