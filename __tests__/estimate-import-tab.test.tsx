// @vitest-environment jsdom
/**
 * 見積書 OCR 取り込み画面（EstimateImportTab）。画面を実際に描画し、fetch は模擬する（本番 DB には接続しない）。
 * - 画像は 1 枚ずつ送る（Vercel の 4.5MB 制限・画像ごとの失敗）
 * - 要確認の行は表示し、一括追加は確認を挟む。直した値で照合し直し、直した値を登録する
 * - 連打・ドラッグ中の追加で二重に登録しない
 * すべて架空の見積書。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EstimateImportTab } from '@/components/projects/EstimateImportTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GOOD = { name: '洗面化粧台 LX-750', quantity: 1, unit: '台', cost_price: 60000, cost_from: 'printed_unit_price', list_price: 100000, rate: 0.6, amount: 60000, vendor_name: '架空設備', note: null }
/** 数量 × 単価 が金額と合わない（金額欄を単価として読んだ）行 */
const BAD = { name: '配管部材', quantity: 3, unit: '式', cost_price: 15000, cost_from: 'printed_unit_price', list_price: null, rate: null, amount: 15000, vendor_name: '架空設備', note: null }

const fileResult = (fileName: string, items: unknown[], messages: unknown[] = []) =>
  ({ fileName, supplier: '架空設備', document_type: '御見積書', items, subtotal: null, adjustments: [], items_total: null, prices_include_tax: false, messages })

let container: HTMLDivElement
let root: Root
let extractCalls: Array<{ count: number; name: string }>
let imports: Array<Record<string, unknown>>
/** 画像名ごとの応答 */
let extractReply: (name: string) => Response
let importReply: () => Promise<Response>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  extractCalls = []
  imports = []
  extractReply = name => json({ files: [fileResult(name, [GOOD, BAD])], items: [GOOD, BAD], failures: [] })
  importReply = async () => json({ created: 1 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/ai/extract-estimate') {
      const files = (init?.body as FormData).getAll('files') as File[]
      extractCalls.push({ count: files.length, name: files[0].name })
      return extractReply(files[0].name)
    }
    if (url === '/api/estimate-items/import') {
      imports.push(JSON.parse(String(init?.body)))
      return importReply()
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<EstimateImportTab projectId="p1" />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() }) }

