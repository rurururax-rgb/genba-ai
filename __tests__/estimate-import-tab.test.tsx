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
import { IMPORT_DRAG_TYPE, resolveImportDrop } from '@/lib/estimate/import-drag'

// 画像の縮小処理は本物を使い、同時に何件走ったかを数える（gate を置くと、その間は縮小が終わらない）
const prep = vi.hoisted(() => ({ active: 0, max: 0, started: [] as string[], gate: null as null | Promise<void>, failOn: '' }))
vi.mock('@/lib/estimate/ocr-image', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/estimate/ocr-image')>()
  return {
    ...real,
    prepareEstimateImage: async (f: File) => {
      prep.started.push(f.name); prep.active++; prep.max = Math.max(prep.max, prep.active)
      try {
        if (prep.gate) await prep.gate
        if (prep.failOn === f.name) throw new Error('decode crashed')
        return await real.prepareEstimateImage(f)
      } finally { prep.active-- }
    },
  }
})

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
  Object.assign(prep, { active: 0, max: 0, started: [], gate: null, failOn: '' })
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
    // ドラッグ開始時のトークンから取り込み候補の id を得る
    const dragPayload = { _importId: startDrag(cards()[0]).item!._importId }
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

// ── 警告を読み飛ばして金額を登録しない（PR #52 追加監査） ──────────────────
const SEPARATE = { level: 'warn', text: '「電気配線工事」は原本で「別途」となっており、明細に入れていません。' }
const NO_CHECK = { level: 'warn', text: 'この見積書には金額・定価の列がないため、単価の読み違いを照合で見つけられません。' }
// 1 画面の「見積に追加」・別ウィンドウの「見積に追加（未分類）」のどちらも
const addBtnOf = (card: HTMLElement) => [...card.querySelectorAll('button')].find(b => b.title.startsWith('見積に追加'))!
const btnIn = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find(b => b.textContent?.includes(text))
/**
 * ドラッグを始め、ドラッグのデータ（一時トークン）を受け取る。resolve: true なら見積エディタのドロップと同じ手順で
 * トークンを確かめて登録する値を得る（トークンは使い切る）
 */
