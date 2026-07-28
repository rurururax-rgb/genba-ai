/**
 * scripts/test-excel-v2.ts
 *
 * fill-template-v2.ts の動作確認スクリプト。
 *
 * 実行: npx tsx scripts/test-excel-v2.ts
 * 出力: /tmp/test-estimate-v2.xlsx
 *
 * テストケース:
 *   グループA（detailed）: 浴室一式 — 3項目
 *   グループB（lump_sum）: 洗面所水回り一式 — 2項目（見出し行のみ出力）
 *   未グループ項目: 養生一式、諸経費
 *   sort_order: グループAが先、未グループ「養生」が間に挟まる
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fillTemplateV2, type FillInputV2 } from '../lib/excel/fill-template-v2'

const input: FillInputV2 = {
  groups: [
    {
      label: '浴室一式',
      display_mode: 'detailed',
      sort_order: 10,
      items: [
        { name: '浴室撤去工事',  quantity: 1, unit: '式', selling_price: 80000,  amount: 80000,  memo: null },
        { name: 'ユニットバス取付',quantity: 1, unit: '式', selling_price: 150000, amount: 150000, memo: '（現場メモ: LIXIL アライズ 1616）' },
        { name: '給排水接続工事', quantity: 1, unit: '式', selling_price: 55000,  amount: 55000,  memo: null },
      ],
    },
    {
      label: '洗面所水回り一式',
      display_mode: 'lump_sum',
      sort_order: 30,
      items: [
        { name: '洗面台交換工事', quantity: 1, unit: '式', selling_price: 90000,  amount: 90000,  memo: null },
        { name: '洗濯機パン設置', quantity: 1, unit: '式', selling_price: 25000,  amount: 25000,  memo: null },
      ],
    },
  ],
  ungrouped: [
    { name: '養生一式',   quantity: 1, unit: '式', selling_price: 30000, amount: 30000, memo: null, sort_order: 20 },
    { name: '諸経費',     quantity: 1, unit: '式', selling_price: 50000, amount: 50000, memo: '（現場メモ: 廃材処分含む）', sort_order: 40 },
  ],
  tax_rate: 0.10,
}

async function main() {
  console.log('テスト開始...')

  const { buffer, warnings } = await fillTemplateV2(input)

  if (warnings.length > 0) {
    console.warn('警告:', warnings)
  }

  const outPath = path.join('/tmp', 'test-estimate-v2.xlsx')
  await writeFile(outPath, buffer)

  const expectedOrder = [
    '行62: [グループ見出し] 浴室一式 (detailed)',
    '行63: 浴室撤去工事',
    '行64: ユニットバス取付',
    '行65: 給排水接続工事',
    '行66: [未グループ] 養生一式',
    '行67: [グループ見出し] 洗面所水回り一式 (lump_sum)',
    '行68: [未グループ] 諸経費',
  ]
  console.log('\n期待する出力行順:')
  expectedOrder.forEach(l => console.log(' ', l))

  console.log(`\n出力: ${outPath}`)
  console.log(`ファイルサイズ: ${(buffer.length / 1024).toFixed(1)} KB`)
  console.log('\nExcel で開いて以下を確認してください:')
  console.log('  1. 行62 に「浴室一式」の見出し行（太字・背景色付き）')
  console.log('  2. 行63-65 に明細3件（名称・数量・単価・金額）')
  console.log('  3. 行66 に「養生一式」（未グループ、明細行スタイル）')
  console.log('  4. 行67 に「洗面所水回り一式」の見出し行（明細なし）')
  console.log('  5. 行68 に「諸経費」（備考欄に「廃材処分含む」）')
  console.log('  6. 行37-38 の集計表に「浴室一式」「洗面所水回り一式」と金額')
  console.log('  7. 行69以降は空白')
}

main().catch(e => { console.error(e); process.exit(1) })
