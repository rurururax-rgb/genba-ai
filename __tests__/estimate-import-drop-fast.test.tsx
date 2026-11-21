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
import { noteImportResponse, resetImportIdempotencyForTest } from '@/lib/estimate/import-result'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '00000000-0000-4000-8000-000000000011'
const G = '00000000-0000-4000-8000-000000000021'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const row = (n: number, sort_order: number, p: Record<string, unknown> = {}) => ({
  id: id(n), name: `架空 既存${n}`, category: null, quantity: 1, unit: '式', selling_price: 1450, amount: 1450,
  retail_price: null, cost_price: 1000, vendor_name: null, group_id: G, sort_order, source: 'manual',
  line_event_id: null, memo: null, row_type: 'item', selling_price_mode: 'auto', markup_rate_override: null, internal_memo: null, ...p,
})

const db = vi.hoisted(() => ({ itemsCalls: 0, items: [] as unknown[], itemsError: false }))

vi.mock('@/lib/supabase/client', () => {
  const result = (table: string) => {
    if (table === 'estimate_groups') return { data: [{ id: '00000000-0000-4000-8000-000000000021', label: '内装', display_mode: 'detailed', sort_order: 0 }], error: null }
    if (table === 'projects') return { data: { misc_expense_override: null, rounding_discount: 0, markup_rate: 1.45 }, error: null }
    if (table === 'estimate_items') {
      db.itemsCalls++
      if (db.itemsError) return { data: null, error: { code: 'XX000', message: 'offline' } }
      return { data: [...db.items], error: null }
    }
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
let autoImport: ((body: Record<string, unknown>) => Response | Promise<Response>) | null
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
  db.itemsError = false
  // 連番の並び順（取り込み API で末尾に入った明細と同じ）。間に入れるには振り直しが要る
  db.items = [row(201, 0), row(202, 1), row(203, 2)]
  calls = []; autoImport = null; events = []
  resetImportDragForTest()
  resetImportIdempotencyForTest()
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
      if (autoImport) { calls.push({ url: u, body, release: () => {} }); const f = autoImport; return Promise.resolve().then(() => f(body)) }
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
async function dropAfter(n: number, importId: string, name: string, cost: number | null = 100000, requestId?: string) {
  const token = startImportDrag({ projectId: P, item: { _importId: importId, name, quantity: 1, unit: '台', cost_price: cost, vendor_name: '架空設備', memo: '', ...(requestId ? { import_request_id: requestId } : {}) }, check: () => null })
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
    await act(async () => imports()[0].release(json({ error: '架空の保存エラー', not_saved: true }, 500)))
    await flush()
    expect(pendingRows()).toHaveLength(0)
    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(3)
    expect(events.find(e => e.type === 'genba:import-item-failed')?.detail).toEqual({ importId: 'imp-1', error: '架空の保存エラー' })
    expect(events.some(e => e.type === 'genba:import-item-moved')).toBe(false)
  })

  it('通信が切れたときは、DB を確かめてから仮の行を消し、確認を促す（保存されたか分からないため）', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await act(async () => imports()[0].release(Promise.reject(new TypeError('Failed to fetch')) as unknown as Response))
    await flush()
    // 確かめている間は仮の行を残す
    expect(pendingRows()).toHaveLength(1)
    await flush(1700)
    expect(pendingRows()).toHaveLength(0)
    expect(events.find(e => e.type === 'genba:import-item-failed')?.detail).toMatchObject({ importId: 'imp-1', uncertain: true })
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

/** サーバーが保存した明細（DB に入れる）。応答を返すかは各テストで決める */
let seq = 300
const insertIntoDb = (body: Record<string, unknown>) => {
  const it = (body.items as Array<Record<string, unknown>>)[0]
  const r = row(++seq, Number(body.sort_order ?? 9999), { name: it.name, quantity: it.quantity, unit: it.unit, cost_price: it.cost_price, selling_price: 145000, amount: 145000, source: 'import' })
  db.items.push(r)
  return r
}
const lost = () => Promise.reject(new TypeError('Failed to fetch'))
const failedEvents = () => events.filter(e => e.type === 'genba:import-item-failed').map(e => e.detail)
const movedIds = () => events.filter(e => e.type === 'genba:import-item-moved').map(e => e.detail.importId)
const rowsNamed = (name: string) => [...document.querySelectorAll('[data-row-id]')].filter(el => el.textContent?.includes(name))

describe('保存の結果が分からないとき（通信が途切れた）', () => {
  beforeEach(() => { seq = 300 })

  it('DB には保存できて応答だけ失った → DB を読み直して見つけ、保存済みとして扱う（失敗にしない・二重に登録しない）', async () => {
    await renderTab()
    autoImport = body => { insertIntoDb(body); return lost() }
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(imports()).toHaveLength(1)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(pendingRows()).toHaveLength(0)
    expect(failedEvents()).toEqual([])
    expect(movedIds()).toEqual(['imp-1'])
    expect(db.itemsCalls).toBe(2)
  })

  it('本文のない 504（保存済み）も同じく読み直して見つける', async () => {
    await renderTab()
    autoImport = body => { insertIntoDb(body); return new Response('An error occurred', { status: 504 }) }
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(movedIds()).toEqual(['imp-1'])
  })

  it('遅れて保存された場合も、少し待った 2 回目の読み直しで見つける', async () => {
    await renderTab()
    autoImport = body => { setTimeout(() => insertIntoDb(body), 500); return lost() }
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(1700)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(failedEvents()).toEqual([])
    expect(movedIds()).toEqual(['imp-1'])
  })

  it('保存されていなかった → 「失敗・もう一度どうぞ」ではなく、確認を促す（uncertain）。候補は残す', async () => {
    await renderTab()
    autoImport = () => lost()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(1700)
    expect(rowsNamed('架空 給湯器')).toHaveLength(0)
    expect(pendingRows()).toHaveLength(0)
    expect(failedEvents()).toEqual([expect.objectContaining({ importId: 'imp-1', uncertain: true, error: expect.stringContaining('同じ明細がないこと') })])
    expect(movedIds()).toEqual([])
  })

  it('読み直しもできない（オフライン）→ 確認を促す。通信が戻って同じ候補をドロップしたら、遅れて保存されていた明細を見つけて送らない', async () => {
    await renderTab()
    db.itemsError = true
    let saved: Record<string, unknown> | null = null
    autoImport = body => { saved = body; return lost() }
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(1700)
    expect(failedEvents()).toEqual([expect.objectContaining({ importId: 'imp-1', uncertain: true, error: expect.stringContaining('通信が戻ってから') })])

    // 実はサーバーでは保存されていた。通信が戻ってから、人が確認して同じ候補をもう一度ドロップ
    insertIntoDb(saved!)
    db.itemsError = false
    autoImport = body => savedReply(999, body)
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(imports()).toHaveLength(1)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(movedIds()).toEqual(['imp-1'])
    expect(document.body.textContent).toContain('もう一度は追加していません')
  })

  it('もう一度ドロップしたとき、前回の分が保存されていなければ 1 回だけ登録する', async () => {
    await renderTab()
    autoImport = () => lost()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(1700)
    autoImport = body => { const r = insertIntoDb(body); return json({ created: 1, items: [r] }) }
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(imports()).toHaveLength(2)
    expect(db.items.filter(i => (i as { name: string }).name === '架空 給湯器')).toHaveLength(1)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(movedIds()).toEqual(['imp-1'])
  })

  it('サーバーが断った（エラー本文つき）ときは、読み直さず通常の失敗にする（uncertain なし）', async () => {
    await renderTab()
    autoImport = () => json({ error: 'Group not found' }, 404)
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(10)
    expect(failedEvents()).toEqual([{ importId: 'imp-1', error: 'Group not found' }])
    expect(db.itemsCalls).toBe(1)
  })

  it('同じ中身の明細が前からあっても、それを今回の登録と取り違えない', async () => {
    db.items = [row(201, 0), row(202, 1), row(203, 2), row(250, 3, { name: '架空 給湯器', quantity: 1, unit: '台', cost_price: 100000, source: 'import' })]
    await renderTab()
    autoImport = () => lost()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await flush(1700)
    expect(failedEvents()).toEqual([expect.objectContaining({ uncertain: true })])
    expect(movedIds()).toEqual([])
  })
})

describe('連続保存の途中の失敗・ほかの読み直し', () => {
  beforeEach(() => { seq = 300 })

  it('10 件のうち 4 件目だけ失敗 → 後続は続けて保存し、並び順は崩れない。失敗した明細は入らない', async () => {
    await renderTab()
    let n = 0
    autoImport = body => { n++; if (n === 4) return json({ error: '架空の保存エラー', not_saved: true }, 500); const r = insertIntoDb(body); return json({ created: 1, items: [r] }) }
    for (let i = 1; i <= 10; i++) await dropAfter(203, `imp-${i}`, `架空 連続${String(i).padStart(2, '0')}`)
    await flush(50)
    expect(imports()).toHaveLength(10)
    expect(pendingRows()).toHaveLength(0)
    const names = [...document.querySelectorAll('[data-row-id]')].map(el => el.textContent?.match(/架空 (既存\d{3}|連続\d{2})/)?.[1])
    // 203 の直後へ続けてドロップ → 後のものほど前。4 件目は入らない
    expect(names).toEqual(['既存201', '既存202', '既存203', '連続10', '連続09', '連続08', '連続07', '連続06', '連続05', '連続03', '連続02', '連続01'])
    expect(failedEvents()).toEqual([{ importId: 'imp-4', error: '架空の保存エラー' }])
    const orders = (db.items as Array<{ sort_order: number }>).map(i => i.sort_order)
    expect(new Set(orders).size).toBe(orders.length)
    expect(db.itemsCalls).toBe(1)
  })

  it('保存中にほかの処理で読み直しが起きて新しい明細が先に出ても、応答の反映で二重に表示しない', async () => {
    await renderTab()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    const saved = insertIntoDb(imports()[0].body)
    // AI チャットなどの通知で読み直し（DB には保存済み）
    await act(async () => { window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } })) })
    await flush()
    expect(pendingRows()).toHaveLength(1)
    await act(async () => imports()[0].release(json({ created: 1, items: [saved] })))
    await flush()
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(pendingRows()).toHaveLength(0)
  })

  it('結果の分からない保存の確認中に見積エディタを閉じても、例外を出さず候補に確認を促す', async () => {
    await renderTab()
    autoImport = () => lost()
    await dropAfter(203, 'imp-1', '架空 給湯器')
    await act(async () => root.unmount())
    await flush(1700)
    expect(failedEvents()).toEqual([expect.objectContaining({ importId: 'imp-1', uncertain: true })])
    root = createRoot(container)
  })
})

