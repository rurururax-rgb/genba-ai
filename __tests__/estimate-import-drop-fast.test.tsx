// @vitest-environment jsdom
/**
 * 見積書 OCR の明細を見積エディタへドロップしたときの表示と保存（EstimateTab）。
 * Supabase（ブラウザ用クライアント）と fetch は模擬する（DB には接続しない）。すべて架空のデータ。
 *
 * - ドロップ直後に「保存中」の仮の行を出す。保存できたら登録 API が返した明細に置き換え、全件を読み直さない
 * - 保存できなければ仮の行を消し、取り込みパネルに理由を返す（候補は消さない）
 * - 続けてドロップしても保存は 1 件ずつ。並び順は前の保存結果を見て決める
 * - 同じ候補の二重ドロップは 1 回だけ登録する
 * - 取り込みパネルの「追加」は、保存された明細が付いていればそれを反映する（読み直さない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IMPORT_DRAG_TYPE, resetImportDragForTest, startImportDrag } from '@/lib/estimate/import-drag'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '00000000-0000-4000-8000-000000000011'
const G = '00000000-0000-4000-8000-000000000021'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const row = (n: number, sort_order: number, p: Record<string, unknown> = {}) => ({
  id: id(n), name: `架空 既存${n}`, category: null, quantity: 1, unit: '式', selling_price: 1450, amount: 1450,
  retail_price: null, cost_price: 1000, vendor_name: null, group_id: G, sort_order, source: 'manual',
  line_event_id: null, memo: null, row_type: 'item', selling_price_mode: 'auto', markup_rate_override: null, internal_memo: null, ...p,
})

const db = vi.hoisted(() => ({ itemsCalls: 0, items: [] as unknown[] }))

vi.mock('@/lib/supabase/client', () => {
  const result = (table: string) => {
    if (table === 'estimate_groups') return { data: [{ id: '00000000-0000-4000-8000-000000000021', label: '内装', display_mode: 'detailed', sort_order: 0 }], error: null }
    if (table === 'projects') return { data: { misc_expense_override: null, rounding_discount: 0, markup_rate: 1.45 }, error: null }
    if (table === 'estimate_items') { db.itemsCalls++; return { data: db.items, error: null } }
    return { data: [], error: null }
  }
  const client = {
    from(table: string) {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'neq', 'not']) q[m] = () => q
      const run = async () => result(table)
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

type Call = { url: string; body: Record<string, unknown>; release: (r: Response) => void }
let calls: Call[]
let autoImport: ((body: Record<string, unknown>) => Response) | null
let events: Array<{ type: string; detail: Record<string, unknown> }>
let container: HTMLDivElement
let root: Root

const EVENT_TYPES = ['genba:import-item-adding', 'genba:import-item-moved', 'genba:import-item-failed', 'genba:data-changed']
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail })
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
/** 登録 API と同じ形の応答（DB が確定した値） */
const savedReply = (n: number, body: Record<string, unknown>, p: Record<string, unknown> = {}) => {
  const it = (body.items as Array<Record<string, unknown>>)[0]
  return json({ created: 1, items: [row(n, Number(body.sort_order ?? 9999), { name: it.name, quantity: it.quantity, unit: it.unit, cost_price: it.cost_price, selling_price: 145000, amount: 145000, source: 'import', ...p })] })
}

beforeEach(() => {
  db.itemsCalls = 0
  // 連番の並び順（取り込み API で末尾に入った明細と同じ）。間に入れるには振り直しが要る
  db.items = [row(201, 0), row(202, 1), row(203, 2)]
  calls = []; autoImport = null; events = []
  resetImportDragForTest()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/estimate-revisions')) return Promise.resolve(json([]))
    if (u === '/api/estimate-items/reorder' || u === '/api/estimate-items/import') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (u === '/api/estimate-items/reorder') { calls.push({ url: u, body, release: () => {} }); return Promise.resolve(json({ ok: true })) }
      if (autoImport) { calls.push({ url: u, body, release: () => {} }); return Promise.resolve(autoImport(body)) }
      return new Promise<Response>(r => calls.push({ url: u, body, release: r }))
    }
    return Promise.resolve(json({}))
  }))
  for (const type of EVENT_TYPES) window.addEventListener(type, record)
})

