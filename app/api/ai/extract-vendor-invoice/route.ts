import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerClient } from '@/lib/supabase/server'

export const maxDuration = 60

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `あなたはリフォーム会社が業者（仕入れ先）から受け取った請求書画像から情報を抽出する専門アシスタントです。

## 抽出対象
- vendor_name: 請求書を発行した業者名（社名・屋号）
- total_amount: 請求合計金額（税込）。税込合計が明記されていればそれ。なければ税抜合計。数値のみ（カンマなし）
- invoice_date: 請求書の発行日・請求日（YYYY-MM-DD形式）。読み取れなければnull
- payment_due_date: 支払期日・支払期限（YYYY-MM-DD形式）。読み取れなければnull
- items: 明細行。品名と金額のみ。なければ空配列
- raw_warning: 読み取りで不確かな点があれば記載、なければnull

## 必ずJSON形式のみで返してください。説明文は不要です。

{
  "vendor_name": "業者名（読み取れなければ空文字）",
  "total_amount": 数値またはnull,
  "invoice_date": "YYYY-MM-DD"またはnull,
  "payment_due_date": "YYYY-MM-DD"またはnull,
  "items": [
    { "name": "品名", "amount": 数値またはnull }
  ],
  "raw_warning": nullまたは"不確かな点"
}`

type ExtractedInvoice = {
  vendor_name: string
  total_amount: number | null
  invoice_date: string | null
  payment_due_date: string | null
  items: Array<{ name: string; amount: number | null }>
  raw_warning: string | null
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'JPEG/PNG/WebP のみ対応しています' }, { status: 400 })
  }
  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: '8MB 以下の画像を使用してください' }, { status: 400 })
  }

  try {
    const arrayBuffer = await file.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp'

    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          { type: 'text', text: 'この業者請求書画像から情報を抽出してください。JSONのみ返してください。' }
        ]
      }]
    })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in AI response')

    const parsed = JSON.parse(jsonMatch[0]) as ExtractedInvoice

    return NextResponse.json(parsed)
  } catch (err) {
    console.error('[extract-vendor-invoice]', err)
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 500 })
  }
}