describe('登録 ID（import_request_id）', () => {
  const RID = '11111111-2222-4333-8444-555555555555'
  beforeEach(() => { seq = 300 })

  it('取り込み候補の登録 ID を登録 API に送る', async () => {
    await renderTab()
    autoImport = body => savedReply(301, body)
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush()
    expect((imports()[0].body.items as Array<Record<string, unknown>>)[0].import_request_id).toBe(RID)
  })

  it('登録 API が二重登録を防げると分かっていれば、結果が分からないとき同じ ID で 1 回だけ送り直し、保存済みの明細で確定する（照合の読み直しなし）', async () => {
    noteImportResponse({ idempotent: true })
    await renderTab()
    let n = 0
    let savedRow: ReturnType<typeof row> | null = null
    autoImport = body => {
      n++
      if (n === 1) { savedRow = insertIntoDb(body); return lost() }   // 保存後に応答だけ失う
      return json({ created: 0, replayed: 1, idempotent: true, items: [savedRow] })   // 同じ ID の再送 → 保存済みを返す
    }
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush(1000)
    expect(imports()).toHaveLength(2)
    expect(imports().map(c => (c.body.items as Array<Record<string, unknown>>)[0].import_request_id)).toEqual([RID, RID])
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(movedIds()).toEqual(['imp-1'])
    expect(failedEvents()).toEqual([])
    expect(db.itemsCalls).toBe(1)
  })

  it('二重登録を防げるか分からない（idempotent の応答をまだ受けていない）ときは自動で送り直さず、DB で照合する', async () => {
    await renderTab()
    autoImport = body => { insertIntoDb(body); return lost() }
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush(10)
    expect(imports()).toHaveLength(1)
    expect(db.itemsCalls).toBe(2)
    expect(movedIds()).toEqual(['imp-1'])
  })

  it('migration 未適用の応答（idempotent: false）を受けたら、結果が分からなくても送り直さない', async () => {
    noteImportResponse({ idempotent: true })
    noteImportResponse({ idempotent: false })
    await renderTab()
    autoImport = () => lost()
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush(1700)
    expect(imports()).toHaveLength(1)
    expect(failedEvents()).toEqual([expect.objectContaining({ uncertain: true })])
  })

  it('同じ登録 ID が違う内容で登録済み（409）→ 見積を読み直し、取り込みパネルに conflict を返す（uncertain ではない）', async () => {
    await renderTab()
    autoImport = () => json({ error: '前回の送信で、違う内容で登録されています', code: 'import_request_conflict', not_saved: true, import_request_id: RID }, 409)
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush(10)
    expect(db.itemsCalls).toBe(2)
    expect(failedEvents()).toEqual([{ importId: 'imp-1', error: '前回の送信で、違う内容で登録されています', conflict: true }])
    expect(pendingRows()).toHaveLength(0)
  })

  it('結果が分からないとき not_saved の無い 503（API と DB の通信断）も「分からない」として扱う', async () => {
    await renderTab()
    autoImport = body => { insertIntoDb(body); return json({ error: 'データベースとの通信が途切れました', not_saved: false }, 503) }
    await dropAfter(203, 'imp-1', '架空 給湯器', 100000, RID)
    await flush(10)
    expect(rowsNamed('架空 給湯器')).toHaveLength(1)
    expect(movedIds()).toEqual(['imp-1'])
  })
})
