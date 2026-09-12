import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerClient } from '@/lib/supabase/server'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `あなたはリフォーム会社の現場打ち合わせ記録・仕様書を整理する専門アシスタントです。

## 役割
渡された文書（打ち合わせメモ・仕様書・ToDoリスト・議事録など）を読み取り、
構造化されたJSON形式にまとめます。

## 最重要ルール
- AIはあくまで「整理係」です。内容の正誤判断・確定は行いません
- 金額・概算・予算感に関する記述は必ず budget_notes に入れ、他のフィールドには含めない
- 会話の中の曖昧な表現（「だいたい〜」「〜くらい」）も忠実に転記する
- 存在しない情報を補完・推測しない
- 必ず以下のJSON形式のみで回答してください

## 出力JSON形式
{
  "overview": "工事の全体概要を1〜3文でまとめた文章（なければ空文字）",
  "requirements": [
    "施主の要望・仕様指定を箇条書きで（1項目1文字列）"
  ],
  "cautions": [
    "注意事項・確認が必要な事項を箇条書きで（1項目1文字列）"
  ],
  "budget_notes": "概算・予算感に関する記述をそのまま転記（なければnull）",
  "todos": [
    "対応すべきToDoを箇条書きで（1項目1文字列。なければ空配列）"
  ],
  "raw_warning": "読み取りで不確かな点があれば記載、なければnull"
}`

type SpecResult = {
  overview: string
  requirements: string[]
  cautions: string[]
  budget_notes: string | null
  todos: string[]
  raw_warning: string | null
}

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
  const plainText = formData.get('text') as string | null

  if (!files.length && !plainText?.trim()) {
    return NextResponse.json({ error: 'Provide files or text' }, { status: 400 })
  }

  try {
    const contentBlocks: Anthropic.MessageParam['content'] = []

    // テキスト入力
    if (plainText?.trim()) {
      contentBlocks.push({ type: 'text', text: `【テキスト内容】\n${plainText.trim()}` })
    }

    // ファイル入力
    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')

      if (file.type === 'application/pdf') {
        contentBlocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        } as Anthropic.DocumentBlockParam)
      } else if (file.type.startsWith('image/')) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
            data: base64
          }
        })
      }
    }

    contentBlocks.push({
      type: 'text',
      text: 'この文書の内容を整理してください。JSONのみ返してください。'
    })

    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }]
    })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const result = JSON.parse(jsonMatch[0]) as SpecResult

    // 金額表記が含まれる場合は免責注記を追加
    if (result.budget_notes) {
      result.budget_notes =
        result.budget_notes +
        '\n※打ち合わせ時の概算。正式見積もり前の参考値'
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[extract-spec]', err)
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 500 })
  }
}