function choose(files: File[]) {
  const input = container.querySelector('input[type=file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}
const img = (name: string, type = 'image/jpeg') => new File([new Uint8Array(10)], name, { type, lastModified: 1 })
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const click = (b: HTMLElement | undefined) => act(() => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const cards = () => [...container.querySelectorAll('[data-testid=ocr-candidate]')] as HTMLElement[]

async function readImages(files: File[]) {
  choose(files)
  click(button('AIで読み取る'))
  await flush()
}

describe('送信', () => {
  it('画像は 1 枚ずつ別のリクエストで送る', async () => {
    await readImages([img('p1.jpg'), img('p2.jpg')])
    expect(extractCalls).toEqual([{ count: 1, name: 'p1.jpg' }, { count: 1, name: 'p2.jpg' }])
    expect(cards()).toHaveLength(4)
  })

  it('HEIC・PDF は選べず、理由を表示する（黙って捨てない）', () => {
    choose([img('IMG_1.HEIC', 'image/heic'), img('q.pdf', 'application/pdf')])
    expect(container.textContent).toContain('HEIC 形式のため読み取れません')
    expect(container.textContent).toContain('PDF のため読み取れません')
    expect(button('AIで読み取る')!.disabled).toBe(true)
  })

  it('1 枚が失敗（JSON でない 413）しても、もう 1 枚の明細は表示し、失敗した画像に案内を出す', async () => {
    extractReply = name => name === 'p2.jpg'
      ? new Response('Request Entity Too Large', { status: 413 })
      : json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
    await readImages([img('p1.jpg'), img('p2.jpg')])
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain('p2.jpg')
    expect(container.textContent).toContain('画像が大きすぎて送れませんでした')
  })

  it('AI の途中終了（502）は画面に日本語の案内を出し、明細を作らない', async () => {
    extractReply = () => json({ error: '明細が多く、読み取りが途中で終わりました。', code: 'ai_truncated' }, 502)
    await readImages([img('p1.jpg')])
    expect(cards()).toHaveLength(0)
    expect(container.textContent).toContain('読み取りが途中で終わりました')
  })

  it('画像全体の確認事項（値引きなど）を表示する', async () => {
    extractReply = name => json({ files: [fileResult(name, [GOOD], [{ level: 'warn', text: '原本に「出精値引」 ¥5,000 があります。' }])], items: [GOOD], failures: [] })
    await readImages([img('p1.jpg')])
    expect(container.textContent).toContain('出精値引')
  })
})

describe('要確認の行と人による修正', () => {
  it('数量 × 単価 が金額と合わない行は要確認として理由を表示する', async () => {
    await readImages([img('p1.jpg')])
    const [good, bad] = cards()
    expect(good.dataset.needsReview).toBe('false')
    expect(bad.dataset.needsReview).toBe('true')
    expect(bad.textContent).toContain('金額欄を単価として読んだ可能性')
    expect(container.textContent).toContain('うち 1件は要確認です')
  })

  it('一括追加は、要確認の行があると確認を挟む（連打しても確認なしでは送らない）', async () => {
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加'))
    click(button('残り全件を追加'))
    await flush()
    expect(imports).toHaveLength(0)
    expect(container.textContent).toContain('原本と照らして確認しましたか')
    click(button('確認したので追加する'))
    await flush()
    expect(imports).toHaveLength(1)
    expect((imports[0].items as unknown[]).length).toBe(2)
  })

  it('単価を直すと照合し直し、直した単価で登録する（売価は送らない）', async () => {
    await readImages([img('p1.jpg')])
    const bad = cards()[1]
    click([...bad.querySelectorAll('button')].find(b => b.textContent === '修正'))
    const costInput = [...bad.querySelectorAll('label')].find(l => l.textContent?.startsWith('原価単価'))!.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(costInput, '5000')
      costInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cards()[1].dataset.needsReview).toBe('false')
    click([...cards()[1].querySelectorAll('button')].find(b => b.textContent?.includes('追加')))
    await flush()
    expect(imports).toHaveLength(1)
    const sent = (imports[0].items as Array<Record<string, unknown>>)[0]
    expect(sent).toMatchObject({ name: '配管部材', quantity: 3, cost_price: 5000 })
    expect(sent).not.toHaveProperty('selling_price')
  })
})

describe('二重登録の防止', () => {
  it('「追加」の連打でも 1 回しか送らない', async () => {
    let release!: () => void
    importReply = () => new Promise(r => { release = () => r(json({ created: 1 })) })
    await readImages([img('p1.jpg')])
    const addBtn = [...cards()[0].querySelectorAll('button')].find(b => b.textContent?.includes('追加'))!
    click(addBtn); click(addBtn); click(addBtn)
    await flush()
    expect(imports).toHaveLength(1)
    release()
    await flush()
  })

  it('見積エディタへのドラッグで送信中の行は、追加ボタンから送れない', async () => {
    await readImages([img('p1.jpg')])
    const dragPayload = { _importId: '' }
    const handle = cards()[0].querySelector('[draggable]') as HTMLElement
    // ドラッグ開始時の payload から取り込み候補の id を得る
    const dt = { setData: (_t: string, v: string) => Object.assign(dragPayload, JSON.parse(v)), effectAllowed: '' }
    const ev = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown }
    ev.dataTransfer = dt
    act(() => { handle.dispatchEvent(ev) })
    act(() => { window.dispatchEvent(new CustomEvent('genba:import-item-adding', { detail: { importId: dragPayload._importId } })) })
    click([...cards()[0].querySelectorAll('button')].find(b => b.title === '見積に追加'))
    await flush()
    expect(imports).toHaveLength(0)
    // 失敗の通知を受けたら、もう一度追加できる・理由を表示する
    act(() => { window.dispatchEvent(new CustomEvent('genba:import-item-failed', { detail: { importId: dragPayload._importId, error: '工種が見つかりません' } })) })
    expect(container.textContent).toContain('工種が見つかりません')
    click([...cards()[0].querySelectorAll('button')].find(b => b.title === '見積に追加'))
    await flush()
    expect(imports).toHaveLength(1)
  })

  it('見積に追加した画像をもう一度選ぶと、重複のおそれを知らせる', async () => {
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加'))
    click(button('確認したので追加する'))
    await flush()
    await act(async () => { await new Promise(r => setTimeout(r, 320)) })
    click(button('画像を変更'))
    choose([img('p1.jpg')])
    expect(container.textContent).toContain('見積に追加済みの画像です')
  })
})
