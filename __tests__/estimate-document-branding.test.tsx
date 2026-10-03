import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EstimateDocument } from '@/components/estimate/EstimateDocument'
import { toCustomerEstimateItems } from '@/lib/estimate/customer-output'

const project = { id: 'p1', name: 'キッチン改修工事', customer_name: '山田 太郎', site_address: '東京都千代田区1-1' }
const groups = [{ id: 'g1', label: '内装', sort_order: 0 }]
const items = toCustomerEstimateItems([
  { id: 'i1', name: 'システムキッチン', quantity: 1, unit: '式', selling_price: 500000, amount: 500000, group_id: 'g1', sort_order: 0, row_type: 'item', memo: '型番 K-100' },
])

const render = (company: Parameters<typeof EstimateDocument>[0]['company']) =>
  renderToStaticMarkup(<EstimateDocument projectId="p1" project={project} company={company} groups={groups} items={items} />)

// ラグズ建築の固有情報（他社の見積書に出てはいけない）
const RUGS_STRINGS = ['ラグズ', 'cover-logo', 'excel-images', 'RUGS', '栗本', '岐阜', '058-374', 'T2200001044783', '十六銀行']

describe('見積書（プレビュー / 印刷 / PDF）の会社表示', () => {
  it("template_id = 'rugs'：既存のラグズ建築ロゴを表示", () => {
    const html = render({ name: 'ラグズ建築', display_name: null, tax_rate: 0.1, template_id: 'rugs' })
    expect(html).toContain('/excel-images/cover-logo.png')
    expect(html).toContain('ラグズ建築')
  })

  it("template_id = 'modern'：ラグズ建築のロゴ・会社情報は 0 件、display_name を表示", () => {
    const html = render({ name: 'トライアル工務店株式会社', display_name: 'トライアル工務店', tax_rate: 0.1, template_id: 'modern' })
    for (const s of RUGS_STRINGS) expect(html, s).not.toContain(s)
    expect(html).not.toContain('<img')
    expect(html).toContain('トライアル工務店')
    expect(html).toContain('システムキッチン')
    expect(html).toContain('500,000')
  })

  it('display_name が無ければ name を表示', () => {
    const html = render({ name: 'トライアル工務店株式会社', display_name: null, tax_rate: 0.1, template_id: 'modern' })
    expect(html).toContain('トライアル工務店株式会社')
    for (const s of RUGS_STRINGS) expect(html, s).not.toContain(s)
  })

  it.each([
    ['template_id 未設定', { name: 'A社', display_name: null, tax_rate: 0.1 }],
    ['template_id null', { name: 'A社', display_name: null, tax_rate: 0.1, template_id: null }],
    ['会社情報なし', null],
    ['会社名が空', { name: '', display_name: null, tax_rate: 0.1, template_id: 'modern' }],
  ])('%s：ラグズ建築を fallback にしない', (_label, company) => {
    const html = render(company as Parameters<typeof EstimateDocument>[0]['company'])
    for (const s of RUGS_STRINGS) expect(html, s).not.toContain(s)
    expect(html).not.toContain('<img')
  })
})