function startDrag(card: HTMLElement, { resolve = true } = {}) {
  const data: Record<string, string> = {}
  const dt = { setData: (t: string, v: string) => { data[t] = v }, effectAllowed: '' }
  const ev = new Event('dragstart', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
  ev.dataTransfer = dt
  act(() => { (card.querySelector('[draggable]') as HTMLElement).dispatchEvent(ev) })
  const token = data[IMPORT_DRAG_TYPE] as string | undefined
  const r = token && resolve ? resolveImportDrop({ getData: t => data[t] ?? '' }, 'p1') : null
  return { token, data, cancelled: ev.defaultPrevented, item: r?.ok ? r.item : undefined, result: r }
}

describe('画像全体の警告（別途・値引き・照合不能）は一括追加の確認に入る', () => {
  it('明細がすべて照合済みでも、画像全体の警告があれば一括追加の前に確認し、警告の内容を確認欄に出す', async () => {
    extractReply = name => json({ files: [fileResult(name, [GOOD], [SEPARATE])], items: [GOOD], failures: [] })
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加'))
    await flush()
    expect(imports).toHaveLength(0)
    const box = container.querySelector('[data-testid=bulk-confirm]') as HTMLElement
    expect(box.textContent).toContain('p1.jpg')
    expect(box.textContent).toContain('電気配線工事')
    click(button('確認したので追加する'))
    await flush()
    expect(imports).toHaveLength(1)
  })

  it('警告のない画像だけなら、一括追加はこれまでどおり 1 回で送る', async () => {
    extractReply = name => json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加'))
    await flush()
    expect(imports).toHaveLength(1)
  })

  it('読み取れなかった画像があるときも、一括追加の前に確認する（その画像の原価が入っていない）', async () => {
    extractReply = name => name === 'p2.jpg'
      ? json({ error: '読み取りが途中で終わりました', code: 'ai_truncated' }, 502)
      : json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
    await readImages([img('p1.jpg'), img('p2.jpg')])
    click(button('残り全件を追加'))
    await flush()
    expect(imports).toHaveLength(0)
    expect((container.querySelector('[data-testid=bulk-confirm]') as HTMLElement).textContent).toContain('p2.jpg')
  })
})

describe('要確認の行は、個別追加・ドラッグでも確認なしに通らない', () => {
  it('個別の「追加」: 要確認の行は確認欄を出し、確認するまで送らない', async () => {
    await readImages([img('p1.jpg')])
    const bad = cards()[1]
    click(addBtnOf(bad)); click(addBtnOf(bad))
    await flush()
    expect(imports).toHaveLength(0)
    const box = cards()[1].querySelector('[data-testid=row-confirm]') as HTMLElement
    expect(box.textContent).toContain('金額欄を単価として読んだ可能性')
    click(btnIn(box, '確認したので追加する'))
    await flush()
    expect(imports).toHaveLength(1)
    expect((imports[0].items as Array<Record<string, unknown>>)[0]).toMatchObject({ name: '配管部材', quantity: 3, cost_price: 15000 })
  })

  it('ドラッグ: 要確認の行はドラッグを始めず（payload も渡さない）、確認欄を出す。確認後はドラッグできる', async () => {
    await readImages([img('p1.jpg')])
    const first = startDrag(cards()[1])
    expect(first.cancelled).toBe(true)
    expect(first.token).toBeUndefined()
    const box = cards()[1].querySelector('[data-testid=row-confirm]') as HTMLElement
    click(btnIn(box, '確認済みにする'))
    expect(imports).toHaveLength(0)
    const second = startDrag(cards()[1])
    expect(second.cancelled).toBe(false)
    // ドラッグのデータはトークンだけ（品名・金額を出さない）。登録する値はトークンから得る
    expect(Object.keys(second.data)).toEqual([IMPORT_DRAG_TYPE])
    expect(second.token).not.toContain('配管部材')
    expect(second.item).toMatchObject({ name: '配管部材', cost_price: 15000 })
  })

  it('個別の「追加」: 画像全体に警告がある画像の行は、照合済みの行でも初回は確認する。確認後は同じ画像の行は 1 回で追加できる', async () => {
    const GOOD2 = { ...GOOD, name: '水栓 FX-1' }
    extractReply = name => json({ files: [fileResult(name, [GOOD, GOOD2], [NO_CHECK])], items: [GOOD, GOOD2], failures: [] })
    await readImages([img('p1.jpg')])
    click(addBtnOf(cards()[0]))
    await flush()
    expect(imports).toHaveLength(0)
    const box = cards()[0].querySelector('[data-testid=row-confirm]') as HTMLElement
    expect(box.textContent).toContain('照合で見つけられません')
    click(btnIn(box, '確認したので追加する'))
    await flush()
    expect(imports).toHaveLength(1)
    click(addBtnOf(cards().find(c => c.textContent?.includes('水栓'))!))
    await flush()
    expect(imports).toHaveLength(2)
  })

  it('確認後に数量・単価を直したら、要確認が残る行はもう一度確認する', async () => {
    await readImages([img('p1.jpg')])
    const bad = cards()[1]
    click(addBtnOf(bad))
    click(btnIn(cards()[1].querySelector('[data-testid=row-confirm]') as HTMLElement, '確認済みにする'))
    click([...cards()[1].querySelectorAll('button')].find(b => b.textContent === '修正'))
    const qty = [...cards()[1].querySelectorAll('label')].find(l => l.textContent?.startsWith('数量'))!.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(qty, '4')
      qty.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cards()[1].dataset.needsReview).toBe('true')
    click(addBtnOf(cards()[1]))
    await flush()
    expect(imports).toHaveLength(0)
  })
})

