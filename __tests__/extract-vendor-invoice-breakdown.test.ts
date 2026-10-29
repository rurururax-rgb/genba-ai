import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/ai/extract-vendor-invoice: 税率ごとの内訳（tax_breakdown）は、原本に税率別の行・表として
 * 印字されたものだけを書き写させる（合計欄から組み立てさせない）。
 * AI（Anthropic SDK）は偽物に置き換え、ルートが AI に送る指示と、AI の応答から作る画面用の値を確かめる。
 */

let aiText = ''
const sent: Array<{ system: string }> = []

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: { system: string }) => {
        sent.push(params)
        return { content: [{ type: 'text', text: aiText }], stop_reason: 'end_turn' }
      },
    }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
}))

const { POST } = await import('@/app/api/ai/extract-vendor-invoice/route')

async function extract(ai: Record<string, unknown>) {
  aiText = JSON.stringify({ vendor_name: '架空テスト', invoice_number: null, invoice_date: null, payment_due_date: null, items: [], warnings: [], ...ai })
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([1, 2, 3])], 'invoice.png', { type: 'image/png' }))
  const res = await POST(new NextRequest('http://localhost/api/ai/extract-vendor-invoice', { method: 'POST', body: fd }))
  expect(res.status).toBe(200)
  return await res.json() as {
    amounts: { tax_breakdown: unknown[]; tax_amount: number | null; tax_treatment: string }
    review: { suggested_excl_tax: number | null; status: string; messages: Array<{ text: string }> }
  }
}

describe('extract-vendor-invoice：税率ごとの内訳', () => {
  it('AI への指示：内訳は税率別の行・表として印字された場合だけ。合計欄から作らない。対象額を補わない。単一税率の行は残す', async () => {
    await extract({ subtotal_excl_tax: 1, tax_amount: 0, total_incl_tax: 1, tax_treatment: 'exclusive', tax_breakdown: [] })
    const system = sent.at(-1)!.system
    const rule = system.split('\n').filter(l => l.includes('tax_breakdown') || l.startsWith('  - ')).join('\n')
    expect(rule).toContain('合計欄とは別の行・表')
    expect(rule).toContain('合計欄（「小計」「消費税（10%）」「うち消費税 10%」「合計」など）から内訳を組み立てない。合計欄しかなければ空配列')
    expect(rule).toContain('対象額が印字されていなければ taxable_amount は null')
    expect(rule).toContain('税率が1つでも、税率別の行・表として印字されていればその1行を書き写す')
  })

  it('B 内税：合計欄しかなく内訳が空配列 → 内訳は空のまま、税額・内税は維持、候補は 110,000 − 10,000 = 100,000', async () => {
    const r = await extract({ subtotal_excl_tax: null, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'inclusive', tax_breakdown: [] })
    expect(r.amounts.tax_breakdown).toEqual([])
    expect(r.amounts).toMatchObject({ tax_amount: 10000, tax_treatment: 'inclusive' })
    expect(r.review).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
  })

  it('印字された単一税率（8%）の1行・混在の2行は、そのまま画面に返す', async () => {
    const one = await extract({ subtotal_excl_tax: 100000, tax_amount: 8000, total_incl_tax: 108000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 8, taxable_amount: 100000, tax_amount: 8000 }] })
    expect(one.amounts.tax_breakdown).toEqual([{ rate: 8, taxable_amount: 100000, tax_amount: 8000 }])
    expect(one.review).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })

    const mixed = await extract({ subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 5000 }, { rate: 8, taxable_amount: 50000, tax_amount: 4000 }] })
    expect(mixed.amounts.tax_breakdown).toHaveLength(2)
    expect(mixed.review.messages.some(m => m.text.includes('税率が混在'))).toBe(true)
  })
})
