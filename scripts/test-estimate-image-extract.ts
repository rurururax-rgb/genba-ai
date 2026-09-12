/**
 * scripts/test-estimate-image-extract.ts
 *
 * 見積書画像からの項目抽出精度試験。
 * 本実装前に Claude Vision の読み取り精度を確認するためのスクリプト。
 *
 * 試験対象:
 *   Test 1: 中島降弥（Misoca）─ シンプル3列（品名・数量・単価・金額）
 *   Test 2: LIXIL/サンコー内訳明細書 ─ 多列（品名・数量・定価・掛率・単価・金額・備考）
 *
 * 抽出対象: name / quantity / unit / cost_price のみ
 * selling_price には一切書き込まない（仕入原価と販売価格の混同防止）
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { config } from 'dotenv'

config({ path: path.join(process.cwd(), '.env.local') })

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL  = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

type ExtractedItem = {
  name:       string          // 品名・名称
  quantity:   number | null   // 数量（読み取れなければ null）
  unit:       string | null   // 単位（式・台・㎡ など。読み取れなければ null）
  cost_price: number | null   // 仕入れ単価（selling_price ではない）
  note:       string | null   // 備考・型番など（オプション）
}

type ExtractResult = {
  supplier:      string           // 業者名（画像から読み取れた場合）
  document_type: string           // 書類種別（「御見積書」「内訳明細書」など）
  items:         ExtractedItem[]  // 抽出した明細行
  subtotal:      number | null    // 小計（検証用）
  raw_warning:   string | null    // 読み取り上の注意事項
}

// ──────────────────────────────────────────────────────────
// システムプロンプト
// ──────────────────────────────────────────────────────────

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
\`\`\`json
{
  "supplier": "業者名",
  "document_type": "書類種別",
  "items": [
    {
      "name": "品名・名称",
      "quantity": 数値またはnull,
      "unit": "単位またはnull",
      "cost_price": 数値またはnull,
      "note": "備考・型番など（なければnull）"
    }
  ],
  "subtotal": 小計の数値またはnull,
  "raw_warning": "読み取りで不確かな点があれば記載、なければnull"
}
\`\`\``

// ──────────────────────────────────────────────────────────
// 抽出関数
// ──────────────────────────────────────────────────────────

async function extractFromImage(
  imagePath: string,
  label: string,
): Promise<ExtractResult> {
  const imageData = await readFile(imagePath)
  const base64    = imageData.toString('base64')
  const mediaType = 'image/jpeg'

  console.log(`\n  → Claude API 呼び出し中... (${(imageData.length / 1024).toFixed(0)} KB)`)

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 2048,
    system:     SYSTEM_PROMPT,
    messages: [
      {
        role:    'user',
        content: [
          {
            type:  'image',
            source: {
              type:       'base64',
              media_type: mediaType,
              data:       base64,
            },
          },
          {
            type: 'text',
            text: `この見積書画像から明細項目を抽出してください。JSONのみ返してください。`,
          },
        ],
      },
    ],
  })

  const rawText = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  // JSON部分を抜き出す
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`JSON が見つかりませんでした。レスポンス: ${rawText.slice(0, 200)}`)
  }

  return JSON.parse(jsonMatch[0]) as ExtractResult
}

// ──────────────────────────────────────────────────────────
// 表示ヘルパー
// ──────────────────────────────────────────────────────────

function printResult(label: string, result: ExtractResult): void {
  console.log(`\n  業者: ${result.supplier}`)
  console.log(`  書類: ${result.document_type}`)
  if (result.raw_warning) {
    console.log(`  ⚠️  警告: ${result.raw_warning}`)
  }
  console.log(`\n  ${'名称'.padEnd(30)} ${'数量'.padStart(6)} ${'単位'.padEnd(4)} ${'cost_price'.padStart(10)} ${'備考'}`)
  console.log(`  ${'─'.repeat(75)}`)
  for (const item of result.items) {
    const name  = item.name.slice(0, 28).padEnd(30)
    const qty   = (item.quantity == null ? '─' : String(item.quantity)).padStart(6)
    const unit  = (item.unit ?? '─').padEnd(4)
    const price = (item.cost_price == null ? '─' : `¥${item.cost_price.toLocaleString()}`).padStart(10)
    const note  = item.note ?? ''
    console.log(`  ${name} ${qty} ${unit} ${price}  ${note}`)
  }
  console.log(`  ${'─'.repeat(75)}`)
  if (result.subtotal != null) {
    console.log(`  ${'小計'.padEnd(43)}¥${result.subtotal.toLocaleString()}`)
  }
}

// ──────────────────────────────────────────────────────────
// メイン
// ──────────────────────────────────────────────────────────

async function main() {
  const SAMPLES_DIR = path.join(process.cwd(), '下請けからの見積書')

  // ─── Test 1: 中島降弥（Misoca）─────────────────────────
  console.log('\n' + '═'.repeat(70))
  console.log('Test 1: 中島降弥（Misoca）─ シンプル3列形式')
  console.log('  ファイル: C4DED113...JPEG')
  console.log('  期待値:')
  console.log('    クロス施工（SPシリーズ） 1式 ¥45,000')
  console.log('    CF施工                  1式 ¥33,000')
  console.log('    ゴミ処理代              1式 ¥3,000')
  console.log('    小計 ¥81,000')
  console.log('═'.repeat(70))

  const result1 = await extractFromImage(
    path.join(SAMPLES_DIR, 'C4DED113-DCA1-469E-9673-7B48C1BD69E2.JPEG'),
    'Test 1',
  )
  printResult('Test 1', result1)

  // ─── 精度評価 Test 1 ──────────────────────────────────
  const expected1 = [
    { name: 'クロス施工', cost_price: 45000 },
    { name: 'CF施工',     cost_price: 33000 },
    { name: 'ゴミ処理代', cost_price: 3000  },
  ]
  let ok1 = result1.items.length === 3
  for (let i = 0; i < Math.min(result1.items.length, expected1.length); i++) {
    if (result1.items[i].cost_price !== expected1[i].cost_price) ok1 = false
  }
  console.log(`\n  精度判定: ${ok1 ? '✅ 正解（3件・単価一致）' : '⚠️  要確認'}`)
  if (!ok1) {
    console.log('  期待:', expected1.map(e => `${e.name}=¥${e.cost_price}`).join(', '))
    console.log('  実際:', result1.items.map(i => `${i.name}=¥${i.cost_price}`).join(', '))
  }

  // ─── Test 2: LIXIL/サンコー（多列形式）────────────────
  console.log('\n\n' + '═'.repeat(70))
  console.log('Test 2: LIXIL/サンコー ─ 多列形式（定価・掛率・単価・金額）')
  console.log('  ファイル: 01227070...JPEG')
  console.log('  期待値（単価列を cost_price に使用）:')
  console.log('    AX 商品代   1式 単価¥224,710  （定価¥1,070,040 × 21%）')
  console.log('    施工費      1式 単価¥115,000')
  console.log('    ピアラ商品代 1式 単価¥77,700  （定価¥259,000 × 30%）')
  console.log('    ※ 現調・管理費/現場配送費は金額0なので除外')
  console.log('    小計 ¥339,710 ＋ ¥77,700 = ¥417,410')
  console.log('═'.repeat(70))

  const result2 = await extractFromImage(
    path.join(SAMPLES_DIR, '01227070-999D-46AD-8669-A1AA5BC3B7F2.JPEG'),
    'Test 2',
  )
  printResult('Test 2', result2)

  // ─── 精度評価 Test 2 ──────────────────────────────────
  // 重要確認点：単価列（224,710 / 115,000 / 77,700）を選択できているか
  const prices2 = result2.items.map(i => i.cost_price)
  const hasCorrectAX = prices2.includes(224710)
  const hasCorrectKoji = prices2.includes(115000)
  const hasCorrectPiara = prices2.includes(77700)
  // 誤った値（定価・金額列の混同）チェック
  const hasWrongListPrice = prices2.some(p => p && (p > 500000))  // 定価 1,070,040 や 259,000 などを誤抽出してないか
  const hasWrongSubtotal  = prices2.some(p => p === 339710 || p === 417410)

  console.log('\n  精度判定（多列形式の列選択チェック）:')
  console.log(`    [${hasCorrectAX    ? 'OK' : 'NG'}] AX商品代の単価 ¥224,710 を正しく選択`)
  console.log(`    [${hasCorrectKoji  ? 'OK' : 'NG'}] 施工費の単価 ¥115,000 を正しく選択`)
  console.log(`    [${hasCorrectPiara ? 'OK' : 'NG'}] ピアラ商品代の単価 ¥77,700 を正しく選択`)
  console.log(`    [${!hasWrongListPrice ? 'OK' : 'NG'}] 定価列（100万超）を誤抽出していない`)
  console.log(`    [${!hasWrongSubtotal  ? 'OK' : 'NG'}] 小計行を item として抽出していない`)

  // ─── 総合評価 ─────────────────────────────────────────
  const allOk = ok1 && hasCorrectAX && hasCorrectKoji && hasCorrectPiara && !hasWrongListPrice && !hasWrongSubtotal
  console.log('\n\n' + '═'.repeat(70))
  console.log(`総合評価: ${allOk ? '✅ 本実装に進める精度' : '⚠️  要プロンプト調整'}`)
  console.log('═'.repeat(70))
}

main().catch(e => { console.error(e); process.exit(1) })
