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
- subtotal_excl_tax: 税抜の合計として**印字されている数字**（「小計」「税抜合計」「課税対象額の合計」など）。
  - 値引き・端数値引きがあり、値引き後の税抜合計が**印字されていなければ**、計算せずに印字どおりの小計を書く（値引きは adjustments に書く）
  - 税抜の合計が印字されていなければ null
- tax_amount: 消費税額の合計（「消費税」「うち消費税」「内消費税」など）。なければ null
- total_incl_tax: 税込の合計（「合計」「税込合計」「税込計」など）。源泉徴収が差し引かれている場合は、差し引く**前**の税込合計（「差引請求額」ではない）。なければ null
- tax_treatment: 次のどれか
  - "exclusive": 税抜金額と消費税が別に書かれている（外税）
  - "inclusive": 税込金額だけが書かれ、消費税は内数として書かれている（内税・「うち消費税」）
  - "non_taxable": 非課税・不課税・免税と明記されている
  - "unknown": 判断できない
- tax_breakdown: 税率ごとの対象額・税額が、合計欄とは別の行・表（例:「10%対象 ¥50,000 消費税 ¥5,000」「8%対象 …」）として印字されている場合だけ、その行を書き写す [{ "rate": 10, "taxable_amount": 対象額, "tax_amount": 消費税 }]。
  - 合計欄（「小計」「消費税（10%）」「うち消費税 10%」「合計」など）から内訳を組み立てない。合計欄しかなければ空配列
  - 税率別の行に対象額が印字されていなければ taxable_amount は null（小計などから補わない）
  - 税率が1つでも、税率別の行・表として印字されていればその1行を書き写す
- adjustments: 小計と合計のあいだ、または合計の後に印字された増減の行（値引き・出精値引き・端数値引き・源泉所得税・調整・相殺・前受金など）を書き写す [{ "kind": 種類, "amount": 金額 }]
  - kind は "discount"（値引き）・"withholding"（源泉所得税・源泉徴収）・"other"（それ以外）のどれか
  - amount は印字された金額の絶対値（マイナス記号・▲は付けない）。読めなければ null。なければ空配列
  - 明細の中の値引き行（品名が「値引き」など）も書く
- items: 明細行。品名と金額（印字どおり）のみ。**最初の 20 行まで**（それより多くても書かない）。なければ空配列
- items_total: 印字されている明細行の数（20 行を超えても全体の行数）。数えられなければ null
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
  "adjustments": [],
  "items": [{ "name": "品名", "amount": null }],
  "items_total": null,
  "warnings": []
}`

// 明細を 20 行に絞っても、項目名・内訳・注意書きを含めて十分に収まる上限。
// 途中で切れた応答（stop_reason = max_tokens）は不完全なので、正常な結果として返さない
const MAX_OUTPUT_TOKENS = 4096

// 画面は送信前に 3.5MB 以下へ縮小する（lib/cost-ledger/invoice-image.ts）。
// Vercel の関数は 4.5MB を超えるリクエストを受け取れないので、それより小さい値で明示的に断る
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

const fail = (status: number, code: string, error: string) => NextResponse.json({ error, code }, { status })

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return fail(401, 'unauthorized', 'ログインし直してください')

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return fail(400, 'invalid_form', '画像を受け取れませんでした。もう一度お試しください')
  }

  const file = formData.get('file') as File | null
  if (!file) return fail(400, 'no_file', '画像を選んでください')
  if (!ALLOWED_TYPES.includes(file.type)) {
    return fail(400, 'unsupported_type', 'JPEG / PNG / WebP の画像のみ対応しています')
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(413, 'too_large', '画像が大きすぎます（4MB まで）。画面からもう一度選び直してください')
  }

  try {
    const arrayBuffer = await file.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp'

    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: MAX_OUTPUT_TOKENS,
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

    // 出力上限で途中終了した応答は、JSON として読めても項目が欠けている可能性がある。正常扱いしない
    if (response.stop_reason === 'max_tokens') {
      console.error('[extract-vendor-invoice] truncated response')
      return fail(502, 'ai_truncated', '請求書の内容が多く、読み取りが途中で終わりました。金額の欄が写るように撮り直すか、手入力で登録してください')
    }
    if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') {
      console.error('[extract-vendor-invoice] unexpected stop_reason:', response.stop_reason)
      return fail(502, 'ai_incomplete', '読み取りを完了できませんでした。もう一度お試しください')
    }

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    let parsed: unknown
    try {
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object') {
      console.error('[extract-vendor-invoice] invalid JSON in AI response')
      return fail(502, 'ai_invalid_response', '読み取り結果を解釈できませんでした。もう一度お試しください')
    }

    const extracted = normalizeExtraction(parsed)

    // 画像の SHA-256 はサーバーが元のバイト列から計算する（AI には作らせない）。
    // 登録時に同じ案件への同じ画像の二重登録を DB の一意制約で止めるために使う。
    // クライアント経由で戻ってくる値なので、改ざんされない保証はない（誤操作・再送の防止が目的）
    const document_sha256 = createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex')

    const body: ExtractedVendorInvoice = { ...extracted, document_sha256 }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[extract-vendor-invoice]', err instanceof Error ? err.message : 'unknown')
    return fail(500, 'ai_failed', '読み取りに失敗しました。時間をおいてもう一度お試しください')
  }
}
