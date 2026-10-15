import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { getServerClient } from '@/lib/supabase/server'
import { normalizeExtraction, type ExtractedVendorInvoice } from '@/lib/cost-ledger/ocr-extraction'

export const maxDuration = 60

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `あなたはリフォーム会社が業者（仕入れ先）から受け取った請求書画像から、印字されている情報を書き写すアシスタントです。

## 最重要ルール
- 金額は**画像に印字されている数字だけ**を書き写す。計算・推測で作らない（税込を 1.1 で割る、合計を足し算する、などは禁止）。
- 印字が無い・読めない・どの欄か判断できない金額は null にする。
- 不確かな点は warnings に短く書く（例:「税抜・税込の区別が書かれていない」「金額の一部がかすれている」）。

## 抽出対象
- vendor_name: 請求書を発行した業者名（社名・屋号）。読めなければ空文字
- invoice_number: 請求書番号・請求No（印字どおり）。読めなければ null
- invoice_date: 請求日・発行日（YYYY-MM-DD）。読めなければ null
- payment_due_date: 支払期日・支払期限・お支払い予定日（YYYY-MM-DD）。読めなければ null
- subtotal_excl_tax: 税抜の合計（「小計」「税抜合計」「課税対象額の合計」など）。値引き・端数値引きが印字されていれば**値引き後**の税抜合計。なければ null
- tax_amount: 消費税額の合計（「消費税」「うち消費税」「内消費税」など）。なければ null
- total_incl_tax: 税込の合計（「合計」「ご請求金額」「税込合計」など）。なければ null
- tax_treatment: 次のどれか
  - "exclusive": 税抜金額と消費税が別に書かれている（外税）
  - "inclusive": 税込金額だけが書かれ、消費税は内数として書かれている（内税・「うち消費税」）
  - "non_taxable": 非課税・不課税・免税と明記されている
  - "unknown": 判断できない
- tax_breakdown: 税率ごとの対象額・税額が、合計欄とは別の行・表（例:「10%対象 ¥50,000 消費税 ¥5,000」「8%対象 …」）として印字されている場合だけ、その行を書き写す [{ "rate": 10, "taxable_amount": 対象額, "tax_amount": 消費税 }]。
  - 合計欄（「小計」「消費税（10%）」「うち消費税 10%」「合計」など）から内訳を組み立てない。合計欄しかなければ空配列
  - 税率別の行に対象額が印字されていなければ taxable_amount は null（小計などから補わない）
  - 税率が1つでも、税率別の行・表として印字されていればその1行を書き写す
- items: 明細行。品名と金額（印字どおり）のみ。なければ空配列
- warnings: 不確かな点の配列。なければ空配列

## 必ず JSON のみを返す（説明文は不要）

{
  "vendor_name": "",
  "invoice_number": null,
  "invoice_date": null,
  "payment_due_date": null,
  "subtotal_excl_tax": null,
  "tax_amount": null,
  "total_incl_tax": null,
  "tax_treatment": "unknown",
  "tax_breakdown": [],
  "items": [{ "name": "品名", "amount": null }],
  "warnings": []
}`

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

    const extracted = normalizeExtraction(JSON.parse(jsonMatch[0]))

    // 画像の SHA-256 はサーバーが元のバイト列から計算する（AI には作らせない）。
    // 登録時に同じ案件への同じ画像の二重登録を DB の一意制約で止めるために使う。
    // クライアント経由で戻ってくる値なので、改ざんされない保証はない（誤操作・再送の防止が目的）
    const document_sha256 = createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex')

    const body: ExtractedVendorInvoice = { ...extracted, document_sha256 }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[extract-vendor-invoice]', err)
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 500 })
  }
}
