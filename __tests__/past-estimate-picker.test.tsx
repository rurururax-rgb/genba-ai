// @vitest-environment jsdom
/**
 * 「過去見積から追加」ダイアログ（PastEstimatePicker）。画面を実際に描画し、fetch は模擬する（DB には接続しない）。
 * すべて架空の明細。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PastEstimatePicker } from '@/components/projects/PastEstimatePicker'
import { UNKNOWN_RESULT_MESSAGE } from '@/lib/estimate/past-copy-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '00000000-0000-4000-8000-000000000011'
const P2 = '00000000-0000-4000-8000-000000000012'
const G1 = '00000000-0000-4000-8000-000000000021'
const G2 = '00000000-0000-4000-8000-000000000022'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Preview = {
  basis: string; selling_price_mode: 'auto' | 'manual'; past_selling_price: number | null; new_selling_price: number | null
  difference: number | null; changed: boolean; applied_markup_rate: number | null; fingerprint: string
}
const hit = (n: number, name: string, preview: Partial<Preview> = {}, extra: Record<string, unknown> = {}) => ({
  id: ID(n), name, quantity: 2, unit: '台', cost_price: 100000, selling_price: 145000, selling_price_mode: 'auto',
  vendor_name: '架空設備', category: null, created_at: '2026-02-28T16:00:00Z',
  project: { id: P2, name: '架空邸 改修工事', status: 'done', created_at: null },
  group: { id: G2, label: '住宅設備' },
  copy_preview: {
    basis: 'auto_recalculated', selling_price_mode: 'auto', past_selling_price: 145000, new_selling_price: 130000,
    difference: -15000, changed: true, applied_markup_rate: 1.3, fingerprint: `v1-${String(n).padStart(14, '0')}`, ...preview,
  },
  ...extra,
})

const AUTO = hit(1, 'システムキッチン交換')
const MANUAL0 = hit(2, '撤去（サービス）', { basis: 'manual_kept', selling_price_mode: 'manual', past_selling_price: 0, new_selling_price: 0, difference: 0, changed: false, applied_markup_rate: null }, { selling_price: 0, selling_price_mode: 'manual' })
const NOCOST = hit(3, 'キッチンパネル', { basis: 'no_cost', past_selling_price: 50000, new_selling_price: null, difference: null, changed: true, applied_markup_rate: null }, { cost_price: null, selling_price: 50000, group: null })
const FLOOR = hit(4, '床フローリング張替', { past_selling_price: 130000, difference: 0, changed: false })

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

let container: HTMLDivElement
let root: Root
let searches: string[]
let posts: Array<Record<string, unknown>>
let searchReply: (q: string) => Promise<Response>
let copyReply: () => Promise<Response>
let onReload: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  searches = []
  posts = []
  searchReply = async q => json({ items: q.includes('床') ? [FLOOR] : [AUTO, MANUAL0, NOCOST], has_more: false })
  copyReply = async () => json({ inserted_count: posts.at(-1)?.items ? (posts.at(-1)!.items as unknown[]).length : 0 }, 201)
  onReload = vi.fn(async () => undefined)
  onClose = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/estimate-items/search-past')) {
      const q = new URL(url, 'http://x').searchParams.get('q')!
      searches.push(q)
      return searchReply(q)
    }
    if (url === '/api/estimate-items/copy-from-past') {
      posts.push(JSON.parse(init!.body as string))
      return copyReply()
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

async function render(props: Partial<React.ComponentProps<typeof PastEstimatePicker>> = {}) {
  await act(async () => {
    root.render(
      <PastEstimatePicker
        projectId={P}
        groups={[{ id: G1, label: '解体' }, { id: G2, label: '住宅設備' }]}
        defaultGroupId={G1}
        onReload={onReload as unknown as () => Promise<unknown>}
        onClose={onClose as unknown as () => void}
        {...props}
      />,
    )
  })
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const text = () => dialog().textContent ?? ''
const input = () => document.querySelector('input[type="search"]') as HTMLInputElement
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function typeAndSearch(q: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input(), q)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

function buttonByText(label: string | RegExp): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find(el => (typeof label === 'string' ? el.textContent?.includes(label) : label.test(el.textContent ?? '')))
  if (!b) throw new Error(`button not found: ${label}`)
  return b as HTMLButtonElement
}
const checkbox = (name: string) => document.querySelector(`input[type="checkbox"][aria-label^="${name}"]`) as HTMLInputElement
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })
const copyButton = () => buttonByText(/件を「|明細を選んでください|追加しています|読み込み直しています/)
const selectedNames = () => [...document.querySelectorAll('section[aria-label="選択中の明細"] li .truncate')].map(e => e.textContent)

describe('検索', () => {
  it('品名で検索し、案件名・日付・工種・数量・原価・過去の売価・追加後の売価を表示する', async () => {
    await render()
    await typeAndSearch('キッチン')
    expect(searches).toEqual(['キッチン'])
    const t = text()
    for (const s of ['システムキッチン交換', '架空邸 改修工事', '2026/03/01', '住宅設備', '2 台', '¥100,000', '¥145,000', '¥130,000']) expect(t).toContain(s)
    // 売価の見せ方: 差額・0円固定・売価なし
    expect(t).toContain('過去より −¥15,000')
    expect(t).toContain('0円で固定')
    expect(t).toContain('売価なし')
    expect(t).toContain('原価がないため売価を計算できません')
    // 工種なしは「その他」
    expect(t).toContain('架空邸 改修工事・2026/03/01・その他')
  })

  it('入力が止まると自動で検索し、Enter 直後に同じ語で二重に検索しない', async () => {
    await render()
    await typeAndSearch('キッチン')
    await act(async () => { await new Promise(r => setTimeout(r, 450)) })
    expect(searches).toEqual(['キッチン'])
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input(), '床')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 450)) })
    expect(searches).toEqual(['キッチン', '床'])
    expect(text()).toContain('床フローリング張替')
  })

  it('日本語変換の確定 Enter では検索しない', async () => {
    await render()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input(), 'きっちん')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    })
    expect(searches).toEqual([])
  })

  it('古い検索の応答が後から届いても、新しい検索の結果を上書きしない', async () => {
    let releaseOld!: () => void
    searchReply = async q => {
      if (q === 'キッチン') {
        await new Promise<void>(r => { releaseOld = r })
        return json({ items: [AUTO], has_more: false })
      }
      return json({ items: [FLOOR], has_more: false })
    }
    await render()
    await typeAndSearch('キッチン')
    await typeAndSearch('床')
    expect(text()).toContain('床フローリング張替')
    await act(async () => { releaseOld() })
    await flush()
    expect(text()).toContain('床フローリング張替')
    expect(text()).not.toContain('システムキッチン交換')
  })

  it('一致なし・検索エラーを表示する', async () => {
    searchReply = async () => json({ items: [], has_more: false })
    await render()
    await typeAndSearch('該当なし')
    expect(text()).toContain('「該当なし」に一致する過去の明細はありません')
    searchReply = async () => json({ error: 'Unauthorized' }, 401)
    await typeAndSearch('キッチン')
    expect(text()).toContain('ログインの有効期限が切れました')
  })
})

describe('選択', () => {
  it('複数選択は選んだ順を保ち、チェック・✕で外せる。検索し直しても選択は残る', async () => {
    await render()
    await typeAndSearch('キッチン')
    expect(copyButton().disabled).toBe(true)
    await click(checkbox('キッチンパネル'))
    await click(checkbox('システムキッチン交換'))
    await click(checkbox('撤去（サービス）'))
    expect(selectedNames()).toEqual(['キッチンパネル', 'システムキッチン交換', '撤去（サービス）'])

    await click(checkbox('システムキッチン交換'))                        // チェックを外す
    expect(selectedNames()).toEqual(['キッチンパネル', '撤去（サービス）'])
    await click(document.querySelector('button[aria-label="キッチンパネル を選択から外す"]')!)  // ✕ で外す
    expect(selectedNames()).toEqual(['撤去（サービス）'])

    await typeAndSearch('床')
    await click(checkbox('床フローリング張替'))
    expect(selectedNames()).toEqual(['撤去（サービス）', '床フローリング張替'])
    expect(copyButton().textContent).toBe('選んだ 2 件を「解体」に追加')
  })

  it('合計（参考）は売価なしを除き、売価なしの件数を知らせる', async () => {
    await render()
    await typeAndSearch('キッチン')
    for (const n of ['システムキッチン交換', '撤去（サービス）', 'キッチンパネル']) await click(checkbox(n))
    expect(text()).toContain('¥260,000')   // 2 台 × 130,000 + 2 × 0
    expect(text()).toContain('売価なしの明細が 1 件あります')
  })
})

describe('追加', () => {
  async function selectThree() {
    await render()
    await typeAndSearch('キッチン')
    await click(checkbox('キッチンパネル'))
    await click(checkbox('システムキッチン交換'))
    await click(checkbox('撤去（サービス）'))
  }

  it('選んだ順・選んだ工種・fingerprint で 1 回だけ送り、成功後に reload してから閉じる（備考はコピーしない）', async () => {
    await selectThree()
    await act(async () => {
      const sel = document.getElementById('past-estimate-target') as HTMLSelectElement
      sel.value = G2
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onReload).not.toHaveBeenCalled()
    await click(copyButton())
    await flush()
    expect(posts).toEqual([{
      project_id: P, group_id: G2,
      items: [NOCOST, AUTO, MANUAL0].map(h => ({ source_item_id: h.id, fingerprint: h.copy_preview.fingerprint })),
      include_memo: false, include_internal_memo: false,
    }])
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('明細を選んでいる間は背景のクリックで閉じない（選んでいなければ閉じる）', async () => {
    await render()
    const overlay = () => dialog().parentElement!
    await typeAndSearch('キッチン')
    await click(checkbox('システムキッチン交換'))
    await act(async () => { overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    await click(checkbox('システムキッチン交換'))
    await act(async () => { overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('「その他」を選ぶと group_id = null', async () => {
    await selectThree()
    await act(async () => {
      const sel = document.getElementById('past-estimate-target') as HTMLSelectElement
      sel.value = ''
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(copyButton().textContent).toContain('「その他」')
    await click(copyButton())
    await flush()
    expect(posts[0].group_id).toBeNull()
  })

  it('既定の工種が無い（削除済み）なら「その他」', async () => {
    await render({ defaultGroupId: '00000000-0000-4000-8000-000000000099' })
    expect((document.getElementById('past-estimate-target') as HTMLSelectElement).value).toBe('')
  })

  it('開いている間に追加先の工種が消えたら「その他」に送る', async () => {
    await selectThree()
    await render({ groups: [{ id: G2, label: '住宅設備' }] })   // G1（既定）が無くなった
    expect((document.getElementById('past-estimate-target') as HTMLSelectElement).value).toBe('')
    await click(copyButton())
    await flush()
    expect(posts[0].group_id).toBeNull()
  })

  it('連打・Enter 連打でも 1 回しか送らず、実行中は操作できない', async () => {
    let release!: () => void
    copyReply = () => new Promise(r => { release = () => r(json({ inserted_count: 3 }, 201)) })
    await selectThree()
    const btn = copyButton()
    await act(async () => {
      btn.click(); btn.click()
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      btn.click()
    })
    expect(posts).toHaveLength(1)
    expect(copyButton().textContent).toBe('追加しています…')
    expect(copyButton().disabled).toBe(true)
    expect(checkbox('システムキッチン交換').disabled).toBe(true)
    expect(input().disabled).toBe(true)
    expect(buttonByText('キャンセル').disabled).toBe(true)
    // 実行中は Esc でも閉じない
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    // 成功する前に reload しない（明細が増えたように見せない）
    expect(onReload).not.toHaveBeenCalled()
    await act(async () => { release() })
    await flush()
    expect(posts).toHaveLength(1)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('409: 新しい金額を表示し、確認するまで追加できない。確認後は新しい fingerprint で送る', async () => {
    const newPreview = { ...AUTO.copy_preview, new_selling_price: 156000, difference: 11000, fingerprint: 'v1-99999999999999' }
    copyReply = async () => (posts.length === 1
      ? json({ error: 'changed', changed: [{ source_item_id: AUTO.id, copy_preview: newPreview, item: { name: AUTO.name, quantity: 2, unit: '台', cost_price: 120000, selling_price: 145000, selling_price_mode: 'auto' } }] }, 409)
      : json({ inserted_count: 3 }, 201))
    await selectThree()
    await click(copyButton())
    await flush()
    expect(text()).toContain('新しい金額を確認してから追加してください')
    expect(text()).toContain('金額が変わりました')
    expect(text()).toContain('¥156,000')
    // 新しい売価と一緒に、いまの原価も表示する（古い原価 ¥100,000 を並べない）
    const autoRow = checkbox('システムキッチン交換').closest('label')!.textContent!
    expect(autoRow).toContain('¥120,000')
    expect(autoRow).not.toContain('¥100,000')
    expect(onReload).not.toHaveBeenCalled()
    expect(copyButton().disabled).toBe(true)

    await click(buttonByText('新しい金額を確認しました'))
    expect(copyButton().disabled).toBe(false)
    await click(copyButton())
    await flush()
    expect(posts).toHaveLength(2)
    expect((posts[1].items as Array<{ source_item_id: string; fingerprint: string }>).find(i => i.source_item_id === AUTO.id)!.fingerprint).toBe('v1-99999999999999')
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('404（コピー元が使えない）: 該当の明細を選択から外して知らせ、追加しない', async () => {
    copyReply = async () => json({ error: 'x', missing_source_item_ids: [AUTO.id] }, 404)
    await selectThree()
    await click(copyButton())
    await flush()
    expect(text()).toContain('「システムキッチン交換」 は削除・変更されたため追加できません')
    expect(selectedNames()).toEqual(['キッチンパネル', '撤去（サービス）'])
    expect(onReload).not.toHaveBeenCalled()
    expect(copyButton().disabled).toBe(false)
  })

  it.each([
    [401, 'ログインの有効期限が切れました'],
    [403, 'この操作を行う権限がありません'],
    [404, 'コピー先の案件または工種が見つかりません'],
  ])('%i: 理由を表示し、追加・reload しない', async (status, message) => {
    copyReply = async () => json({ error: 'x' }, status)
    await selectThree()
    await click(copyButton())
    await flush()
    expect(text()).toContain(message)
    expect(text()).toContain('まだ追加していません')
    expect(onReload).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(selectedNames()).toHaveLength(3)
  })

  it.each([
    ['通信エラー', async () => { throw new TypeError('Failed to fetch') }],
    ['500', async () => json({ error: 'x' }, 500)],
  ])('%s: 結果不明として案内し、自動で再送しない。もう一度押せず、読み込み直しで確認して閉じる', async (_label, reply) => {
    copyReply = reply as () => Promise<Response>
    await selectThree()
    await click(copyButton())
    await flush()
    expect(text()).toContain(UNKNOWN_RESULT_MESSAGE)
    expect(posts).toHaveLength(1)
    // 追加ボタンは出さない（もう一度押して二重登録しないため）
    expect([...document.querySelectorAll('button')].some(b => /件を「/.test(b.textContent ?? ''))).toBe(false)
    expect(onReload).not.toHaveBeenCalled()
    await click(buttonByText('見積明細を読み込み直して確認する'))
    await flush()
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(posts).toHaveLength(1)
  })

  it('案件が変わったら（key で作り直し）選択・検索結果を持ち越さない', async () => {
    await selectThree()
    await act(async () => {
      root.render(
        <PastEstimatePicker key="other" projectId={'00000000-0000-4000-8000-000000000013'} groups={[]} defaultGroupId={null}
          onReload={onReload as unknown as () => Promise<unknown>} onClose={onClose as unknown as () => void} />,
      )
    })
    expect(selectedNames()).toEqual([])
    expect(text()).not.toContain('システムキッチン交換')
  })
})