describe('複数画像: 確認する警告は、その行の取り込み元の画像のもの', () => {
  it('警告のある画像 A の行は確認を求め、警告のない画像 B の行は 1 回で追加できる。確認欄には A の警告だけを出す', async () => {
    const B_ITEM = { ...GOOD, name: 'B社 便器 TX-1', vendor_name: '架空陶器' }
    extractReply = name => name === 'a.jpg'
      ? json({ files: [fileResult(name, [GOOD], [SEPARATE])], items: [GOOD], failures: [] })
      : json({ files: [fileResult(name, [B_ITEM], [])], items: [B_ITEM], failures: [] })
    await readImages([img('a.jpg'), img('b.jpg')])
    const cardB = cards().find(c => c.textContent?.includes('B社'))!
    click(addBtnOf(cardB))
    await flush()
    expect(imports).toHaveLength(1)
    expect((imports[0].items as Array<Record<string, unknown>>)[0].name).toBe('B社 便器 TX-1')

    const cardA = cards().find(c => c.textContent?.includes('洗面化粧台'))!
    click(addBtnOf(cardA))
    await flush()
    expect(imports).toHaveLength(1)
    const box = cardA.querySelector('[data-testid=row-confirm]') as HTMLElement
    expect(box.textContent).toContain('a.jpg')
    expect(box.textContent).toContain('電気配線工事')
    expect(box.textContent).not.toContain('b.jpg')
  })

  it('同じファイル名の別の画像（スマホの image.jpg など）でも、警告は取り込み元の画像に対応する', async () => {
    const first = new File([new Uint8Array(10)], 'image.jpg', { type: 'image/jpeg', lastModified: 1 })
    const second = new File([new Uint8Array(20)], 'image.jpg', { type: 'image/jpeg', lastModified: 2 })
    const B_ITEM = { ...GOOD, name: 'B社 便器 TX-1' }
    let n = 0
    extractReply = name => (n++ === 0
      ? json({ files: [fileResult(name, [GOOD], [SEPARATE])], items: [GOOD], failures: [] })
      : json({ files: [fileResult(name, [B_ITEM], [])], items: [B_ITEM], failures: [] }))
    await readImages([first, second])
    click(addBtnOf(cards().find(c => c.textContent?.includes('B社'))!))
    await flush()
    expect(imports).toHaveLength(1)
    click(addBtnOf(cards().find(c => c.textContent?.includes('洗面化粧台'))!))
    await flush()
    expect(imports).toHaveLength(1)
  })

  it('一括追加の確認欄は、警告のある画像の名前と警告を画像ごとに出す', async () => {
    extractReply = name => name === 'a.jpg'
      ? json({ files: [fileResult(name, [GOOD], [SEPARATE])], items: [GOOD], failures: [] })
      : json({ files: [fileResult(name, [{ ...GOOD, name: 'B' }], [NO_CHECK])], items: [], failures: [] })
    await readImages([img('a.jpg'), img('b.jpg')])
    click(button('残り全件を追加'))
    const box = container.querySelector('[data-testid=bulk-confirm]') as HTMLElement
    const groups = [...box.querySelectorAll('[data-testid=bulk-confirm-file]')].map(g => g.textContent ?? '')
    expect(groups).toHaveLength(2)
    expect(groups.find(g => g.includes('a.jpg'))).toContain('電気配線工事')
    expect(groups.find(g => g.includes('a.jpg'))).not.toContain('照合で見つけられません')
    expect(groups.find(g => g.includes('b.jpg'))).toContain('照合で見つけられません')
  })
})

