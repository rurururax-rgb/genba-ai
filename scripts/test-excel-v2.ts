/**
 * scripts/test-excel-v2.ts
 *
 * fill-template-v2.ts（ブロック構造版）の動作確認スクリプト。
 *
 * テストケース:
 *   Case A: 通常ケース（グループ・未グループ混在）
 *   Case B: selling_price=null / memo=null（自己終了タグ確認）
 *   Case C: validateGeneratedXml の検知テスト
 *   Case D: 4グループ + 21行グループ（次ブロックへ繰り越し）
 *   Case E: 11グループ（上限ちょうど）
 *   Case F: 25行グループ（19+6 = 2ブロックに繰り越し、集計表は全体合計）
 *   Case G: ブロック上限超過でエラー（6グループ×20行 = 12ブロック必要 > 上限11）
 */

import { writeFile } from 'node:fs/promises'
import { XMLParser } from 'fast-xml-parser'
import path from 'node:path'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { fillTemplateV2, validateFillInputV2, validateGeneratedXml, type FillInputV2 } from '../lib/excel/fill-template-v2'

// ──────────────────────────────────────────────────────────
// テストデータ
// ──────────────────────────────────────────────────────────

const inputA: FillInputV2 = {
  groups: [
    {
      label: '浴室一式',
      display_mode: 'detailed',
      sort_order: 10,
      items: [
        { name: '浴室撤去工事',    quantity: 1, unit: '式', selling_price: 80000,  amount: 80000,  memo: null },
        { name: 'ユニットバス取付', quantity: 1, unit: '式', selling_price: 150000, amount: 150000, memo: '（現場メモ: LIXIL アライズ 1616）' },
        { name: '給排水接続工事',   quantity: 1, unit: '式', selling_price: 55000,  amount: 55000,  memo: null },
      ],
    },
    {
      label: '洗面所水回り一式',
      display_mode: 'lump_sum',
      sort_order: 30,
      items: [
        { name: '洗面台交換工事', quantity: 1, unit: '式', selling_price: 90000, amount: 90000, memo: null },
        { name: '洗濯機パン設置', quantity: 1, unit: '式', selling_price: 25000, amount: 25000, memo: null },
      ],
    },
  ],
  ungrouped: [
    { name: '養生一式', quantity: 1, unit: '式', selling_price: 30000, amount: 30000, memo: null,             sort_order: 20 },
    { name: '諸経費',   quantity: 1, unit: '式', selling_price: 50000, amount: 50000, memo: '（廃材処分含む）', sort_order: 40 },
  ],
  tax_rate: 0.10,
}

const inputB: FillInputV2 = {
  groups: [
    {
      label: '屋根工事一式',
      display_mode: 'detailed',
      sort_order: 10,
      items: [
        { name: '既存屋根撤去',   quantity: 1,  unit: '式', selling_price: null,  amount: 0,      memo: null },
        { name: '防水シート張り', quantity: 45, unit: '㎡', selling_price: 2500,  amount: 112500, memo: null },
        { name: 'ルーフィング工事', quantity: 1, unit: '式', selling_price: null, amount: 85000,  memo: '数量確認中' },
      ],
    },
  ],
  ungrouped: [
    { name: '仮設足場', quantity: 1, unit: '式', selling_price: 120000, amount: 120000, memo: null, sort_order: 20 },
  ],
  tax_rate: 0.10,
}

function makeItems(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    name:          `${prefix} 項目${i + 1}`,
    quantity:      1,
    unit:          '式',
    selling_price: 10000 + i * 1000,
    amount:        10000 + i * 1000,
    memo:          i % 3 === 0 ? `備考${i + 1}` : null,
  }))
}

// 4グループ + 1グループ21行（上限19行超え → 截断＋警告）
const inputD: FillInputV2 = {
  groups: [
    { label: '外壁工事一式',           display_mode: 'detailed', sort_order: 10, items: makeItems(21, '外壁') },
    { label: '屋根工事一式',           display_mode: 'detailed', sort_order: 20, items: makeItems(8,  '屋根') },
    { label: '内装工事一式',           display_mode: 'detailed', sort_order: 30, items: makeItems(5,  '内装') },
    { label: '設備工事一式（一式表示）', display_mode: 'lump_sum', sort_order: 40, items: makeItems(3,  '設備') },
  ],
  ungrouped: [
    { name: '諸経費', quantity: 1, unit: '式', selling_price: 50000, amount: 50000, memo: null, sort_order: 50 },
  ],
  tax_rate: 0.10,
}

