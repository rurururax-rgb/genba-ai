import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'

// 請求書の印刷 HTML（printInvoice）の明細レイアウト。実際の1行化・折り返しはブラウザで確認する
afterEach(() => { vi.unstubAllGlobals() })

/** 架空の発行者情報（実在の会社・口座ではない） */
const ISSUER: InvoiceIssuerProfile = {
  companyName: 'QA工務店',
  bank: { branch: 'QA銀行 / テスト支店', accountType: '普通', accountNumber: '0000000', holder: 'QA工務店', holderKana: 'キューエーコウムテン' },
  registrationNumber: 'T0000000000000', postalCode: '000-0000', address: 'QA県テスト市1-1',
  tel: '000-0000-0000', email: 'qa@example.com', license: 'QA-000000', logoPath: '/favicon.ico',
}

async function print(items: Array<{ name: string; quantity: number; unit: string; amount: number; memo: string }>) {
  let html = ''
  vi.stubGlobal('window', { location: { origin: 'https://example.test' }, open: () => ({ document: { write: (h: string) => { html = h }, close: () => {} } }) })
  vi.stubGlobal('alert', vi.fn())
  const { printInvoice } = await import('@/components/projects/InvoiceTab')
  const invoice = { customer_name: 'QA顧客', issued_at: '2026-10-01', payment_due_at: null, adjustment: 0, items: items.map((it, i) => ({ id: String(i), ...it })) }
  printInvoice(invoice as never, 123456, 12345, 135801, ISSUER)
  return html
}

describe('printInvoice 明細テーブル', () => {
  it('列幅は 番号3% / 工事名44% / 数量7% / 単位7% / 金額20% / 備考19%（合計100%）', async () => {
    const html = await print([])
    const widths = Object.fromEntries([...html.matchAll(/col\.c-(\w+)\s*\{ width: (\d+)%; \}/g)].map(m => [m[1], Number(m[2])]))
    expect(widths).toEqual({ no: 3, name: 44, qty: 7, unit: 7, amt: 20, memo: 19 })
    expect(Object.values(widths).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('工事名・備考は全文をそのまま出力し、省略記号や切り捨ての指定を持たない', async () => {
    const longName = 'サンプル様邸 水回り・内装改修工事（キッチン・浴室・洗面・トイレ交換およびLDK床フローリング張替え）Supercalifragilisticexpialidocious'
    const longMemo = '既存配管の劣化状況により追加工事の可能性あり。詳細は現地調査後に別途ご相談させていただきます。'
    const html = await print([{ name: longName, quantity: 1.5, unit: '式', amount: 123456, memo: longMemo }])
    expect(html).toContain(`<td class="td-name"><span class="name-text">${longName}</span></td>`)
    expect(html).toContain(`<td class="td-memo">${longMemo}</td>`)
    expect(html).not.toMatch(/text-overflow|ellipsis|line-clamp/)
    expect(html).toMatch(/\.td-name, \.td-memo \{ overflow: visible; overflow-wrap: anywhere;/)
  })

  it('工事名は HTML エスケープされる', async () => {
    const html = await print([{ name: '<b>A&B</b>', quantity: 1, unit: '式', amount: 1, memo: '' }])
    expect(html).toContain('<span class="name-text">&lt;b&gt;A&amp;B&lt;/b&gt;</span>')
  })

  it('明細は最低21行・金額表示は従来どおり', async () => {
    const html = await print([{ name: '工事一式', quantity: 1, unit: '式', amount: 123456, memo: '' }])
    expect(html.match(/<td class="td-no"/g)).toHaveLength(21)
    expect(html).toContain('<td class="td-amt">¥123,456</td>')
    expect(html).toContain('<td class="foot-value">¥123,456</td>')
    expect(html).toContain('<td class="foot-value">¥12,345</td>')
    expect(html).toContain('<td class="foot-value">¥135,801</td>')
  })
})