describe('原本と読み取り候補を見比べる', () => {
  it('選択した画像は元画像のblob URLで表示され、追加後も表示されたまま', async () => {
    extractReply = name => json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
    await readImages([img('original.jpg')])
    const viewer = container.querySelector('[data-testid=estimate-source-viewer]') as HTMLElement
    expect(viewer).not.toBeNull()
    const originalSrc = (viewer.querySelector('img') as HTMLImageElement).getAttribute('src')
    expect(originalSrc).toBe('blob:preview')
    click(addBtnOf(cards()[0]))
    await flush()
    expect(imports).toHaveLength(1)
    expect(container.querySelector('[data-testid=estimate-source-viewer] img')?.getAttribute('src')).toBe(originalSrc)
  })

  it('候補の「原本を見る」で対応するページを表示し、候補・確認状態は消えない', async () => {
    const b = { ...GOOD, name: '追加の見積明細' }
    extractReply = name => json({ files: [fileResult(name, [name === 'a.jpg' ? GOOD : b])], items: [], failures: [] })
    await readImages([img('a.jpg'), img('b.jpg')])
    expect(cards()).toHaveLength(2)
    click(btnIn(cards()[1], '原本を見る'))
    expect(container.querySelector('[data-testid=estimate-source-viewer]')?.textContent).toContain('b.jpg（2/2）')
    expect(document.querySelector('[role=dialog] img')?.getAttribute('alt')).toContain('b.jpg')
    expect(cards()).toHaveLength(2)
    expect(imports).toHaveLength(0)
  })

  it('画像選び直しで前のblobを解放し、取り込み候補は残さない', async () => {
    await readImages([img('a.jpg')])
    click(button('画像を変更'))
    expect(container.querySelector('[data-testid=estimate-source-viewer]')).toBeNull()
    expect(cards()).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})

describe('別モニターの幅広い原本照合', () => {
  it('見積エディタに似た数量・単位・原価・原本金額の整列表示でも登録値を変えない', async () => {
    extractReply = name => json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
    await readImages([img('a.jpg')])
    act(() => root.render(<EstimateImportTab projectId="p1" wide />))
    const row = cards()[0]
    const fields = row.querySelector('[data-testid=ocr-wide-fields]') as HTMLElement
    expect(fields).not.toBeNull()
    expect(fields.textContent).toContain('数量')
    expect(fields.textContent).toContain('原価単価')
    expect(fields.textContent).toContain('¥60,000')
    expect(fields.textContent).toContain('原本の金額')
    expect(container.querySelector('[data-testid=estimate-wide-review-layout]')).not.toBeNull()
    click(addBtnOf(row))
    await flush()
    expect(imports).toHaveLength(1)
    expect((imports[0].items as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: '洗面化粧台 LX-750', quantity: 1, cost_price: 60000,
    })
  })

  it('狭い表示に戻しても同じ未追加候補・警告が維持される', async () => {
    await readImages([img('a.jpg')])
    expect(cards()).toHaveLength(2)
    act(() => root.render(<EstimateImportTab projectId="p1" wide />))
    expect(cards()).toHaveLength(2)
    expect(cards()[1].dataset.needsReview).toBe('true')
    act(() => root.render(<EstimateImportTab projectId="p1" />))
    expect(cards()).toHaveLength(2)
    expect(cards()[1].dataset.needsReview).toBe('true')
    expect(container.querySelector('[data-testid=ocr-wide-fields]')).toBeNull()
    expect(imports).toHaveLength(0)
  })

  it('幅広い表示中も要確認は登録をブロックし、確認済みにならない限り送らない', async () => {
    await readImages([img('a.jpg')])
    act(() => root.render(<EstimateImportTab projectId="p1" wide />))
    click(addBtnOf(cards()[1]))
    await flush()
    expect(imports).toHaveLength(0)
    expect(cards()[1].querySelector('[data-testid=row-confirm]')).not.toBeNull()
  })
})

// ── 画像の前処理は 1 枚ずつ・画面終了と画像変更の後片付け（PR #52 残る安全対策） ──────────
describe('画像の前処理は 1 枚ずつ、送信は最大 2 件', () => {
  let inflight = 0, maxInflight = 0
  let sendGate: null | Promise<void> = null
  let signals: AbortSignal[] = []
  beforeEach(() => {
    inflight = 0; maxInflight = 0; sendGate = null; signals = []
    const base = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/ai/extract-estimate') return base(url, init)
      signals.push(init!.signal!)
      inflight++; maxInflight = Math.max(maxInflight, inflight)
      try {
        if (sendGate) await sendGate
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        await new Promise(r => setTimeout(r, 8))
        return await base(url, init)
      } finally { inflight-- }
    }))
  })
  const ten = () => Array.from({ length: 10 }, (_, i) => img(`p${i + 1}.jpg`))
  const settle = async (ms = 400) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }

  it('10 枚を読み取っても、画像の縮小は同時に 1 件だけ。全画像を順番どおりに処理する', async () => {
    choose(ten()); click(button('AIで読み取る')); await settle()
    expect(prep.max).toBe(1)
    expect(prep.started).toEqual(ten().map(f => f.name))
    expect(extractCalls.map(c => c.name)).toHaveLength(10)
    // 結果の並びは画像の順番どおり（各画像 GOOD・BAD の 2 行）
    expect(cards()).toHaveLength(20)
  })

  it('API への送信は最大 2 件まで並列（1 枚 1 リクエスト）', async () => {
    choose(ten()); click(button('AIで読み取る')); await settle()
    expect(maxInflight).toBe(2)
    expect(extractCalls.every(c => c.count === 1)).toBe(true)
  })

  it('途中でキャンセルすると、待っている画像の縮小・送信を始めない', async () => {
    let release!: () => void
    prep.gate = new Promise(r => { release = r })
    choose(ten()); click(button('AIで読み取る')); await settle(30)
    expect(prep.started).toEqual(['p1.jpg'])
    click(button('キャンセル'))
    release(); await settle(100)
    expect(prep.started).toEqual(['p1.jpg'])
    expect(extractCalls).toHaveLength(0)
    expect(cards()).toHaveLength(0)
  })

  it('1 枚の縮小が想定外に失敗しても、ほかの画像は処理する', async () => {
    prep.failOn = 'p2.jpg'
    choose([img('p1.jpg'), img('p2.jpg'), img('p3.jpg')]); click(button('AIで読み取る')); await settle(200)
    expect(extractCalls.map(c => c.name)).toEqual(['p1.jpg', 'p3.jpg'])
    expect(cards()).toHaveLength(4)
    expect(container.textContent).toContain('「p2.jpg」を読み込めませんでした')
  })

  it('画面を閉じると読み取りの通信を中断し、待っている画像の縮小を始めない', async () => {
    let release!: () => void
    sendGate = new Promise(r => { release = r })
    choose(ten()); click(button('AIで読み取る')); await settle(60)
    const startedBefore = prep.started.length
    expect(signals.length).toBeGreaterThan(0)
    act(() => root.unmount())
    expect(signals.every(sg => sg.aborted)).toBe(true)
    release(); await settle(100)
    expect(prep.started.length).toBe(startedBefore)
    root = createRoot(container) // afterEach の unmount 用
  })
})