// 11グループ（NUM_BLOCKS 上限ちょうど）
const inputE: FillInputV2 = {
  groups: Array.from({ length: 11 }, (_, i) => ({
    label:        `工事${i + 1}`,
    display_mode: 'detailed' as const,
    sort_order:   (i + 1) * 10,
    items:        makeItems(2, `工${i + 1}`),
  })),
  ungrouped: [],
  tax_rate: 0.10,
}

// 25行グループ（19+6 = 2ブロックに繰り越し）
// items 0-18: 10000+11000+...+28000 = 361,000
// items 19-24: 29000+30000+31000+32000+33000+34000 = 189,000
// 全体合計 = 550,000
const inputF: FillInputV2 = {
  groups: [
    {
      label:        '外壁工事一式',
      display_mode: 'detailed',
      sort_order:   10,
      items:        makeItems(25, '外壁'),
    },
    {
      label:        '屋根工事一式',
      display_mode: 'detailed',
      sort_order:   20,
      items:        makeItems(5, '屋根'),
    },
  ],
  ungrouped: [],
  tax_rate: 0.10,
}

// ブロック数超過エラーケース（6グループ×20行 = 12ブロック必要 > NUM_BLOCKS=11）
const inputG: FillInputV2 = {
  groups: Array.from({ length: 6 }, (_, i) => ({
    label:        `工事${i + 1}`,
    display_mode: 'detailed' as const,
    sort_order:   (i + 1) * 10,
    items:        makeItems(20, `工${i + 1}`),
  })),
  ungrouped: [],
  tax_rate: 0.10,
}

// ──────────────────────────────────────────────────────────
// XLSX 検証ヘルパー
// ──────────────────────────────────────────────────────────

function getCellNumericValue(
  allRowWrappers: Record<string, unknown>[],
  cellRef: string,
): number | undefined {
  const rowNum = parseInt(cellRef.replace(/[A-Za-z]+/, ''), 10)
  const rowWrapper = allRowWrappers.find(
    n => 'row' in n && Number((n[':@'] as Record<string, unknown>)['@_r']) === rowNum,
  )
  if (!rowWrapper) return undefined
  const cell = (rowWrapper.row as Record<string, unknown>[]).find(
    n => 'c' in n && (n[':@'] as Record<string, unknown>)['@_r'] === cellRef,
  )
  if (!cell) return undefined
  const vNode = (cell.c as Record<string, unknown>[]).find(ch => 'v' in ch)
  if (!vNode) return undefined
  const vChildren = vNode.v as Record<string, unknown>[]
  const textNode = vChildren.find(ch => '#text' in ch)
  return textNode ? Number(textNode['#text']) : undefined
}

async function getXlsxRows(xlsxPath: string): Promise<Record<string, unknown>[]> {
  const buf    = await readFile(xlsxPath)
  const zip    = await JSZip.loadAsync(buf)
  const xmlStr = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    preserveOrder: true, parseTagValue: false, parseAttributeValue: false,
  })
  const doc = parser.parse(xmlStr) as Record<string, unknown>[]
  const ws  = doc.find(n => 'worksheet' in n) as Record<string, unknown>
  const sd  = (ws.worksheet as Record<string, unknown>[]).find(n => 'sheetData' in n) as Record<string, unknown>
  return (sd.sheetData as Record<string, unknown>[]).filter(n => 'row' in n)
}

