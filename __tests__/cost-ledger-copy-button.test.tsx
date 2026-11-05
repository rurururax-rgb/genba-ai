// @vitest-environment jsdom
/**
 * 原価台帳の「見積から引用」ボタンを出さない（受け手のない未完成の機能だったため）。
 * 行を選んでもボタンは出ず、「見積と同期」はこれまでどおり同期 API を呼ぶことを、画面を描画して確かめる。
 * fetch は模擬（本番 DB には接続しない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CostLedgerTab } from '@/components/projects/CostLedgerTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = 'project-1'
const item = (id: string, name: string) => ({
  id, name, quantity: 1, unit: '式', estimate_cost: 1000, budget_cost: null, completion_cost: null, actual_cost: null,
  note: null, vendor_name: null, sort_order: 0, source: 'from_estimate', estimate_item_id: `est-${id}`, invoice_count: 0, estimate_removed: false,
})
const LEDGER = {
  items: [item('a', '架空の給湯器工事'), item('b', '架空の内装工事')],
  vendorSelling: {},
  summary: {
    estimate_revenue: 0, estimate_cost_total: 2000, contract_amount: 0, base_contract_amount: 0,
    additional_amount_1: null, additional_amount_2: null, additional_amount_3: null,
    budget_cost_total: 0, completion_cost_total: 0, actual_cost_total: 0,
    has_budget_data: false, has_completion_data: false, has_actual_data: false,
  },
}

let container: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: unknown }>
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('/api/cost-ledger?')) return json(LEDGER)
    if (url.startsWith('/api/project-billing')) return json([])
    if (url === '/api/cost-ledger/sync') return json({ added: 0, updated: 0, removed: 0, kept: [], deduplicated: 0, duplicates: [] })
    throw new Error(`unexpected fetch ${url}`)
  }))
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('alert', vi.fn())
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
const buttons = () => [...container.querySelectorAll('button')].map(b => b.textContent ?? '')

async function mount() {
  await act(async () => { root.render(<CostLedgerTab projectId={PROJECT} />) })
  await flush()
  await flush()
}

describe('原価台帳：「見積から引用」ボタンを出さない', () => {
  it('行を選んでも「見積から引用」は出ない（選択件数の表示は従来どおり）', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    await mount()
    // 「明細」表示に切り替える（行の選択とボタンは明細表示にある）
    const itemView = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '明細')
    await act(async () => { itemView!.click() })
    await flush()
    expect(container.textContent).toContain('架空の給湯器工事')
    expect(buttons().some(t => t.includes('見積から引用'))).toBe(false)

    const rowBoxes = [...container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')]
    expect(rowBoxes.length).toBeGreaterThan(0)
    await act(async () => { rowBoxes[0].click() })
    await flush()
    expect(container.textContent).toContain('1件選択中')
    expect(buttons().some(t => t.includes('見積から引用'))).toBe(false)
    expect(dispatch.mock.calls.some(([e]) => e.type === 'genba:copy-to-estimate')).toBe(false)
  })

  it('「見積と同期」はこれまでどおり表示され、押すと同期 API を 1 回呼んで台帳を読み直す', async () => {
    await mount()
    const sync = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('見積と同期'))
    expect(sync).toBeTruthy()
    const loadsBefore = calls.filter(c => c.url.startsWith('/api/cost-ledger?')).length
    await act(async () => { sync!.click() })
    await flush()
    await flush()
    const posts = calls.filter(c => c.url === '/api/cost-ledger/sync')
    expect(posts).toEqual([{ url: '/api/cost-ledger/sync', method: 'POST', body: { project_id: PROJECT } }])
    expect(calls.filter(c => c.url.startsWith('/api/cost-ledger?')).length).toBe(loadsBefore + 1)
  })
})