afterEach(async () => {
  for (const type of EVENT_TYPES) window.removeEventListener(type, record)
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const rowEl = (n: number) => document.querySelector(`[data-row-id="${id(n)}"]`) as HTMLElement
const pendingRows = () => [...document.querySelectorAll('[data-pending-row]')]
const imports = () => calls.filter(c => c.url === '/api/estimate-items/import')

async function renderTab() {
  const { EstimateTab } = await import('@/components/projects/EstimateTab')
  await act(async () => { root.render(<EstimateTab projectId={P} />) })
  await flush(10)
}

function dragEvent(type: string, token: string) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: [IMPORT_DRAG_TYPE], getData: (t: string) => (t === IMPORT_DRAG_TYPE ? token : ''), dropEffect: 'none' } })
  return e
}

/** 取り込みパネルの明細を、明細 n の直後へドロップする（jsdom は座標が 0 なので、dragover した行の直後になる） */
async function dropAfter(n: number, importId: string, name: string, cost: number | null = 100000) {
  const token = startImportDrag({ projectId: P, item: { _importId: importId, name, quantity: 1, unit: '台', cost_price: cost, vendor_name: '架空設備', memo: '' }, check: () => null })
  await act(async () => { rowEl(n).dispatchEvent(dragEvent('dragover', token)) })
  await act(async () => { rowEl(n).dispatchEvent(dragEvent('drop', token)) })
  await flush()
}

describe('ドロップ直後の表示と保存', () => {
  it('すぐに保存中の仮の行を出し、保存できたら登録 API の明細に置き換える（全件を読み直さない）', async () => {
    await renderTab()
    expect(db.itemsCalls).toBe(1)
    await dropAfter(202, 'imp-1', '架空 給湯器')

    // 仮の行（保存中）。明細（data-row-id）には入れない
    expect(pendingRows()).toHaveLength(1)
    expect(pendingRows()[0].textContent).toContain('架空 給湯器')
    expect(pendingRows()[0].textContent).toContain('保存中')
    expect(rowEl(202).contains(pendingRows()[0])).toBe(false)
    // 202 と 203 の間に空きがないので、先に既存の /reorder で振り直してから登録する
    expect(calls.map(c => c.url)).toEqual(['/api/estimate-items/reorder', '/api/estimate-items/import'])
    expect(imports()[0].body.sort_order).toBe(2000)
    expect(events.filter(e => e.type === 'genba:import-item-moved')).toHaveLength(0)

    await act(async () => imports()[0].release(savedReply(301, imports()[0].body)))
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect(rowEl(301)).toBeTruthy()
    // 並びは 202 → 新しい明細 → 203
    const order = [...document.querySelectorAll('[data-row-id]')].map(el => el.getAttribute('data-row-id'))
    expect(order).toEqual([id(201), id(202), id(301), id(203)])
    // 全件の読み直しをしない。ほかの画面向けの通知は出す（自分の変更と分かる origin 付き）
    expect(db.itemsCalls).toBe(1)
    expect(events.find(e => e.type === 'genba:data-changed')?.detail).toMatchObject({ target_table: 'estimate_items', origin: expect.any(String) })
    expect(events.filter(e => e.type === 'genba:import-item-moved').map(e => e.detail.importId)).toEqual(['imp-1'])
  })

  it('保存に失敗したら仮の行を消し、取り込みパネルに理由を返す（明細は増えない・候補は消さない）', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    expect(pendingRows()).toHaveLength(1)
    await act(async () => imports()[0].release(json({ error: '架空の保存エラー' }, 500)))
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(3)
    expect(events.find(e => e.type === 'genba:import-item-failed')?.detail).toEqual({ importId: 'imp-1', error: '架空の保存エラー' })
    expect(events.some(e => e.type === 'genba:import-item-moved')).toBe(false)
  })

  it('通信が切れたときも仮の行を消して理由を返す', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await act(async () => imports()[0].release(Promise.reject(new TypeError('Failed to fetch')) as unknown as Response))
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect(events.find(e => e.type === 'genba:import-item-failed')?.detail.importId).toBe('imp-1')
  })

  it('登録 API が明細を返さない（古いサーバー）ときは、従来どおり全件を読み直す', async () => {
    await renderTab()
    autoImport = () => json({ created: 1 })
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(db.itemsCalls).toBe(2)
    expect(pendingRows()).toHaveLength(0)
    expect(events.some(e => e.type === 'genba:import-item-moved')).toBe(true)
  })
})

