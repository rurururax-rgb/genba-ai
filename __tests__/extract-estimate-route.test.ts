import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/ai/extract-estimate：AI の出力上限・途中終了・不正な JSON・タイムアウト・大きな画像・画像ごとの失敗。
 * AI（Anthropic SDK）は偽物に置き換える。DB には接続しない（認証だけ模擬）。すべて架空の見積書。
 */

type Params = { max_tokens: number; system: string }
type Reply = { text: string; stop_reason: string } | Error
let replies: Reply[]
let sent: Params[]

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: Params) => {
        sent.push(params)
        const r = replies.length > 1 ? replies.shift()! : replies[0]
        if (r instanceof Error) throw r
        return { content: [{ type: 'text', text: r.text }], stop_reason: r.stop_reason }
      },
    }
  },
}))
let loggedIn = true
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: loggedIn ? { id: 'u' } : null } }) } }),
}))

const { POST } = await import('@/app/api/ai/extract-estimate/route')

const ok = (body: unknown): Reply => ({ text: JSON.stringify(body), stop_reason: 'end_turn' })
const DOC = {
  supplier: '架空建材', document_type: '御見積書',
  items: [{ name: 'フローリング材', quantity: 10, unit: '㎡', list_price: 5000, rate: 0.6, cost_price: 3000, amount: 30000, vendor_name: null, note: '品番 FL-1' }],
  items_total: 1, subtotal: 30000, adjustments: [], prices_include_tax: false, warnings: [],
}

async function post(files: Array<{ name: string; bytes?: number; type?: string }>) {
  const fd = new FormData()
  for (const f of files) fd.append('files', new File([new Uint8Array(f.bytes ?? 3)], f.name, { type: f.type ?? 'image/jpeg' }))
  const res = await POST(new NextRequest('http://localhost/api/ai/extract-estimate', { method: 'POST', body: fd }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeEach(() => {
  sent = []
  replies = [ok(DOC)]
  loggedIn = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('AI への指示と出力上限', () => {
  it('印字されていない金額を作らせない指示・仕入れ原価のみ・出力上限 8192', async () => {
    await post([{ name: 'a.jpg' }])
    expect(sent[0].max_tokens).toBe(8192)
    const p = sent[0].system
    expect(p).toContain('業者から自社への請求金額')
    expect(p).toContain('金額 ÷ 数量 で単価を作らない')
    expect(p).toContain('定価 × 掛率 を自分で計算して単価にしない')
    expect(p).toContain('adjustments')
    expect(p).not.toMatch(/"selling_price"\s*:/)
  })

  it('正常な応答は正規化して返す（行の業者名は書類の業者名で補う）', async () => {
    const r = await post([{ name: 'a.jpg' }])
    expect(r.status).toBe(200)
    const files = r.body.files as Array<Record<string, unknown>>
    expect(files[0]).toMatchObject({ fileName: 'a.jpg', supplier: '架空建材', subtotal: 30000, messages: [] })
    expect(r.body.items).toEqual([expect.objectContaining({ name: 'フローリング材', cost_price: 3000, list_price: 5000, rate: 0.6, amount: 30000, vendor_name: '架空建材' })])
    expect(r.body.failures).toEqual([])
  })
})

describe('不完全な応答は正常扱いしない', () => {
  it('出力上限で途中終了（max_tokens）→ 502 ai_truncated・明細を返さない', async () => {
    replies = [{ text: JSON.stringify(DOC), stop_reason: 'max_tokens' }]
    const r = await post([{ name: 'a.jpg' }])
    expect(r.status).toBe(502)
    expect(r.body.code).toBe('ai_truncated')
    expect(r.body.items).toBeUndefined()
    expect(String(r.body.error)).toContain('分けて撮影')
  })

  it('途中で切れた JSON → 502 ai_invalid_response', async () => {
    replies = [{ text: JSON.stringify(DOC).slice(0, 80), stop_reason: 'end_turn' }]
    expect((await post([{ name: 'a.jpg' }])).body.code).toBe('ai_invalid_response')
  })

  it('items のない JSON・説明文だけ → 502 ai_invalid_response', async () => {
    replies = [ok({ supplier: 'x' })]
    expect((await post([{ name: 'a.jpg' }])).body.code).toBe('ai_invalid_response')
    replies = [{ text: '読み取れませんでした', stop_reason: 'end_turn' }]
    expect((await post([{ name: 'a.jpg' }])).body.code).toBe('ai_invalid_response')
  })

  it('end_turn 以外で終了 → 502 ai_incomplete', async () => {
    replies = [{ text: JSON.stringify(DOC), stop_reason: 'refusal' }]
    expect((await post([{ name: 'a.jpg' }])).body.code).toBe('ai_incomplete')
  })

  it('AI 呼び出しのタイムアウト → 504 ai_timeout（日本語の案内）', async () => {
    replies = [new Error('Request timed out.')]
    const r = await post([{ name: 'a.jpg' }])
    expect(r.status).toBe(504)
    expect(r.body.code).toBe('ai_timeout')
  })

  it('その他の失敗 → 500 ai_failed（英語のメッセージを出さない）', async () => {
    replies = [new Error('boom')]
    const r = await post([{ name: 'a.jpg' }])
    expect(r.status).toBe(500)
    expect(r.body.error).not.toMatch(/[a-z]{4,}/)
  })
})

describe('画像ごとの失敗', () => {
  it('2 枚のうち 1 枚が途中終了しても、もう 1 枚の結果は返し、失敗した画像を伝える', async () => {
    replies = [ok(DOC), { text: '{', stop_reason: 'max_tokens' }]
    const r = await post([{ name: 'p1.jpg' }, { name: 'p2.jpg' }])
    expect(r.status).toBe(200)
    expect((r.body.files as unknown[]).length).toBe(1)
    expect(r.body.failures).toEqual([expect.objectContaining({ fileName: 'p2.jpg', code: 'ai_truncated' })])
  })
})

describe('入力の検査（AI に送らない）', () => {
  it('合計 4MB を超える画像は 413', async () => {
    const r = await post([{ name: 'big.jpg', bytes: 4 * 1024 * 1024 + 1 }])
    expect(r.status).toBe(413)
    expect(sent).toHaveLength(0)
  })

  it('対応していない形式・11 枚以上・未ログインは断る', async () => {
    expect((await post([{ name: 'a.heic', type: 'image/heic' }])).status).toBe(400)
    expect((await post(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.jpg` })))).status).toBe(400)
    loggedIn = false
    expect((await post([{ name: 'a.jpg' }])).status).toBe(401)
    expect(sent).toHaveLength(0)
  })
})
