/**
 * fill-template.ts 動作確認スクリプト
 *
 * 実行:
 *   node_modules/.bin/tsx scripts/test-fill-template.ts
 *
 * 出力:
 *   /tmp/test_output.xlsx  （Excel で開いて目視確認）
 */

import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import JSZip from 'jszip'
import { fillTemplate, type FillItem } from '../lib/excel/fill-template.js'

const __dirname    = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, '..', '株式会社ラグズ建築_見積テンプレート_修正版_最終.xlsx')

const OUTPUT_PATH = '/tmp/test_output.xlsx'

// ── テストデータ ──────────────────────────────────────────
const TEST_ITEMS: FillItem[] = [
  // 仮設工事 (ブロック1, unit=式)
  { name: '足場施工', quantity: 1, unit: '式', selling_price: 320000, amount: 320000, category: '仮設工事', memo: null },
  { name: '養生費', quantity: 1, unit: '式', selling_price: 45000, amount: 45000, category: '仮設工事', memo: null },
  // 給排水設備工事 (ブロック3, unit=式 + 音声メモ)
  {
    name: '給水・給湯・排水管移設及び一部新設',
    quantity: 1, unit: '式', selling_price: 428000, amount: 428000,
    category: '給排水設備工事',
    memo: '（現場メモ: 12m / TOTO VP管）',  // 式のため量はmemoへ
  },
  // 設備機器 (ブロック8, unit=式)
  { name: 'システムバス', quantity: 1, unit: '式', selling_price: 980000, amount: 980000, category: '設備機器', memo: '（現場メモ: LIXIL アライズ）' },
  { name: '洗面化粧台',   quantity: 1, unit: '式', selling_price: 185000, amount: 185000, category: '設備機器', memo: null },
  // 内装工事 (ブロック7, unit=㎡)
  { name: '天井・壁クロス張り', quantity: 50, unit: '㎡', selling_price: 1800, amount: 90000, category: '内装工事', memo: null },
  { name: '床塩ビタイル張り（フロアタイル）', quantity: 25, unit: '㎡', selling_price: 3500, amount: 87500, category: '内装工事', memo: null },
]

// ── 検証関数 ───────────────────────────────────────────────

async function verify(outputBuf: Buffer, templatePath: string) {
  const [outZip, tplZip] = await Promise.all([
    JSZip.loadAsync(outputBuf),
    JSZip.loadAsync(await readFile(templatePath)),
  ])

  let ok = true
  const fail = (msg: string) => { console.error(`  ❌ ${msg}`); ok = false }
  const pass = (msg: string) => console.log(`  ✅ ${msg}`)

  // 1. media ファイル数が同じか
  const tplMedia = Object.keys(tplZip.files).filter(f => f.startsWith('xl/media/'))
  const outMedia = Object.keys(outZip.files).filter(f => f.startsWith('xl/media/'))
  if (tplMedia.length === outMedia.length) {
    pass(`xl/media/ ファイル数: ${tplMedia.length} 件（変化なし）`)
  } else {
    fail(`xl/media/ ファイル数: template=${tplMedia.length} / output=${outMedia.length}`)
  }

  // 2. xl/metadata が存在するか
  const tplMeta = tplZip.file('xl/metadata')
  const outMeta = outZip.file('xl/metadata')
  if (tplMeta && outMeta) {
    const [tBuf, oBuf] = await Promise.all([
      tplMeta.async('uint8array'),
      outMeta.async('uint8array'),
    ])
    if (Buffer.from(tBuf).equals(Buffer.from(oBuf))) {
      pass('xl/metadata: 変化なし')
    } else {
      fail('xl/metadata: 内容が変化しています')
    }
  } else if (!tplMeta && !outMeta) {
    pass('xl/metadata: 両方なし（問題なし）')
  } else {
    fail(`xl/metadata: template=${tplMeta ? 'あり' : 'なし'} / output=${outMeta ? 'あり' : 'なし'}`)
  }

  // 3. 他シート（sheet2.xml 以降）が変化していないか
  const sheetFiles = Object.keys(tplZip.files).filter(
    f => f.match(/xl\/worksheets\/sheet\d+\.xml/) && f !== 'xl/worksheets/sheet1.xml'
  )
  let sheetOk = true
  for (const sf of sheetFiles) {
    const tEntry = tplZip.file(sf)
    const oEntry = outZip.file(sf)
    if (!tEntry || !oEntry) { fail(`${sf}: 出力に存在しない`); sheetOk = false; continue }
    const [tStr, oStr] = await Promise.all([tEntry.async('string'), oEntry.async('string')])
    if (tStr !== oStr) { fail(`${sf}: 内容が変化しています`); sheetOk = false }
  }
  if (sheetOk) pass(`他シート(${sheetFiles.length}件): すべて変化なし`)

  // 4. drawings が変化していないか
  const drawingFiles = Object.keys(tplZip.files).filter(f => f.startsWith('xl/drawings/'))
  let drawOk = true
  for (const df of drawingFiles) {
    const tEntry = tplZip.file(df)
    const oEntry = outZip.file(df)
    if (!tEntry || !oEntry) { fail(`${df}: 出力に存在しない`); drawOk = false; continue }
    const [tBuf, oBuf] = await Promise.all([tEntry.async('uint8array'), oEntry.async('uint8array')])
    if (!Buffer.from(tBuf).equals(Buffer.from(oBuf))) {
      fail(`${df}: 内容が変化しています`); drawOk = false
    }
  }
  if (drawOk) pass(`xl/drawings/(${drawingFiles.length}件): すべて変化なし`)

  return ok
}

// ── メイン ────────────────────────────────────────────────

async function main() {
  console.log('=== fill-template テスト ===\n')

  console.log('書き込みデータ:')
  for (const item of TEST_ITEMS) {
    console.log(`  [${item.category}] ${item.name} qty=${item.quantity} unit=${item.unit} amount=${item.amount}${item.memo ? ` memo="${item.memo}"` : ''}`)
  }
  console.log()

  const t0 = Date.now()
  let buf: Buffer
  try {
    buf = await fillTemplate(TEST_ITEMS, TEMPLATE_PATH)
    console.log(`生成完了: ${(Date.now() - t0)}ms, サイズ=${(buf.length / 1024).toFixed(1)}KB\n`)
  } catch (e) {
    console.error('❌ fillTemplate でエラー:', e)
    process.exit(1)
  }

  console.log('=== 整合性検証 ===')
  const ok = await verify(buf, TEMPLATE_PATH)
  console.log()

  await writeFile(OUTPUT_PATH, buf)
  console.log(`出力: ${OUTPUT_PATH}`)

  if (!ok) {
    console.error('\n❌ 検証失敗')
    process.exit(1)
  }
  console.log('\n✅ すべての検証パス')
}

main().catch((e) => { console.error(e); process.exit(1) })
