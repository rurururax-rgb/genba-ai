import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

/**
 * POST /api/ai/extract-vendor-invoice: 画像の SHA-256 はサーバーが元のバイト列から計算する（P1-1 / PR #30）。
 * AI（Anthropic SDK）は偽物に置き換える。AI がハッシュらしき値を返しても使わない。
 */

let aiText = ''

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: async () => ({ content: [{ type: 'text', text: aiText }], stop_reason: 'end_turn' }) }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
}))

const { POST } = await import('@/app/api/ai/extract-vendor-invoice/route')

async function extract(bytes: Uint8Array<ArrayBuffer>) {
  const fd = new FormData()
  fd.append('file', new File([bytes], 'invoice.png', { type: 'image/png' }))
  const res = await POST(new NextRequest('http://localhost/api/ai/extract-vendor-invoice', { method: 'POST', body: fd }))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

describe('extract-vendor-invoice', () => {
  it('SHA-256 は元のバイト列から計算し、AI の値は使わない。請求書番号を返す', async () => {
    aiText = JSON.stringify({
      vendor_name: 'QA設備', invoice_number: '  INV-001 ', subtotal_excl_tax: 30000, tax_amount: 3000, total_incl_tax: 33000,
      tax_treatment: 'exclusive', tax_breakdown: [], invoice_date: '2026-10-01',
      payment_due_date: null, items: [], warnings: [], document_sha256: 'f'.repeat(64),
    })
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const r = await extract(bytes)
    expect(r.status).toBe(200)
    expect(r.json.document_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(r.json.document_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.json.invoice_number).toBe('INV-001')
    expect(r.json.vendor_name).toBe('QA設備')
  })

  it('同じバイト列は同じハッシュ、1バイト違えば別のハッシュ', async () => {
    aiText = '{"vendor_name":"","invoice_number":null,"total_incl_tax":null,"invoice_date":null,"payment_due_date":null,"items":[],"warnings":[]}'
    const a = await extract(new Uint8Array([9, 9, 9]))
    const b = await extract(new Uint8Array([9, 9, 9]))
    const c = await extract(new Uint8Array([9, 9, 8]))
    expect(a.json.document_sha256).toBe(b.json.document_sha256)
    expect(a.json.document_sha256).not.toBe(c.json.document_sha256)
    expect(a.json.invoice_number).toBeNull()
  })

  it('請求書番号が文字列でなければ null', async () => {
    aiText = '{"vendor_name":"x","invoice_number":12345,"total_incl_tax":1,"invoice_date":null,"payment_due_date":null,"items":[],"warnings":[]}'
    expect((await extract(new Uint8Array([1]))).json.invoice_number).toBeNull()
  })

  it('税抜・消費税・税込を分けて返し、登録金額（税抜）の候補と照合結果はサーバーが作る（AI の値は使わない）', async () => {
    aiText = JSON.stringify({
      vendor_name: 'QA設備', invoice_number: 'INV-002', subtotal_excl_tax: '100,000', tax_amount: 10000, total_incl_tax: 110000,
      tax_treatment: 'exclusive', tax_breakdown: [{ rate: 10, taxable_amount: 100000, tax_amount: 10000 }],
      invoice_date: '2026-10-01', payment_due_date: '2026-10-31', items: [{ name: '部材', amount: '100,000' }], warnings: ['かすれあり'],
      review: { suggested_excl_tax: 999, status: 'ok', messages: [] }, total_amount: 110000,
    })
    const { json } = await extract(new Uint8Array([7]))
    expect(json.amounts).toEqual({
      subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 100000, tax_amount: 10000 }],
      adjustments: [],
      printed_tax_rates: [],
    })
    expect(json.review).toMatchObject({ suggested_excl_tax: 100000, suggested_from: 'printed_subtotal', status: 'ok' })
    expect(json.items).toEqual([{ name: '部材', amount: 100000 }])
    expect(json.warnings).toEqual(['かすれあり'])
    // 旧形式の total_amount は返さない（税込が登録金額に入らないように）
    expect(json).not.toHaveProperty('total_amount')
  })

  it('税込しかない請求書は候補なし・要確認。支払期日は payment_due_date として返し、支払日（payment_date）には入れない', async () => {
    aiText = JSON.stringify({
      vendor_name: 'QA設備', invoice_number: null, total_incl_tax: 110000, tax_treatment: 'unknown',
      invoice_date: '2026-10-01', payment_due_date: '2026-10-31', items: [], warnings: [],
    })
    const { json } = await extract(new Uint8Array([8]))
    expect(json.review).toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
    expect(json.payment_due_date).toBe('2026-10-31')
    expect(json).not.toHaveProperty('payment_date')
  })

  it('日付の形式が違えば null。形の崩れた出力でも落ちない', async () => {
    aiText = JSON.stringify({ vendor_name: 1, invoice_date: '10/1', payment_due_date: '2026-13-45', items: 'x', warnings: [1, '注意'] })
    const { status, json } = await extract(new Uint8Array([6]))
    expect(status).toBe(200)
    expect(json).toMatchObject({ vendor_name: '', invoice_date: null, payment_due_date: null, items: [], warnings: ['注意'] })
    expect(json.review).toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
  })
})
