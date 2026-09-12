import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerClient } from '@/lib/supabase/server'

export const maxDuration = 120

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `あなたはリフォーム会社の見積書画像から明細項目を抽出する専門アシスタントです。

## 最重要ルール
- 抽出するのは「仕入れ原価（業者からラグズ建築への請求金額）」です
- 「顧客向け販売価格」は絶対に出力しません
- selling_price という項目は出力しません
- 必ず以下のJSON形式のみで回答してください。説明文は不要です

## 列の読み取り方針
- 列が「定価 / 掛率 / 単価 / 金額」の4列構成の場合: **単価列の値**を cost_price とする
  （定価×掛率=単価 の関係。cost_price = 単価列の数値）
- 列が「単価 / 金額」の2〜3列構成の場合: 単価列の値を cost_price とする
- 「小計」「合計」「消費税」「値引」などの集計行は items に含めない
- 金額が「0」や「含む」「該当なし」の行も除外する
- 数字はカンマなしの整数または小数で返す

## 出力JSON形式（これ以外を返してはいけない）
{
  "supplier": "書類の発行元・差出人として記載されている業者名（社名・屋号。読み取れなければ空文字）",
  "document_type": "書類種別（御見積書・内訳明細書など）",
  "items": [
    {
      "name": "品名・名称",
      "quantity": 数値またはnull,
      "unit": "単位またはnull",
      "cost_price": 数値またはnull,
      "vendor_name": "この行の仕入先業者名（書類全体のsupplierと同じでよい。不明ならnull）",
      "note": "備考・型番など（なければnull）"
    }
  ],
  "subtotal": 小計の数値またはnull,
  "raw_warning": "読み取りで不確かな点があれば記載、なければnull"
}`

type ExtractedItem = {
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  vendor_name: string | null
  note: string | null
}

type FileResult = {
  fileName: string
  supplier: string
  document_type: string
  items: ExtractedItem[]
  subtotal: number | null
  raw_warning: string | null
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

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

  const files = formData.getAll('files') as File[]
  if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 })
  if (files.length > 10) return NextResponse.json({ error: 'Max 10 files per request' }, { status: 400 })

  const invalidType = files.find(f => !ALLOWED_TYPES.includes(f.type))
  if (invalidType) {
    return NextResponse.json(
      { error: `Unsupported file type: ${invalidType.type}. JPEG/PNG/WebP only.` },
      { status: 400 }
    )
  }

  try {
    // 全ファイルを並列で処理（直列比で約N倍の速度向上）
    const fileResults: FileResult[] = await Promise.all(
      files.map(async (file): Promise<FileResult> => {
        const arrayBuffer = await file.arrayBuffer()
        const base64 = Buffer.from(arrayBuffer).toString('base64')
        const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

        const response = await client.messages.create({
          model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 }
              },
              { type: 'text', text: 'この見積書画像から明細項目を抽出してください。JSONのみ返してください。' }
            ]
          }]
        })

        const rawText = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('')

        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error(`No JSON in response for ${file.name}`)

        const parsed = JSON.parse(jsonMatch[0]) as Omit<FileResult, 'fileName'>
        return { fileName: file.name, ...parsed }
      })
    )

    const allItems = fileResults.flatMap(r => r.items)

    return NextResponse.json({ files: fileResults, items: allItems })
  } catch (err) {
    console.error('[extract-estimate]', err)
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 500 })
  }
}
