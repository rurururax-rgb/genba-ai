import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerClient } from '@/lib/supabase/server'
import { normalizeEstimateExtraction, type EstimateOcrFile } from '@/lib/estimate/ocr-extraction'

// 明細の多い見積書は AI の出力に時間がかかる（8,000 トークン前後で 2〜3 分）。
// 画面は画像を 1 枚ずつ送るので、1 リクエストあたり AI 呼び出しは通常 1 回
export const maxDuration = 300

// AI 呼び出し 1 回の上限。maxDuration より短くして、関数ごと打ち切られる前に日本語の案内を返す
const AI_TIMEOUT_MS = 240_000

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: AI_TIMEOUT_MS, maxRetries: 1 })

const SYSTEM_PROMPT = `あなたはリフォーム会社が業者（仕入れ先）から受け取った見積書の画像から、明細を書き写すアシスタントです。

## 最重要ルール
- 抽出するのは「仕入れ原価（業者から自社への請求金額）」です。顧客向けの販売価格は出力しません（selling_price という項目は出力しない）
- 金額は**画像に印字されている数字だけ**を書き写す。計算・推測で作らない
  - 単価欄が空なら cost_price は null（金額 ÷ 数量 で単価を作らない）
  - 定価 × 掛率 を自分で計算して単価にしない
  - 読めない・どの欄か判断できない数字は null
- 必ず以下の JSON 形式のみで回答してください。説明文は不要です

## 列の読み取り方針（列ごとに別の項目へ書き写す）
- list_price: 「定価」「標準価格」「メーカー希望価格」の列
- rate: 「掛率」「掛け」「%」の列（印字が 60% や 6掛 なら 0.6、0.6 なら 0.6）
- cost_price: 「単価」「仕切単価」「納入単価」「見積単価」の列（掛率を掛けた後の 1 単位あたりの金額）
- amount: 「金額」の列（その行の合計。数量 × 単価）
- 列が無い項目は null

## 行の扱い
- 「小計」「合計」「消費税」「総合計」などの集計行は items に含めない
- 「値引」「出精値引」「端数調整」などの値引き・調整の行は items に含めず、adjustments に書き写す（amount は印字された金額の絶対値。▲やマイナスは付けない）
- 金額が「0」「含む」「別途」「該当なし」の行は items に含めず、excluded_rows に品名と理由（"別途" / "含む" / "0円" / "その他"）を書く
- 数字はカンマなしの数値で返す
- vendor_name は、その行の仕入先が書類全体の supplier と違うときだけ書く（同じなら null）

## 出力 JSON 形式（これ以外を返してはいけない）
{
  "supplier": "書類の発行元・差出人として記載されている業者名（社名・屋号。読み取れなければ空文字）",
  "document_type": "書類種別（御見積書・内訳明細書など）",
  "items": [
    {
      "name": "品名・名称（型番を含む）",
      "quantity": 数値またはnull,
      "unit": "単位またはnull",
      "list_price": 数値またはnull,
      "rate": 数値またはnull,
      "cost_price": 数値またはnull,
      "amount": 数値またはnull,
      "vendor_name": null,
      "note": "備考（なければnull）"
    }
  ],
  "items_total": 原本に印字されている明細行の数（数えられなければnull）,
  "subtotal": 印字された小計（税抜）の数値またはnull,
  "adjustments": [{ "label": "出精値引など印字どおり", "amount": 数値またはnull }],
  "excluded_rows": [{ "name": "品名", "reason": "別途" }],
  "prices_include_tax": 単価・金額が税込と明記されていれば true、それ以外は false,
  "warnings": ["かすれ・切れ・読み取りに自信のない点（なければ空配列）"]
}`

// 明細 80〜100 行程度まで収まる上限。途中で切れた応答（stop_reason = max_tokens）は正常扱いしない
const MAX_OUTPUT_TOKENS = 8192

// 画面は 1 枚ずつ・3.5MB 以下に縮小して送る（lib/estimate/ocr-image.ts）。
// Vercel の関数は 4.5MB を超えるリクエストを受け取れないので、それより小さい値で明示的に断る
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
const MAX_FILES = 10

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

type Failure = { fileName: string; status: number; code: string; error: string }

const fail = (status: number, code: string, error: string) => NextResponse.json({ error, code }, { status })

// SDK の APIConnectionTimeoutError（メッセージ 'Request timed out.'）。テストの偽 SDK でも判定できるよう名前とメッセージで見る
const isTimeout = (err: unknown) =>
  err instanceof Error && (err.constructor?.name === 'APIConnectionTimeoutError' || /timed out/i.test(err.message))

class ExtractError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

async function extractOne(file: File): Promise<EstimateOcrFile> {
  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
  const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp'

  let response: Anthropic.Message
  try {
    response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'この見積書画像から明細項目を抽出してください。JSONのみ返してください。' },
        ],
      }],
    })
  } catch (err) {
    if (isTimeout(err)) {
      throw new ExtractError(504, 'ai_timeout', '読み取りに時間がかかりすぎました。見積書を 1 ページずつ、明細の部分が大きく写るように撮影してもう一度お試しください')
    }
    throw err
  }

  // 出力上限で途中終了した応答は、JSON として読めても明細が欠けている。正常扱いしない
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractError(502, 'ai_truncated', '明細が多く、読み取りが途中で終わりました。見積書を上下に分けて撮影し、1 枚ずつ読み取ってください')
  }
  if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') {
    throw new ExtractError(502, 'ai_incomplete', '読み取りを完了できませんでした。もう一度お試しください')
  }

  const rawText = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  let parsed: unknown = null
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new ExtractError(502, 'ai_invalid_response', '読み取り結果を解釈できませんでした。もう一度お試しください')
  }
  return normalizeEstimateExtraction(parsed, file.name)
}

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

  const files = formData.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f)
  if (!files.length) return fail(400, 'no_file', '画像を選んでください')
  if (files.length > MAX_FILES) return fail(400, 'too_many_files', `画像は ${MAX_FILES} 枚までです`)
  if (files.some(f => !ALLOWED_TYPES.includes(f.type))) {
    return fail(400, 'unsupported_type', 'JPEG / PNG / WebP の画像のみ対応しています')
  }
  if (files.reduce((s, f) => s + f.size, 0) > MAX_UPLOAD_BYTES) {
    return fail(413, 'too_large', '画像が大きすぎます（合計 4MB まで）。画面からもう一度選び直してください')
  }

  // 1 枚の失敗で他の画像の結果を捨てない（画像ごとに成功・失敗を返す）
  const settled = await Promise.allSettled(files.map(extractOne))
  const results: EstimateOcrFile[] = []
  const failures: Failure[] = []
  settled.forEach((s, i) => {
    const fileName = files[i].name
    if (s.status === 'fulfilled') return void results.push(s.value)
    const e = s.reason
    if (e instanceof ExtractError) {
      console.error('[extract-estimate]', e.code)
      failures.push({ fileName, status: e.status, code: e.code, error: e.message })
    } else {
      console.error('[extract-estimate]', e instanceof Error ? e.message : 'unknown')
      failures.push({ fileName, status: 500, code: 'ai_failed', error: '読み取りに失敗しました。時間をおいてもう一度お試しください' })
    }
  })

  if (results.length === 0) {
    const f = failures[0]
    return NextResponse.json({ error: f.error, code: f.code, failures }, { status: f.status })
  }
  return NextResponse.json({ files: results, items: results.flatMap(r => r.items), failures })
}
