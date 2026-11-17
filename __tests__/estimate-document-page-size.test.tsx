// @vitest-environment jsdom
/**
 * お客様向け見積書（表紙・総括表・内訳明細）の用紙の大きさと改ページ。
 * - すべてのページを同じ A4 横（画面 1050 × 741px、印刷 297mm × 210mm）にする。総括表の行が少なくても短くしない
 * - 明細は行の高さを見積もって改ページし、長い備考があってもページからはみ出さない
 * - 工種が多いときは総括表も複数ページにし、合計は最後の総括表ページだけに出す
 * 金額の計算は変えない（表示される金額が変わらないことも確かめる）。
 * 実際の表示の高さ（レイアウト）は jsdom では測れないため、ブラウザでの確認結果を PR に記載している。
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EstimateDocument } from '@/components/estimate/EstimateDocument'
import { toCustomerEstimateItems } from '@/lib/estimate/customer-output'

type Row = { group_id: string | null; name: string; quantity: number; selling_price: number | null; memo?: string | null }

const company = { name: '架空工務店', display_name: null, tax_rate: 0.1, template_id: 'rugs' }
const project = { id: 'p1', name: '架空邸 改修工事', customer_name: '架空 太郎', site_address: '架空県架空市' }
const LONG = '既存仕上げ撤去後、下地の状態を確認のうえ補修。必要に応じて合板増し張り、継ぎ目処理、パテ二回塗り、研磨まで含む。'

function render(groups: Array<{ id: string; label: string }>, rows: Row[]) {
  const items = toCustomerEstimateItems(rows.map((r, i) => ({
    id: `i${i}`, category: null, unit: '式', retail_price: null, row_type: 'item', memo: null, sort_order: i,
    amount: r.selling_price == null ? null : r.quantity * r.selling_price, ...r,
  })))
  const html = renderToStaticMarkup(
    <EstimateDocument projectId="p1" project={project} company={company}
      groups={groups.map((g, i) => ({ ...g, sort_order: i }))} items={items} />,
  )
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const pages = [...doc.querySelectorAll<HTMLElement>('.doc-page')]
  return { html, doc, pages }
}

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, '')
const pageNo = (page: Element) => Number(page.querySelector('span:last-child')?.textContent)
/** 行の種類ごとの高さ（文字のある行 29px・文字のない行 24px。実測値） */
const rowHeight = (tr: HTMLTableRowElement) => (text(tr) ? 29 : 24)
const BODY_H = 741 - 32 - 31 - 26 - 22 - 2 - 8   // 1 ページの表本体に使える高さ（EstimateDocument と同じ）

const TWO_GROUPS = [{ id: 'g1', label: '内装工事' }, { id: 'g2', label: '設備工事' }]
const FEW: Row[] = [
  { group_id: 'g1', name: 'クロス張替', quantity: 45, selling_price: 1200 },
  { group_id: 'g1', name: 'CF 張替', quantity: 12, selling_price: 3800 },
  { group_id: 'g2', name: '給湯器交換', quantity: 1, selling_price: 286000 },
]

describe('見積書の用紙の大きさ（A4 横）', () => {
  it('表紙・総括表・明細のすべてのページが同じ幅・高さ（総括表も 741px より短くならない）', () => {
    const { pages } = render(TWO_GROUPS, FEW)
    expect(pages).toHaveLength(4)   // 表紙・総括表・明細 2
    for (const p of pages) {
      expect(p.style.width).toBe('1050px')
      expect(p.style.height || p.style.minHeight).toBe('741px')
    }
    expect(pages[0].classList.contains('doc-cover')).toBe(true)
  })

  it('印刷・PDF 保存は A4 横で、各ページ 210mm（表紙は 210mm 固定）・最後のページ以外で改ページ', () => {
    const { html, pages } = render(TWO_GROUPS, FEW)
    expect(html).toContain('@page { size: A4 landscape; margin: 0; }')
    expect(html).toMatch(/\.doc-page \{[^}]*min-height: 210mm !important;/)
    expect(html).toContain('.doc-cover { height: 210mm !important; }')
    expect(pages.map(p => p.classList.contains('page-break'))).toEqual([true, true, true, false])
  })

  it('総括表は工種が 2 つでもページの下まで空行で埋まり、合計行は表の最後', () => {
    const { pages } = render(TWO_GROUPS, FEW)
    const rows = [...pages[1].querySelectorAll('tbody tr')] as HTMLTableRowElement[]
    const used = rows.reduce((s, r) => s + rowHeight(r), 0)
    expect(used).toBeLessThanOrEqual(BODY_H)
    expect(used).toBeGreaterThan(BODY_H - 24)
    expect(text(rows[rows.length - 1])).toContain('合計')
    expect(text(rows[rows.length - 1])).toContain('385,600')
  })

  it('明細ページも下まで空行で埋まり、小計行は表の最後', () => {
    const { pages } = render(TWO_GROUPS, FEW)
    for (const p of pages.slice(2)) {
      const rows = [...p.querySelectorAll('tbody tr')] as HTMLTableRowElement[]
      const used = rows.reduce((s, r) => s + rowHeight(r), 0)
      expect(used).toBeLessThanOrEqual(BODY_H)
      expect(used).toBeGreaterThan(BODY_H - 24)
      expect(text(rows[rows.length - 1])).toContain('小計')
    }
  })
})

