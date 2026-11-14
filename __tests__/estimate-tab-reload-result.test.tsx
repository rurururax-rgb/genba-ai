// @vitest-environment jsdom
/**
 * EstimateTab の reload が「明細を取得できたか」を返し、「過去見積から追加」がそれを使うこと。
 * Supabase（ブラウザ用クライアント）と fetch は模擬する（DB には接続しない）。すべて架空のデータ。
 *
 * - 明細の取得が成功 → true（コピー後はダイアログを閉じる）
 * - 明細の取得がエラー → false（「追加済み・画面更新に失敗」と案内し、閉じない・もう一度は追加させない）
 * - 例外（reject）→ false（同上）。再試行して取得できたら閉じる
 * - 既存の表示（初回の読み込み）は変わらない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '00000000-0000-4000-8000-000000000011'
const HIT_ID = '00000000-0000-4000-8000-000000000101'

/** estimate_items の読み込み結果を切り替える */
const db = vi.hoisted(() => ({
  itemsMode: 'ok' as 'ok' | 'error' | 'throw',
  itemsCalls: 0,
}))

function result(table: string) {
  if (table === 'estimate_groups') return { data: [{ id: '00000000-0000-4000-8000-000000000021', label: '内装', display_mode: 'detailed', sort_order: 0 }], error: null }
  if (table === 'projects') return { data: { misc_expense_override: null, rounding_discount: 0, markup_rate: 1.45 }, error: null }
  if (table === 'estimate_items') {
    db.itemsCalls++
    if (db.itemsMode === 'error') return { data: null, error: { code: 'XX000', message: 'items failed' } }
    return {
      data: [{
        id: '00000000-0000-4000-8000-000000000201', name: '既存の明細', category: null, quantity: 1, unit: '式', selling_price: 1000, amount: 1000,
        retail_price: null, cost_price: null, vendor_name: null, group_id: '00000000-0000-4000-8000-000000000021', sort_order: 0, source: 'manual',
        line_event_id: null, memo: null, row_type: 'item', selling_price_mode: 'manual', markup_rate_override: null, internal_memo: null,
      }],
      error: null,
    }
  }
  return { data: [], error: null }
}

vi.mock('@/lib/supabase/client', () => {
  const client = {
    from(table: string) {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'neq', 'not']) q[m] = () => q
      const run = async () => {
        if (table === 'estimate_items' && db.itemsMode === 'throw') { db.itemsCalls++; throw new TypeError('Failed to fetch') }
        return result(table)
      }
      q.single = run
      q.maybeSingle = run
      q.then = (ok: (v: unknown) => unknown, ng?: (e: unknown) => unknown) => run().then(ok, ng)
      return q
    },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: () => undefined,
  }
  return { getClient: () => client, createClient: () => client }
})

const HIT = {
  id: HIT_ID, name: 'システムキッチン交換', quantity: 1, unit: '台', cost_price: 100000, selling_price: 145000, selling_price_mode: 'auto',
  vendor_name: '架空設備', category: null, created_at: '2026-02-28T16:00:00Z',
  project: { id: '00000000-0000-4000-8000-000000000012', name: '架空邸', status: 'done', created_at: null },
  group: null,
  copy_preview: { basis: 'auto_recalculated', selling_price_mode: 'auto', past_selling_price: 145000, new_selling_price: 145000, difference: 0, changed: false, applied_markup_rate: 1.45, fingerprint: 'v1-00000000000101' },
}

let container: HTMLDivElement
let root: Root
let posts: number

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  db.itemsMode = 'ok'
  db.itemsCalls = 0
  posts = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/estimate-items/search-past')) return json({ items: [HIT], has_more: false })
    if (String(url) === '/api/estimate-items/copy-from-past') { posts++; return json({ inserted_count: 1 }, 201) }
    if (String(url).startsWith('/api/estimate-revisions')) return json([])
    return json({})
  }))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const button = (re: RegExp) => [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined
const dialogOpen = () => !!document.querySelector('[aria-labelledby="past-estimate-picker-title"]')
const text = () => document.body.textContent ?? ''

async function renderTab() {
  const { EstimateTab } = await import('@/components/projects/EstimateTab')
  await act(async () => { root.render(<EstimateTab projectId={P} />) })
  await flush(10)
}

async function copyOne() {
  await act(async () => { button(/^過去見積から追加$/)!.click() })
  const input = document.querySelector('input[type="search"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'キッチン')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  await act(async () => { (document.querySelector('input[type="checkbox"][aria-label^="システムキッチン交換"]') as HTMLInputElement).click() })
  await act(async () => { button(/件を「/)!.click() })
  await flush(10)
}

describe('EstimateTab.reload の結果と「過去見積から追加」', () => {
  it('初回の読み込みで既存の明細を表示する（既存の動作）', async () => {
    await renderTab()
    expect(db.itemsCalls).toBe(1)
    expect([...document.querySelectorAll('input, textarea')].some(el => (el as HTMLInputElement).value === '既存の明細') || text().includes('既存の明細')).toBe(true)
  })

  it('コピー成功後の読み込み直しが成功 → ダイアログを閉じる', async () => {
    await renderTab()
    await copyOne()
    expect(posts).toBe(1)
    expect(db.itemsCalls).toBe(2)
    expect(dialogOpen()).toBe(false)
  })

  it('コピー成功後に明細の取得がエラー → 「追加済み・画面更新に失敗」と案内し、閉じず、もう一度は追加させない。再試行で閉じる', async () => {
    await renderTab()
    db.itemsMode = 'error'
    await copyOne()
    expect(posts).toBe(1)
    expect(dialogOpen()).toBe(true)
    expect(text()).toContain('1件は追加済みです')
    expect(text()).toContain('見積の画面を更新できませんでした')
    expect(button(/件を「/)).toBeUndefined()

    // 再試行も失敗（reject）→ 閉じない
    db.itemsMode = 'throw'
    await act(async () => { button(/^見積を読み込み直す$/)!.click() })
    await flush(10)
    expect(dialogOpen()).toBe(true)
    expect(text()).toContain('追加は完了していますが、見積の読み込み直しに失敗しました')
    expect(button(/件を「/)).toBeUndefined()

    // 再試行が成功 → 閉じる。追加の POST は最初の 1 回だけ
    db.itemsMode = 'ok'
    await act(async () => { button(/^見積を読み込み直す$/)!.click() })
    await flush(10)
    expect(dialogOpen()).toBe(false)
    expect(posts).toBe(1)
  })

  it('コピー成功後の読み込み直しが例外（reject）でも同じく閉じない', async () => {
    await renderTab()
    db.itemsMode = 'throw'
    await copyOne()
    expect(dialogOpen()).toBe(true)
    expect(text()).toContain('1件は追加済みです')
  })
})