async function verifyXlsx(label: string, xlsxPath: string): Promise<boolean> {
  const buf    = await readFile(xlsxPath)
  const zip    = await JSZip.loadAsync(buf)
  const xmlStr = await zip.file('xl/worksheets/sheet1.xml')!.async('string')

  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    preserveOrder: true, parseTagValue: false, parseAttributeValue: false,
  })

  let ok = true

  // ① XML 構造チェック
  try {
    parser.parse(xmlStr)
    console.log(`  [OK] XML 構造が正しい`)
  } catch (e: unknown) {
    console.error(`  [NG] XML パースエラー: ${e instanceof Error ? e.message : e}`)
    ok = false
  }

  // ② //> パターン（旧バグ）
  const doubleslash = (xmlStr.match(/\/\/>/g) ?? []).length
  if (doubleslash === 0) {
    console.log(`  [OK] //> パターンなし`)
  } else {
    console.error(`  [NG] //> パターンが ${doubleslash} 件`)
    ok = false
  }

  // ③ <c> タグバランス
  const openTags  = (xmlStr.match(/<c\b[^>]*[^/]>/g) ?? []).length
  const selfClose = (xmlStr.match(/<c\b[^>]*\/>/g) ?? []).length
  const closeTags = (xmlStr.match(/<\/c>/g) ?? []).length
  if (openTags === closeTags) {
    console.log(`  [OK] <c> タグバランス: open=${openTags} self=${selfClose} close=${closeTags}`)
  } else {
    console.error(`  [NG] <c> タグ不均衡: open=${openTags} self=${selfClose} close=${closeTags}`)
    ok = false
  }

  const doc = parser.parse(xmlStr) as Record<string, unknown>[]
  const ws  = doc.find(n => 'worksheet' in n) as Record<string, unknown>
  const sd  = (ws.worksheet as Record<string, unknown>[]).find(n => 'sheetData' in n) as Record<string, unknown>
  const rows = sd.sheetData as Record<string, unknown>[]
  const allRowWrappers = rows.filter(n => 'row' in n)

  // ④ データセクション全行存在確認（行62〜344 = 283行）
  const rowNums = new Set(allRowWrappers.map(n => Number((n[':@'] as Record<string,unknown>)['@_r'])))
  const missing: number[] = []
  for (let r = 62; r < 345; r++) {
    if (!rowNums.has(r)) missing.push(r)
  }
  if (missing.length === 0) {
    console.log(`  [OK] データセクション全行存在（行62〜344 = 283行）`)
  } else {
    const sample = missing.slice(0, 5).join(', ')
    console.error(`  [NG] データセクションに欠損行: ${missing.length}行 (例: ${sample}...)`)
    ok = false
  }

  // ⑤ データ行に数式が残っていないか
  const dataRows = allRowWrappers.filter(n => {
    const r = Number((n[':@'] as Record<string,unknown>)['@_r'])
    return r >= 62 && r < 345
  })
  let formulaFound = false
  for (const row of dataRows) {
    for (const cell of row.row as Record<string, unknown>[]) {
      if (!('c' in cell)) continue
      if ((cell.c as Record<string, unknown>[]).some(ch => 'f' in ch)) {
        const rn = (row[':@'] as Record<string, unknown>)['@_r']
        const cr = (cell[':@'] as Record<string, unknown>)['@_r']
        console.error(`  [NG] 数式が残っています: 行${rn} セル${cr}`)
        formulaFound = true
        ok = false
      }
    }
  }
  if (!formulaFound) console.log(`  [OK] データ行に数式なし`)

  return ok
}

// ──────────────────────────────────────────────────────────
// メイン
// ──────────────────────────────────────────────────────────

