import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/ai/extract-vendor-invoice：明細が多い請求書・AI 応答の途中終了・大きな画像。
 * AI（Anthropic SDK）は偽物に置き換え、ルートが AI に渡す上限と指示、応答の扱いを確かめる。すべて架空の請求書。
 */

type Params = { max_tokens: number; system: string }
let reply: { text: string; stop_reason: string }
let sent: Params[]

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: Params) => {
        sent.push(params)
        return { content: [{ type: 'text', text: reply.text }], stop_reason: reply.stop_reason }
      },
    }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
}))

const { POST } = await import('@/app/api/ai/extract-vendor-invoice/route')

const BASE = {
  vendor_name: '架空資材センター', invoice_number: 'QA-INV-006', invoice_date: '2026-10-06', payment_due_date: null,
  subtotal_excl_tax: 45000, tax_amount: 4500, total_incl_tax: 49500, tax_treatment: 'exclusive',
  tax_breakdown: [], adjustments: [], warnings: [],
}
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `部材${i + 1}`, amount: 1000 }))

async function post(bytes = 3) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(bytes)], 'invoice.png', { type: 'image/png' }))
  const res = await POST(new NextRequest('http://localhost/api/ai/extract-vendor-invoice', { method: 'POST', body: fd }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeEach(() => {
  sent = []
  reply = { text: JSON.stringify({ ...BASE, items: items(3), items_total: 3 }), stop_reason: 'end_turn' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('明細が多い請求書（40 行以上）', () => {
  it('AI には出力上限 4096 トークンで、明細は最初の 20 行だけと全体の行数を書かせる', async () => {
    await post()
    expect(sent[0].max_tokens).toBeGreaterThanOrEqual(4096)
    expect(sent[0].system).toContain('**最初の 20 行まで**')
    expect(sent[0].system).toContain('items_total')
  })

  it('AI が 45 行を返しても画面には 20 行だけ返し、原本の行数 45 を示す。金額の判定は明細に左右されない', async () => {
    reply.text = JSON.stringify({ ...BASE, items: items(45), items_total: 45 })
    const { status, body } = await post()
    expect(status).toBe(200)
    expect((body.items as unknown[]).length).toBe(20)
    expect(body.items_total).toBe(45)
    expect(body.review).toMatchObject({ suggested_excl_tax: 45000, status: 'ok' })
  })

  it('items_total が無い・不正なら、返した行数を使う', async () => {
    reply.text = JSON.stringify({ ...BASE, items: items(5), items_total: 'many' })
    expect((await post()).body.items_total).toBe(5)
  })
})

describe('AI 応答の途中終了・不完全な応答は正常扱いしない', () => {
  it('出力上限で途中終了（stop_reason = max_tokens）→ JSON として読めても 502 ai_truncated。金額は返さない', async () => {
    reply = { text: JSON.stringify({ ...BASE, items: items(20) }), stop_reason: 'max_tokens' }
    const { status, body } = await post()
    expect(status).toBe(502)
    expect(body.code).toBe('ai_truncated')
    expect(body).not.toHaveProperty('amounts')
    expect(body).not.toHaveProperty('review')
  })

  it('途中で切れた JSON（以前の 40 行の請求書で起きた形）→ 502 ai_invalid_response', async () => {
    reply = { text: JSON.stringify({ ...BASE, items: items(40) }).slice(0, 600), stop_reason: 'end_turn' }
    const { status, body } = await post()
    expect(status).toBe(502)
    expect(body.code).toBe('ai_invalid_response')
  })

  it('end_turn 以外の終了（拒否など）→ 502 ai_incomplete', async () => {
    reply.stop_reason = 'refusal'
    const { status, body } = await post()
    expect(status).toBe(502)
    expect(body.code).toBe('ai_incomplete')
  })

  it('JSON が無い応答 → 502', async () => {
    reply = { text: '読み取れませんでした', stop_reason: 'end_turn' }
    expect((await post()).status).toBe(502)
  })
})

describe('大きな画像', () => {
  it('4MB を超える画像は AI に送らず 413（日本語の案内と code を JSON で返す）', async () => {
    const { status, body } = await post(4 * 1024 * 1024 + 1)
    expect(status).toBe(413)
    expect(body.code).toBe('too_large')
    expect(String(body.error)).toContain('4MB')
    expect(sent).toHaveLength(0)
  })

  it('4MB ちょうどは受け付ける', async () => {
    expect((await post(4 * 1024 * 1024)).status).toBe(200)
  })
})
