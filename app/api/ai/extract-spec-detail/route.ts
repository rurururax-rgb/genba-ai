import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerClient } from '@/lib/supabase/server'

export const maxDuration = 60

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// 仕様書テンプレートに存在する部屋名（AI はこの名前で返す）
const ROOM_NAMES = [
  '玄関・ホール', 'トイレ', 'LDK', '廊下',
  '洗面室', '洋室①', '洋室②', '洋室③', '洋室④',
]

// テンプレートの部位名
const PART_NAMES = [
  '天井', '壁', '床', '廻り縁', '巾木', '建具', '照明器具', '住宅設備', '他',
]

const SYSTEM_PROMPT = `あなたはリフォーム会社の打ち合わせ記録から、仕様書（部屋×部位×仕様）を抽出する専門アシスタントです。

## 抽出ルール

### 対象の部屋名（必ずこの名前で返す）
${ROOM_NAMES.join(' / ')}

### 対象の部位名（必ずこの名前で返す）
${PART_NAMES.join(' / ')}

### 変換ルール
- 「リビング」「居間」→ LDK
- 「お風呂」「浴室」「ユニットバス」→ 住宅設備（LDK または洗面室の住宅設備欄に記入。なければ unmatched へ）
- 「1洋」「第1洋室」「洋1」→ 洋室①（番号で判断）
- 「玄関」「ホール」→ 玄関・ホール
- 「トイレ」「WC」→ トイレ
- 部屋名が曖昧な場合は unmatched に記載

### 抽出する情報
- spec（仕様）: 壁紙/フローリング/クッションフロア/シーリング/etc. 素材・工法名
- maker（メーカー・商品）: サンゲツ/LIXIL/Panasonic/etc. メーカー名や商品シリーズ
- product（品番・色）: 具体的な品番・品名・色番号。不明ならnull

### 重要ルール
- AIは整理するだけ。内容を補完・推測しない
- 明確に言及されていない部屋・部位は返さない
- テンプレートにない部屋の情報は unmatched に文字列で記載
- 必ず以下のJSON形式のみで返す。説明文は不要

## 出力JSON形式
{
  "rooms": [
    {
      "room_name": "部屋名（上記リストの名前で）",
      "parts": [
        {
          "part": "部位名（上記リストの名前で）",
          "spec": "仕様（壁紙/フローリング等。不明ならnull）",
          "maker": "メーカー・商品（不明ならnull）",
          "product": "品番・色（不明ならnull）"
        }
      ]
    }
  ],
  "unmatched": "テンプレートにない部屋・不明な情報をそのまま記載（なければnull）",
  "raw_warning": "読み取りで不確かな点があれば記載、なければnull"
}`

export type SpecPart = {
  part: string
  spec:    string | null
  maker:   string | null
  product: string | null
}

export type SpecRoom = {
  room_name: string
  parts: SpecPart[]
}

export type SpecDetailResult = {
  rooms:     SpecRoom[]
  unmatched: string | null
  raw_warning: string | null
}

export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as { text?: string }
  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }

  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `以下の打ち合わせ記録から仕様情報を抽出してください。JSONのみ返してください。\n\n---\n${body.text}\n---`,
      }]
    })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in AI response')

    const parsed = JSON.parse(jsonMatch[0]) as SpecDetailResult
    return NextResponse.json(parsed)
  } catch (err) {
    console.error('[extract-spec-detail]', err)
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 500 })
  }
}