async function main() {

  // ─── Case A ──────────────────────────────────────────────
  console.log('\n=== Case A: 通常ケース（グループ・未グループ混在）===')
  const { buffer: bufA, warnings: wA } = await fillTemplateV2(inputA)
  if (wA.length) console.warn('警告:', wA)
  const pathA = path.join('/tmp', 'test-estimate-v2-A.xlsx')
  await writeFile(pathA, bufA)
  console.log(`出力: ${pathA}  (${(bufA.length / 1024).toFixed(1)} KB)`)
  await verifyXlsx('Case A', pathA)

  // ブロック構造での期待配置
  console.log('\n  ブロック配置（新方式）:')
  console.log('  ブロック0 (行62〜87):')
  console.log('    行62: [見出し] 浴室一式  H=285,000')
  console.log('    行63: 浴室撤去工事 / 行64: ユニットバス取付 / 行65: 給排水接続工事')
  console.log('    行66〜81: 空明細スロット  行82: SUM行  行83〜87: 区切り')
  console.log('  ブロック1 (行88〜113):')
  console.log('    行88: [見出し] 洗面所水回り一式（lump_sum → 明細なし）  H=115,000')
  console.log('    行89〜107: 空  行108: SUM行  行109〜113: 区切り')
  console.log('  ブロック2 (行114〜139):')
  console.log('    行114: [見出し] ungrouped block（ラベル空）  H=80,000')
  console.log('    行115: 養生一式 / 行116: 諸経費')
  console.log('    行117〜133: 空  行134: SUM行  行135〜139: 区切り')
  console.log('  ブロック3〜10 (行140〜344): 全て空ブロック')

  // ─── Case B ──────────────────────────────────────────────
  console.log('\n=== Case B: selling_price=null / memo=null ケース ===')
  const { buffer: bufB, warnings: wB } = await fillTemplateV2(inputB)
  if (wB.length) console.warn('警告:', wB)
  const pathB = path.join('/tmp', 'test-estimate-v2-B.xlsx')
  await writeFile(pathB, bufB)
  console.log(`出力: ${pathB}  (${(bufB.length / 1024).toFixed(1)} KB)`)
  await verifyXlsx('Case B', pathB)

  // ─── Case C: validateGeneratedXml の検知テスト ───────────
  console.log('\n=== Case C: validateGeneratedXml の検知テスト ===')

  // C-1: 行番号重複（欠損行チェックより先に検知される）
  console.log('\n  C-1: 行番号重複の検知')
  const badXml_dup = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="62"><c r="A62" s="1"/></row>
<row r="62"><c r="B62" s="1"/></row>
<row r="345"><c r="A345" s="1"/></row>
</sheetData>
</worksheet>`
  try {
    validateGeneratedXml(badXml_dup)
    console.error('  [NG] 重複を検知できなかった')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('重複')) {
      console.log(`  [OK] 行番号重複を正しく検知: ${msg}`)
    } else {
      console.error(`  [NG] 期待と異なるエラー: ${msg}`)
    }
  }

  // C-2: データセクション欠損行の検知（行62〜344がそろっていないXML）
  console.log('\n  C-2: データセクション欠損行の検知')
  const badXml_sparse = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="62"><c r="H62" s="1"><v>100000</v></c></row>
<row r="345"><c r="A345" s="1"/></row>
</sheetData>
</worksheet>`
  try {
    validateGeneratedXml(badXml_sparse)
    console.error('  [NG] 欠損行を検知できなかった')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('欠損行')) {
      console.log(`  [OK] データセクション欠損行を正しく検知: ${msg.slice(0, 80)}...`)
    } else {
      console.error(`  [NG] 期待と異なるエラー: ${msg}`)
    }
  }

  // C-3: Case A の出力（正常）が validateGeneratedXml を通過するか
  console.log('\n  C-3: fillTemplateV2 出力が validateGeneratedXml を通過するか')
  try {
    const zip2   = await JSZip.loadAsync(bufA)
    const xmlStr = await zip2.file('xl/worksheets/sheet1.xml')!.async('string')
    validateGeneratedXml(xmlStr)
    console.log('  [OK] Case A 出力は検証を通過')
  } catch (e: unknown) {
    console.error(`  [NG] Case A 出力が検証エラー: ${e instanceof Error ? e.message : e}`)
  }

  // ─── Case D: 4グループ + 21行グループ（繰り越し） ─────────
  console.log('\n=== Case D: 4グループ + 21行グループ（次ブロックへ繰り越し）===')
  const { buffer: bufD, warnings: wD } = await fillTemplateV2(inputD)
  console.log(`警告(${wD.length}件):`, wD)
  const noTruncWarn = !wD.some(w => w.includes('外壁工事'))
  console.log(`  [${noTruncWarn ? 'OK' : 'NG'}] 截断警告なし（繰り越し方式のため）`)
  const pathD = path.join('/tmp', 'test-estimate-v2-D.xlsx')
  await writeFile(pathD, bufD)
  console.log(`出力: ${pathD}  (${(bufD.length / 1024).toFixed(1)} KB)`)
  await verifyXlsx('Case D', pathD)

  console.log('\n  ブロック配置（繰り越し方式）:')
  console.log('  ブロック0 (行62〜87):   外壁工事一式（1〜19行目）+ SUM + 区切り5')
  console.log('  ブロック1 (行88〜113):  外壁工事一式（続き）（20〜21行目 + 空17行）+ SUM + 区切り5')
  console.log('  ブロック2 (行114〜139): 屋根工事一式（8行 + 空11行）+ SUM + 区切り5')
  console.log('  ブロック3 (行140〜165): 内装工事一式（5行 + 空14行）+ SUM + 区切り5')
  console.log('  ブロック4 (行166〜191): 設備工事一式（lump_sum, 明細全空）+ SUM + 区切り5')
  console.log('  ブロック5 (行192〜217): ungrouped block・諸経費（1行 + 空18行）+ SUM + 区切り5')
  console.log('  ブロック6〜10 (行218〜344): 空ブロック × 5')

  // ─── Case E: 11グループ（NUM_BLOCKS ちょうど）──────────────
  console.log('\n=== Case E: 11グループ（ブロック上限ちょうど）===')
  const { buffer: bufE, warnings: wE } = await fillTemplateV2(inputE)
  if (wE.length) console.warn('警告:', wE)
  const pathE = path.join('/tmp', 'test-estimate-v2-E.xlsx')
  await writeFile(pathE, bufE)
  console.log(`出力: ${pathE}  (${(bufE.length / 1024).toFixed(1)} KB)`)
  await verifyXlsx('Case E', pathE)
  const noOverflowWarn = !wE.some(w => w.includes('ブロック数'))
  console.log(`  [${noOverflowWarn ? 'OK' : 'NG'}] 11グループでブロック上限超過の警告なし`)

  // ─── Case F: 25行グループ（19+6 = 2ブロック繰り越し）───────
  console.log('\n=== Case F: 25行グループ（19+6 で次ブロックへ繰り越し）===')
  // 期待値:
  //   block0 per-block total = 10000+11000+...+28000 = 361,000
  //   block1 per-block total = 29000+30000+31000+32000+33000+34000 = 189,000
  //   summary H37 (外壁合計) = 550,000
  //   block2 header H114 (屋根合計) = 10000+11000+12000+13000+14000 = 60,000
  const { buffer: bufF, warnings: wF } = await fillTemplateV2(inputF)
  if (wF.length) console.warn('警告:', wF)
  const pathF = path.join('/tmp', 'test-estimate-v2-F.xlsx')
  await writeFile(pathF, bufF)
  console.log(`出力: ${pathF}  (${(bufF.length / 1024).toFixed(1)} KB)`)
  await verifyXlsx('Case F', pathF)

  const rowsF = await getXlsxRows(pathF)
  const checkCell = (ref: string, expected: number) => {
    const val = getCellNumericValue(rowsF, ref)
    const ok = val === expected
    console.log(`  [${ok ? 'OK' : 'NG'}] ${ref} = ${val} (期待: ${expected})`)
  }
  console.log('\n  セル値確認:')
  checkCell('H62',  361000)   // block0 ヘッダー（外壁 per-block 合計）
  checkCell('H82',  361000)   // block0 SUM行
  checkCell('H88',  189000)   // block1 ヘッダー（外壁続き per-block 合計）
  checkCell('H108', 189000)   // block1 SUM行
  checkCell('H114',  60000)   // block2 ヘッダー（屋根合計）
  checkCell('H134',  60000)   // block2 SUM行
  checkCell('H37',  550000)   // 集計表: 外壁工事一式（全体合計 = 361000 + 189000）
  checkCell('H38',   60000)   // 集計表: 屋根工事一式

  // ─── Case G: ブロック数超過エラー ────────────────────────
  console.log('\n=== Case G: ブロック数超過でエラー（6グループ×20行 = 12ブロック）===')
  try {
    validateFillInputV2(inputG)
    console.error('  [NG] エラーが発生しなかった')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('12') && msg.includes('11')) {
      console.log(`  [OK] 正しくエラー: ${msg}`)
    } else {
      console.error(`  [NG] エラーメッセージが期待と異なる: ${msg}`)
    }
  }

  // ─── まとめ ───────────────────────────────────────────────
  console.log('\n\n完了。Excel で以下を開いて目視確認してください:')
  console.log(`  Case A: ${pathA}`)
  console.log(`  Case B: ${pathB}`)
  console.log(`  Case D: ${pathD}`)
  console.log(`  Case E: ${pathE}`)
  console.log(`  Case F: ${pathF}`)
  console.log('\nExcel 確認ポイント:')
  console.log('  1. 開いてもエラーダイアログ・repair ダイアログが出ないこと')
  console.log('  2. 行62にグループ名と合計が表示されること')
  console.log('  3. 行82（SUM行）・行83〜87（区切り行）が存在すること')
  console.log('  4. 行88以降のブロックが構造的に正しいこと')
  console.log('  5. K列以降（原価・利益率等）の計算補助列が壊れていないこと')
  console.log('  6. 行37〜46の集計表にグループ名と合計が表示されること')
  console.log('  7. 行54・55・57に小計・消費税・合計が表示されること')
  console.log('  Case F 追加確認:')
  console.log('    8. 行62〜81に外壁工事一式 1〜19番目の項目が表示されること')
  console.log('    9. 行88のヘッダーが「外壁工事一式（続き）」で行89〜90に 20・21〜25番目が表示されること')
  console.log('    10. 行37（集計表）の外壁工事一式合計が 550,000 であること')
}

main().catch(e => { console.error(e); process.exit(1) })
