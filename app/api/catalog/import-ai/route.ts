/**
 * POST /api/catalog/import-ai
 *
 * 見積書（Excel / PDF）をアップロードし、Claude API で品目を抽出して返す。
 * DB への書き込みはしない（プレビュー → ユーザー確定後に /api/catalog/bulk-upsert へ）
 *
 * セキュリティ: getServerClient()（RLS有効）。admin.ts 不使用。
 * ファイルはメモリ内で処理し、Storage には保存しない。
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { Workbook } from 'exceljs'
import { getServerClient } from '@/lib/supabase/server'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── 型 ───────────────────────────────────────────────────────────────

export type ExtractedItem = {
  name: string
  unit: string
  selling_price: number | null
  cost_price: number | null
  category: string
}

// ── Excel → テキスト変換 ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function excelToText(buffer: any): Promise<string> {
  const wb = new Workbook()
  await wb.xlsx.load(buffer)

  const lines: string[] = []

  wb.eachSheet(sheet => {
    lines.push(`\n【シート: ${sheet.name}】`)
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = (row.values as (string | number | null | undefined)[])
        .slice(1) // exceljs の row.values は 1-indexed で index 0 が null
        .map(v => {
          if (v == null) return ''
          if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result ?? '')
          return String(v).trim()
        })

      const line = cells.join('\t')
      if (line.replace(/\t/g, '').trim()) lines.push(line)
    })
  })

  const text = lines.join('\n')
  // Claude の入力サイズ制限を考慮して先頭 40,000 文字に制限
  return text.slice(0, 40000)
}

// ── AI 抽出 ─────────────────────────────────────────────────────────

async function extractItemsFromText(text: string): Promise<ExtractedItem[]> {
  const prompt = `あなたは建設会社の見積書データから品目情報を抽出するアシスタントです。

以下は見積書（Excel または PDF）から取り出したデータです。
見積の品目行を特定して、構造化データとして抽出してください。

【抽出ルール】
- 合計・小計・消費税・値引き・諸経費・ページ番号・会社名・日付などの行は除外する
- 品名が空またはほぼ空の行は除外する
- selling_price: 売価・単価・見積金額。数値（円）。不明なら null
- cost_price: 原価・仕入れ価格。数値（円）。見当たらなければ null（無理に推測しない）
- unit: 単位（式・m²・m・個・本・枚・箇所・ヶ所・缶・kg・L 等）。不明は "式"
- category: 工事種別から推定。以下のいずれかを選ぶ：
  「内装工事」「大工工事」「電気工事」「水道工事」「設備工事」「外壁工事」「屋根工事」「左官工事」「塗装工事」「建具工事」「基礎工事」「解体工事」「諸経費」「その他」
- 同じ品名が複数行ある場合は1つにまとめ、売価は最初に出てきた値を使う

必ず以下のJSON形式のみで返してください（説明文は不要）：
{
  "items": [
    { "name": "品名", "unit": "単位", "selling_price": 数値またはnull, "cost_price": 数値またはnull, "category": "カテゴリ" }
  ]
}

--- データ開始 ---
${text}
--- データ終了 ---`

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    messages:   [{ role: 'user', content: prompt }],
  })

  const raw = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  // JSON ブロックを抽出（コードフェンスが付く場合も対応）
  const match = raw.match(/\{[\s\S]*"items"[\s\S]*\}/)
  if (!match) throw new Error('AIが有効なJSONを返しませんでした')

  const parsed = JSON.parse(match[0]) as { items: ExtractedItem[] }
  if (!Array.isArray(parsed.items)) throw new Error('items フィールドが配列ではありません')

  return parsed.items.filter(item => item.name && item.name.trim().length > 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractItemsFromPdf(buffer: any): Promise<ExtractedItem[]> {
  const base64 = buffer.toString('base64')

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type:   'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        {
          type: 'text',
          text: `この建設会社の見積書PDFから品目情報を抽出してください。

【抽出ルール】
- 合計・小計・消費税・値引き・諸経費・ページ番号・会社名・日付などの行は除外する
- 品名が空またはほぼ空の行は除外する
- selling_price: 売価・単価・見積金額。数値（円）。不明なら null
- cost_price: 原価・仕入れ価格。数値（円）。見当たらなければ null（無理に推測しない）
- unit: 単位（式・m²・m・個・本・枚・箇所・ヶ所・缶・kg・L 等）。不明は "式"
- category: 工事種別から推定。「内装工事」「大工工事」「電気工事」「水道工事」「設備工事」「外壁工事」「屋根工事」「左官工事」「塗装工事」「建具工事」「基礎工事」「解体工事」「諸経費」「その他」のいずれか
- 同じ品名が複数あれば1つにまとめる

必ず以下のJSON形式のみで返してください：
{
  "items": [
    { "name": "品名", "unit": "単位", "selling_price": 数値またはnull, "cost_price": 数値またはnull, "category": "カテゴリ" }
  ]
}`,
        },
      ],
    }],
  })

  const raw = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  const match = raw.match(/\{[\s\S]*"items"[\s\S]*\}/)
  if (!match) throw new Error('AIが有効なJSONを返しませんでした')

  const parsed = JSON.parse(match[0]) as { items: ExtractedItem[] }
  if (!Array.isArray(parsed.items)) throw new Error('items フィールドが配列ではありません')

  return parsed.items.filter(item => item.name && item.name.trim().length > 0)
}

// ── ハンドラー ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 認証チェック
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  // ファイル受信
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'ファイルの読み込みに失敗しました' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'file フィールドが必要です' }, { status: 400 })

  const MAX_BYTES = 20 * 1024 * 1024 // 20MB
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `ファイルサイズは20MB以下にしてください（現在: ${(file.size / 1024 / 1024).toFixed(1)}MB）` }, { status: 400 })
  }

  const name = file.name.toLowerCase()
  const rawBuf = await file.arrayBuffer()
  const buffer = Buffer.from(rawBuf)

  try {
    let items: ExtractedItem[]

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const text = await excelToText(buffer)
      if (!text.trim()) {
        return NextResponse.json({ error: 'Excelファイルからデータを読み取れませんでした' }, { status: 422 })
      }
      items = await extractItemsFromText(text)
    } else if (name.endsWith('.pdf')) {
      items = await extractItemsFromPdf(buffer)
    } else {
      return NextResponse.json({ error: '.xlsx / .xls / .pdf ファイルのみ対応しています' }, { status: 400 })
    }

    if (items.length === 0) {
      return NextResponse.json({ error: '品目を抽出できませんでした。別のファイルをお試しください' }, { status: 422 })
    }

    return NextResponse.json({ items })
  } catch (err) {
    console.error('[catalog/import-ai]', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `抽出に失敗しました: ${msg}` }, { status: 500 })
  }
}