describe('改ページ（ページからはみ出さない）', () => {
  it('1 行の明細が 45 行なら 19・19・7 行で 3 ページ（これまでと同じ区切り）、ページ番号は続き番号', () => {
    const rows: Row[] = Array.from({ length: 45 }, (_, i) => ({ group_id: 'g1', name: `明細 ${i + 1}`, quantity: 1, selling_price: 1000 + i }))
    const { pages } = render([{ id: 'g1', label: '内装工事' }], rows)
    const details = pages.slice(2)
    expect(details.map(p => [...p.querySelectorAll('tbody tr')].filter(tr => /明細\d+/.test(text(tr))).length)).toEqual([19, 19, 7])
    expect(pages.slice(1).map(pageNo)).toEqual([1, 2, 3, 4])
    expect(text(details[1])).toContain('内装工事（続き）')
  })

  it('長い名称・備考の行は高さを見積もって改ページする（1 ページ 19 行に詰め込まない）。各ページの小計の和は総額と同じ', () => {
    const rows: Row[] = Array.from({ length: 19 }, (_, i) => ({ group_id: 'g1', name: `下地補修・${LONG.slice(0, 30)}`, quantity: 1, selling_price: 5000 + i, memo: LONG + LONG }))
    const { pages } = render([{ id: 'g1', label: '内装工事' }], rows)
    const details = pages.slice(2)
    expect(details.length).toBeGreaterThanOrEqual(4)
    const perPage = details.map(p => [...p.querySelectorAll('tbody tr')].filter(tr => text(tr).includes('下地補修')).length)
    expect(perPage.reduce((s, n) => s + n, 0)).toBe(19)
    for (const n of perPage) expect(n).toBeLessThanOrEqual(5)   // 1 行 ≒ 101px（備考 6 行）→ 1 ページ 5 行まで
    const subtotals = details.map(p => {
      const rows = [...p.querySelectorAll('tbody tr')]
      return Number(text(rows[rows.length - 1]).replace(/[^\d]/g, ''))
    })
    expect(subtotals.reduce((s, n) => s + n, 0)).toBe(rows.reduce((s, r) => s + r.quantity * (r.selling_price ?? 0), 0))
  })

  it('工種が 20 あると総括表は 2 ページ（合計は 2 ページ目だけ）、明細は 3 ページ目から', () => {
    const groups = Array.from({ length: 20 }, (_, i) => ({ id: `g${i}`, label: `工種${i + 1}` }))
    const rows: Row[] = groups.map((g, i) => ({ group_id: g.id, name: `明細 ${i + 1}`, quantity: 1, selling_price: 10000 }))
    const { pages } = render(groups, rows)
    const summaries = pages.slice(1, 3)
    expect(summaries.map(pageNo)).toEqual([1, 2])
    expect(text(summaries[0])).not.toContain('合計')
    expect(text(summaries[1])).toContain('合計')
    expect(text(summaries[1])).toContain('200,000')
    const listed = summaries.flatMap(p => [...p.querySelectorAll('tbody tr')].map(text).filter(t => /^\d+工種\d+/.test(t)))
    expect(listed).toHaveLength(20)
    expect(pages.slice(3).map(pageNo)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3))
  })
})

describe('金額は変わらない', () => {
  it('表紙の税込合計・お支払イメージ・総括表の合計', () => {
    const { pages } = render(TWO_GROUPS, FEW)
    // 小計 385,600 + 諸経費 8% 30,848 = 416,448 → 税 41,644（切り捨て）→ 458,092
    expect(text(pages[0])).toContain('¥458,092')
    expect(text(pages[0])).toContain('¥91,618')
    expect(text(pages[1])).toContain('385,600')
  })
})
