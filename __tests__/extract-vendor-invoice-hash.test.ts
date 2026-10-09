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
    messages = { create: async () => ({ content: [{ type: 'text', text: aiText }] }) }
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
      vendor_name: 'QA設備', invoice_number: '  INV-001 ', total_amount: 33000, invoice_date: '2026-10-01',
      payment_due_date: null, items: [], raw_warning: null, document_sha256: 'f'.repeat(64),
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
    aiText = '{"vendor_name":"","invoice_number":null,"total_amount":null,"invoice_date":null,"payment_due_date":null,"items":[],"raw_warning":null}'
    const a = await extract(new Uint8Array([9, 9, 9]))
    const b = await extract(new Uint8Array([9, 9, 9]))
    const c = await extract(new Uint8Array([9, 9, 8]))
    expect(a.json.document_sha256).toBe(b.json.document_sha256)
    expect(a.json.document_sha256).not.toBe(c.json.document_sha256)
    expect(a.json.invoice_number).toBeNull()
  })

  it('請求書番号が文字列でなければ null', async () => {
    aiText = '{"vendor_name":"x","invoice_number":12345,"total_amount":1,"invoice_date":null,"payment_due_date":null,"items":[],"raw_warning":null}'
    expect((await extract(new Uint8Array([1]))).json.invoice_number).toBeNull()
  })
})