describe('画像変更・画面終了の後に古い結果が戻らない', () => {
  const settle = async (ms = 400) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
  const OK = (name: string) => json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })

  it('追加のアニメーション中に「画像を変更」しても、追加完了の画面が戻らない', async () => {
    extractReply = OK
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加')); await flush()
    click(button('画像を変更'))
    expect(container.querySelector('input[type=file]')).not.toBeNull()
    await settle()
    expect(container.querySelector('input[type=file]')).not.toBeNull()
    expect(container.textContent).not.toContain('すべてを見積に追加しました')
  })

  it('追加の通信中に「画像を変更」→ 後から届いた追加完了で、結果画面・件数が戻らない', async () => {
    extractReply = OK
    let release!: () => void
    importReply = () => new Promise(r => { release = () => r(json({ created: 1 })) })
    await readImages([img('p1.jpg')])
    click(button('残り全件を追加')); await flush()
    click(button('画像を変更'))
    release(); await settle()
    expect(imports).toHaveLength(1) // 登録そのものは中断しない
    expect(container.querySelector('input[type=file]')).not.toBeNull()
    expect(container.textContent).not.toContain('すべてを見積に追加しました')
  })

  it('画像変更の後に届いたドラッグの追加完了通知でも、件数・結果画面が戻らない', async () => {
    extractReply = OK
    await readImages([img('p1.jpg')])
    const id = { _importId: startDrag(cards()[0]).item?._importId }
    click(button('画像を変更'))
    act(() => { window.dispatchEvent(new CustomEvent('genba:import-item-moved', { detail: { importId: id._importId } })) })
    await settle()
    expect(container.querySelector('input[type=file]')).not.toBeNull()
    expect(container.textContent).not.toContain('すべてを見積に追加しました')
  })

  it('読み取り中に画面を閉じても、エラーや警告を出さず、閉じた後に状態を更新しない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    extractReply = name => { void gate; return OK(name) }
    const base = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => { await gate; if (i?.signal?.aborted) throw new DOMException('a', 'AbortError'); return base(u, i) }))
    choose([img('p1.jpg')]); click(button('AIで読み取る')); await flush()
    act(() => root.unmount())
    release(); await settle(100)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    root = createRoot(container)
  })
})