describe('続けてドロップしたとき', () => {
  it('保存は 1 件ずつ。2 件目の並び順は 1 件目の保存結果を見て決める', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 一件目')
    await dropAfter(203, 'imp-2', '架空 二件目')
    // 両方とも仮の行で出る。後からドロップした方が 203 の直後（保存後の並びと同じ）
    expect(pendingRows().map(r => r.textContent?.match(/架空 \S+件目/)?.[0])).toEqual(['架空 二件目', '架空 一件目'])
    // 2 件目はまだ送らない
    expect(imports()).toHaveLength(1)
    expect(imports()[0].body.sort_order).toBe(1002)

    await act(async () => imports()[0].release(savedReply(301, imports()[0].body)))
    await flush()
    expect(imports()).toHaveLength(2)
    // 203（2）と 1 件目（1002）の間
    expect(imports()[1].body.sort_order).toBe(502)
    await act(async () => imports()[1].release(savedReply(302, imports()[1].body)))
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect([...document.querySelectorAll('[data-row-id]')].map(el => el.getAttribute('data-row-id'))).toEqual([id(201), id(202), id(203), id(302), id(301)])
    expect(db.itemsCalls).toBe(1)
  })

  it('同じ候補を保存中にもう一度ドロップしても、1 回だけ登録する', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await dropAfter(203, 'imp-1', '架空 給湯器')
    expect(pendingRows()).toHaveLength(1)
    await act(async () => imports()[0].release(savedReply(301, imports()[0].body)))
    await flush()
    expect(imports()).toHaveLength(1)
    expect(document.querySelectorAll(`[data-row-id="${id(301)}"]`)).toHaveLength(1)
  })

  it('別の案件の取り込み明細は受け付けない（仮の行も出さない）', async () => {
    await renderTab()
    const token = startImportDrag({ projectId: 'another-project', item: { _importId: 'imp-x', name: '架空 他案件', quantity: 1, unit: '式', cost_price: 1, vendor_name: '', memo: '' }, check: () => null })
    await act(async () => { rowEl(203).dispatchEvent(dragEvent('dragover', token)) })
    await act(async () => { rowEl(203).dispatchEvent(dragEvent('drop', token)) })
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect(imports()).toHaveLength(0)
    expect(String(events.find(e => e.type === 'genba:import-item-failed')?.detail.error)).toContain('別の案件')
  })

  it('保存中に見積エディタを閉じたら、まだ送っていない明細は送らずパネルに返す', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 一件目')
    await dropAfter(203, 'imp-2', '架空 二件目')
    await act(async () => root.unmount())
    await act(async () => imports()[0].release(savedReply(301, imports()[0].body)))
    await flush()
    expect(imports()).toHaveLength(1)
    expect(events.filter(e => e.type === 'genba:import-item-moved').map(e => e.detail.importId)).toEqual(['imp-1'])
    expect(events.find(e => e.type === 'genba:import-item-failed')?.detail.importId).toBe('imp-2')
    root = createRoot(container)
  })
})

describe('取り込みパネルの「追加」からの通知', () => {
  it('保存された明細が付いていれば反映し、読み直さない。付いていなければ読み直す', async () => {
    await renderTab()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items', project_id: P, items: [row(401, 5000, { group_id: G, name: '架空 パネル追加' })] } }))
    })
    await flush()
    expect(rowEl(401)).toBeTruthy()
    expect(db.itemsCalls).toBe(1)

    // 別の案件の明細は反映しない（読み直す）
    await act(async () => {
      window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items', project_id: 'another', items: [row(402, 6000)] } }))
    })
    await flush()
    expect(rowEl(402)).toBeNull()
    expect(db.itemsCalls).toBe(2)

    // AI チャットなど、明細の付いていない通知は従来どおり読み直す
    await act(async () => { window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } })) })
    await flush()
    expect(db.itemsCalls).toBe(3)
  })
})
