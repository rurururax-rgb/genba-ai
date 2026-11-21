// @vitest-environment jsdom
/**
 * 「資材マスターから追加」ダイアログ（MaterialMasterPicker）。画面を実際に描画し、fetch は模擬する（DB には接続しない）。
 * すべて架空の資材。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MaterialMasterPicker } from '@/components/projects/MaterialMasterPicker'
import { UNKNOWN_RESULT_MESSAGE } from '@/lib/estimate/past-copy-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '00000000-0000-4000-8000-000000000011'
const G1 = '00000000-0000-4000-8000-000000000021'
const G2 = '00000000-0000-4000-8000-000000000022'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Preview = { selling_price_mode: 'auto' | 'manual'; cost_price: number | null; selling_price: number | null; markup_rate: number; fingerprint: string }
const hit = (n: number, name: string, fields: Record<string, unknown>, preview: Partial<Preview>) => ({
  id: ID(n), name, spec: null, unit: '台', cost_price: null, selling_price: null, category: null, ...fields,
  preview: { selling_price_mode: 'auto', cost_price: null, selling_price: null, markup_rate: 1.3, fingerprint: `m1-${String(n).padStart(14, '0')}`, ...preview },
})

const BATH = hit(1, 'ユニットバス 1616', { spec: 'HTV1616', cost_price: 600000, selling_price: 900000, category: '設備' },
  { selling_price_mode: 'manual', cost_price: 600000, selling_price: 900000 })
const CLOTH = hit(2, 'クロス張替', { unit: '㎡', cost_price: 1000 }, { cost_price: 1000, selling_price: 1300 })
const MISC = hit(3, '諸経費', { unit: '式' }, {})

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

let container: HTMLDivElement
let root: Root
let searches: string[]
let posts: Array<Record<string, unknown>>
let searchReply: (q: string) => Promise<Response>
let addReply: () => Promise<Response>
let onReload: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  searches = []
  posts = []
  searchReply = async q => json({ items: q.includes('クロス') ? [CLOTH] : [BATH, CLOTH, MISC], has_more: false, markup_rate: 1.3 })
  addReply = async () => json({ item: { id: ID(99) } }, 201)
  onReload = vi.fn(async () => true)
  onClose = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/estimate-items/search-master')) {
      const sp = new URL(url, 'http://x').searchParams
      expect(sp.get('project_id')).toBe(P)
      searches.push(sp.get('q')!)
      return searchReply(sp.get('q')!)
    }
    if (url === '/api/estimate-items/add-from-master') {
      posts.push(JSON.parse(init!.body as string))
      return addReply()
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(props: Partial<React.ComponentProps<typeof MaterialMasterPicker>> = {}) {
  await act(async () => {
    root.render(
      <MaterialMasterPicker
        projectId={P}
        groups={[{ id: G1, label: '解体' }, { id: G2, label: '住宅設備' }]}
        defaultGroupId={G2}
        onReload={onReload as unknown as () => Promise<boolean>}
        onClose={onClose as unknown as () => void}
        {...props}
      />,
    )
  })
  await flush()
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const text = () => dialog().textContent ?? ''
const searchInput = () => document.querySelector('input[type="search"]') as HTMLInputElement
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })

async function setValue(el: HTMLInputElement, v: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function typeAndSearch(q: string) {
  await setValue(searchInput(), q)
  await act(async () => { searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
}
function buttonByText(label: string | RegExp): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find(el => (typeof label === 'string' ? el.textContent?.includes(label) : label.test(el.textContent ?? '')))
  if (!b) throw new Error(`button not found: ${label}`)
  return b as HTMLButtonElement
}
const choose = (name: string) => click(document.querySelector(`input[type="radio"][aria-label="${name} を選ぶ"]`)!)
const addButton = () => buttonByText(/に追加$|資材を選んでください|追加しています|読み込み直しています|工種を選び直してください|変更内容を確認してください/)
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const previewSelling = () => document.querySelector('[data-testid="master-preview-selling"]')?.textContent
const previewAmount = () => document.querySelector('[data-testid="master-preview-amount"]')?.textContent
const modeRadio = (label: RegExp) => [...document.querySelectorAll('input[name="master-mode"]')]
  .find(r => label.test(r.parentElement?.textContent ?? '')) as HTMLInputElement

describe('検索と一覧', () => {
  it('開くとよく使う順の一覧を出し、品名・仕様・単位・原価・売価を表示する', async () => {
    await render()
    expect(searches).toEqual([''])
    const t = text()
    for (const s of ['ユニットバス 1616', '仕様 HTV1616', '分類 設備', '¥600,000', '¥900,000', 'クロス張替', '㎡', '諸経費']) expect(t).toContain(s)
    expect(addButton().disabled).toBe(true)
    expect(addButton().textContent).toBe('資材を選んでください')
  })

  it('品名で検索する（Enter）。日本語変換の確定 Enter では検索しない。一致なし・エラーを表示する', async () => {
    await render()
    await typeAndSearch('クロス')
    expect(searches).toEqual(['', 'クロス'])
    expect(text()).not.toContain('ユニットバス')
    await setValue(searchInput(), 'ゆにっと')
    await act(async () => { searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })) })
    expect(searches).toEqual(['', 'クロス'])
    searchReply = async () => json({ items: [], has_more: false })
    await typeAndSearch('該当なし')
    expect(text()).toContain('「該当なし」に一致する資材はありません')
    searchReply = async () => json({ error: 'Unauthorized' }, 401)
    await typeAndSearch('クロス')
    expect(text()).toContain('ログインの有効期限が切れました')
  })
})

describe('数量・原価・売価の確認', () => {
  it('マスターに売価がある資材は「売価を固定」で始まり、金額 = 数量 × 売価', async () => {
    await render()
    await choose('ユニットバス 1616')
    expect(modeRadio(/売価を固定/).checked).toBe(true)
    expect(field('master-cost').value).toBe('600000')
    expect(field('master-selling').value).toBe('900000')
    expect(previewSelling()).toBe('¥900,000')
    await setValue(field('master-qty'), '２')
    expect(previewAmount()).toBe('¥1,800,000')
    expect(addButton().textContent).toBe('「住宅設備」に追加')
  })

  it('掛け率で計算に切り替えると、原価 × 案件の掛け率（1.3）。原価を変えると売価・金額も変わる（全角・桁区切り可）', async () => {
    await render()
    await choose('ユニットバス 1616')
    await click(modeRadio(/掛け率/))
    expect(previewSelling()).toBe('¥780,000')
    await setValue(field('master-cost'), '７００，０００')
    expect(previewSelling()).toBe('¥910,000')
    expect(previewAmount()).toBe('¥910,000')
  })

  it('原価のみの資材は掛け率で計算して始まる。原価も売価もない資材は「売価なし」と知らせる', async () => {
    await render()
    await choose('クロス張替')
    expect(modeRadio(/掛け率/).checked).toBe(true)
    expect(previewSelling()).toBe('¥1,300')
    await choose('諸経費')
    expect(previewSelling()).toBe('—')
    expect(text()).toContain('原価がないため売価を計算できません')
    expect(addButton().disabled).toBe(false)
  })

  it('数量 0・数でない入力・負の原価・空の固定売価では追加できない', async () => {
    await render()
    await choose('ユニットバス 1616')
    for (const [id, v, msg] of [
      ['master-qty', '0', '数量は 0 より大きい数'],
      ['master-qty', 'abc', '数量は 0 より大きい数'],
      ['master-cost', '-1', '原価は 0 以上'],
      ['master-selling', '', '売価を 0 以上'],
    ] as const) {
      await choose('ユニットバス 1616') // 入力を初期値に戻す
      await setValue(field(id), v)
      expect(text()).toContain(msg)
      expect(addButton().disabled).toBe(true)
    }
  })
})

describe('追加', () => {
  it('manual: 選んだ内容を送り、成功したら読み込み直して閉じる', async () => {
    await render()
    await choose('ユニットバス 1616')
    await setValue(field('master-qty'), '2')
    await click(addButton())
    await flush()
    expect(posts).toEqual([{
      project_id: P, group_id: G2, master_item_id: BATH.id, fingerprint: BATH.preview.fingerprint,
      quantity: 2, cost_price: 600000, selling_price_mode: 'manual', selling_price: 900000,
    }])
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('auto: 売価は送らない（サーバーが計算する）。原価空欄は null。追加先「その他」は group_id null', async () => {
    await render()
    await choose('諸経費')
    await act(async () => {
      const sel = document.getElementById('material-master-target') as HTMLSelectElement
      sel.value = ''
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(addButton())
    await flush()
    expect(posts).toEqual([{
      project_id: P, group_id: null, master_item_id: MISC.id, fingerprint: MISC.preview.fingerprint,
      quantity: 1, cost_price: null, selling_price_mode: 'auto',
    }])
  })

  it('連打しても 1 回だけ送る。送信中は入力・検索・閉じるを止める', async () => {
    let release!: () => void
    addReply = () => new Promise(r => { release = () => r(json({ item: { id: ID(99) } }, 201)) })
    await render()
    await choose('クロス張替')
    const b = addButton()
    await act(async () => { b.click(); b.click(); b.click() })
    expect(posts).toHaveLength(1)
    expect(addButton().textContent).toBe('追加しています…')
    expect(addButton().disabled).toBe(true)
    expect(searchInput().disabled).toBe(true)
    expect(field('master-qty').disabled).toBe(true)
    expect((document.querySelector('button[aria-label="閉じる"]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release() })
    await flush()
    expect(posts).toHaveLength(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('通信エラー・5xx は「追加できたか不明」。自動で再送せず、読み込み直しを案内する', async () => {
    for (const reply of [() => Promise.reject(new TypeError('network')), async () => json({ error: 'x' }, 500)]) {
      addReply = reply as () => Promise<Response>
      onReload.mockClear(); onClose.mockClear(); posts = []
      await render()
      await choose('クロス張替')
      await click(addButton())
      await flush()
      expect(text()).toContain(UNKNOWN_RESULT_MESSAGE)
      expect(posts).toHaveLength(1)
      expect(onReload).not.toHaveBeenCalled()
      expect(() => addButton()).toThrow() // 追加ボタンは出さない
      await click(buttonByText('見積明細を読み込み直して確認する'))
      await flush()
      expect(onReload).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(posts).toHaveLength(1)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('追加は成功したが読み込み直しに失敗したら閉じず、もう一度は追加させない（再試行できる）', async () => {
    onReload = vi.fn(async () => false)
    await render()
    await choose('クロス張替')
    await click(addButton())
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(text()).toContain('追加済みです')
    expect(() => addButton()).toThrow()
    onReload.mockImplementation(async () => true)
    await click(buttonByText('見積を読み込み直す'))
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(posts).toHaveLength(1)
  })

  it('409: いまの内容を「前 → 後」で見せ、原価・売価を初期値に戻す。確認するまで追加しない。確認後は新しい fingerprint で送る', async () => {
    const changed = hit(1, 'ユニットバス 1616', { spec: 'HTV1616', cost_price: 620000, selling_price: 950000, category: '設備' },
      { selling_price_mode: 'manual', cost_price: 620000, selling_price: 950000, fingerprint: 'm1-00000000000abc' })
    addReply = async () => json({ error: '資材マスターの内容か、案件の掛け率が変わりました。', item: changed }, 409)
    await render()
    await choose('ユニットバス 1616')
    await setValue(field('master-qty'), '3')
    await click(addButton())
    await flush()
    expect(text()).toContain('まだ追加していません')
    const card = document.querySelector('[data-testid="master-review-card"]')!
    expect(card.textContent).toContain('¥600,000→¥620,000')
    expect(field('master-cost').value).toBe('620000')
    expect(field('master-selling').value).toBe('950000')
    expect(field('master-qty').value).toBe('3') // 数量は残す
    expect(addButton().disabled).toBe(true)
    expect(addButton().textContent).toBe('変更内容を確認してください')

    addReply = async () => json({ item: { id: ID(99) } }, 201)
    await click(buttonByText('この内容で確認しました'))
    await click(addButton())
    await flush()
    expect(posts).toHaveLength(2)
    expect(posts[1]).toMatchObject({ fingerprint: 'm1-00000000000abc', cost_price: 620000, selling_price: 950000, quantity: 3 })
  })

  it('404（資材が削除された）: 一覧と選択から外し、追加していないと知らせる', async () => {
    addReply = async () => json({ error: 'この資材は資材マスターから削除されたか、見つかりません。検索し直してください。', reason: 'master_not_found' }, 404)
    await render()
    await choose('クロス張替')
    await click(addButton())
    await flush()
    expect(text()).toContain('削除されたか、見つかりません')
    expect(text()).toContain('まだ追加していません')
    expect(document.querySelector('input[aria-label="クロス張替 を選ぶ"]')).toBeNull()
    expect(addButton().textContent).toBe('資材を選んでください')
  })

  it('400 などは「まだ追加していません」と出し、直してから送り直せる', async () => {
    addReply = async () => json({ error: '数量は 0 より大きい数で入力してください' }, 400)
    await render()
    await choose('クロス張替')
    await click(addButton())
    await flush()
    expect(text()).toContain('数量は 0 より大きい数で入力してください（まだ追加していません）')
    expect(addButton().disabled).toBe(false)
  })

  it('選んでいた工種が消えたら「その他」へ変えず、選び直すまで追加させない', async () => {
    await render()
    await choose('クロス張替')
    await act(async () => {
      root.render(
        <MaterialMasterPicker projectId={P} groups={[{ id: G1, label: '解体' }]} defaultGroupId={G2}
          onReload={onReload as unknown as () => Promise<boolean>} onClose={onClose as unknown as () => void} />,
      )
    })
    expect(text()).toContain('追加先の工種「住宅設備」が見つかりません')
    expect(addButton().disabled).toBe(true)
    await act(async () => {
      const sel = document.getElementById('material-master-target') as HTMLSelectElement
      sel.value = G1
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(addButton().textContent).toBe('「解体」に追加')
  })
})