describe('Object URL の解放', () => {
  let created: string[] = [], revoked: string[] = []
  beforeEach(() => {
    created = []; revoked = []
    let n = 0
    URL.createObjectURL = vi.fn(() => { const u = `blob:preview-${++n}`; created.push(u); return u })
    URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u) })
  })
  const live = () => created.filter(u => !revoked.includes(u))

  it('画像の削除・追加選択・画像変更で古い URL を解放し、画面を閉じると残りをすべて解放する', async () => {
    choose([img('a.jpg'), img('b.jpg')])
    expect(live()).toHaveLength(2)
    choose([img('c.jpg')]) // 追加選択: 作り直した分だけが残る
    expect(live()).toHaveLength(3)
    click(container.querySelector('button[aria-label="削除"]') as HTMLButtonElement) // 1 枚削除
    expect(live()).toHaveLength(2)
    click(button('AIで読み取る')); await flush()
    click(button('画像を変更'))
    expect(live()).toHaveLength(0)
    choose([img('d.jpg'), img('e.jpg')])
    expect(live()).toHaveLength(2)
    act(() => root.unmount())
    expect(live()).toHaveLength(0)
    expect(new Set(revoked).size).toBe(revoked.length) // 二重に解放しない
    root = createRoot(container)
  })
})

describe('エラー・再試行で候補が重複しない', () => {
  const OK = (name: string) => json({ files: [fileResult(name, [GOOD])], items: [GOOD], failures: [] })
  const settle = async (ms = 300) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }

  it('1 枚失敗 → 画像を選び直して再読み取り → 候補は画像の数だけ（前回分と重ならない）', async () => {
    extractReply = name => (name === 'p2.jpg' ? json({ error: '読み取りに失敗しました', code: 'ai_failed' }, 500) : OK(name))
    await readImages([img('p1.jpg'), img('p2.jpg')])
    expect(cards()).toHaveLength(1)
    extractReply = OK
    click(button('画像を変更'))
    await readImages([img('p1.jpg'), img('p2.jpg')]); await settle()
    expect(cards()).toHaveLength(2)
  })

  it('読み取り途中でキャンセル → すぐ再読み取りしても、候補は 1 回分だけ', async () => {
    extractReply = OK
    let release!: () => void
    prep.gate = new Promise(r => { release = r })
    choose([img('p1.jpg'), img('p2.jpg'), img('p3.jpg')]); click(button('AIで読み取る')); await flush()
    click(button('キャンセル'))
    prep.gate = null
    click(button('AIで読み取る'))
    release(); await settle()
    expect(cards()).toHaveLength(3)
    expect(prep.max).toBe(1)
  })
})

// ── 別ウィンドウ（右画面）から見積エディタへのドラッグ ──────────────────────────
describe('右画面の表から見積エディタへドラッグ', () => {
  const OK = (name: string) => json({ files: [fileResult(name, [GOOD, BAD])], items: [GOOD, BAD], failures: [] })
  const wideRender = () => act(() => root.render(<EstimateImportTab projectId="p1" wide />))

  it('右画面は上に原本・下に横長の表（品名・数量・単位・原価単価・金額・確認状態）', async () => {
    extractReply = OK
    await readImages([img('a.jpg')])
    wideRender()
    const layout = container.querySelector('[data-testid=estimate-wide-review-layout]') as HTMLElement
    const header = container.querySelector('[data-testid=ocr-wide-header]') as HTMLElement
    expect(header.textContent).toMatch(/品名.*数量.*単位.*原価単価.*原本の金額.*確認状態/)
    // 原本が表より前（上）にある
    const viewer = layout.querySelector('[data-testid=estimate-source-viewer]')!
    expect(viewer.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const statuses = cards().map(c => c.querySelector('[data-testid=ocr-review-status]')?.textContent)
    expect(statuses).toEqual(['照合OK', '要確認'])
    // 1 画面に戻すと表の見出しは出ない（コンパクト表示）
    act(() => root.render(<EstimateImportTab projectId="p1" />))
    expect(container.querySelector('[data-testid=ocr-wide-header]')).toBeNull()
  })

  it('右画面でもドラッグできる（データはトークンだけ）。要確認の行は確認するまでドラッグを始めない', async () => {
    extractReply = OK
    await readImages([img('a.jpg')])
    wideRender()
    const [good, bad] = cards()
    expect((good.querySelector('[data-testid=ocr-drag-handle]') as HTMLElement).getAttribute('draggable')).toBe('true')
    const d1 = startDrag(good)
    expect(d1.cancelled).toBe(false)
    expect(Object.keys(d1.data)).toEqual([IMPORT_DRAG_TYPE])
    expect(d1.item).toMatchObject({ name: '洗面化粧台 LX-750', quantity: 1, cost_price: 60000 })
    const d2 = startDrag(bad)
    expect(d2.cancelled).toBe(true)
    expect(d2.token).toBeUndefined()
    expect(cards()[1].querySelector('[data-testid=row-confirm]')).not.toBeNull()
    expect(imports).toHaveLength(0)
  })

  it('ドラッグ中に同じ明細を「追加」ボタンで送っていたら、ドロップは受け付けない（二重登録しない）', async () => {
    extractReply = OK
    let release!: () => void
    importReply = () => new Promise(r => { release = () => r(json({ created: 1 })) })
    await readImages([img('a.jpg')])
    wideRender()
    const d = startDrag(cards()[0], { resolve: false })
    click(addBtnOf(cards()[0])); await flush()
    const r = resolveImportDrop({ getData: t => d.data[t] ?? '' }, 'p1')
    expect(r).toMatchObject({ ok: false, reason: 'この明細は追加中です' })
    release(); await flush()
    expect(imports).toHaveLength(1)
  })

  it('ドラッグ中に画像を変更したら、その明細のドロップは受け付けない', async () => {
    extractReply = OK
    await readImages([img('a.jpg')])
    const d = startDrag(cards()[0], { resolve: false })
    click(button('画像を変更'))
    const r = resolveImportDrop({ getData: t => d.data[t] ?? '' }, 'p1')
    expect(r.ok).toBe(false)
  })

  it('ドラッグを終えた（キャンセルした）トークンでは登録できない', async () => {
    extractReply = OK
    await readImages([img('a.jpg')])
    const d = startDrag(cards()[0], { resolve: false })
    act(() => { (cards()[0].querySelector('[draggable]') as HTMLElement).dispatchEvent(new Event('dragend', { bubbles: true })) })
    expect(resolveImportDrop({ getData: t => d.data[t] ?? '' }, 'p1').ok).toBe(false)
  })

  it('見積エディタが受け付けなかった理由は、取り込みパネルのその明細に出し、明細は残す', async () => {
    extractReply = OK
    await readImages([img('a.jpg')])
    wideRender()
    const d = startDrag(cards()[0], { resolve: false })
    // 別の案件の見積エディタへのドロップ（EstimateTab の handleImportDrop と同じ通知）
    const r = resolveImportDrop({ getData: t => d.data[t] ?? '' }, 'other-project')
    expect(r.ok).toBe(false)
    if (!r.ok) act(() => { window.dispatchEvent(new CustomEvent('genba:import-item-failed', { detail: { importId: r.importId, error: r.reason } })) })
    expect(container.textContent).toContain('別の案件の取り込み明細です')
    expect(cards()).toHaveLength(2)
    expect(imports).toHaveLength(0)
  })
})
