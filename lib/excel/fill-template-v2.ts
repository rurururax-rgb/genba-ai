/**
 * lib/excel/fill-template-v2.ts
 *
 * 自由グループ化・自由並び替えに対応した見積内訳書 Excel 出力（v2）。
 *
 * ■ 方針
 *   テンプレートから「シード行」(行62=グループ見出し, 行63=明細) を抽出し、
 *   必要な行数だけ複製してデータセクション（行62〜344）を丸ごと差し替える。
 *   複製した行の数式ノードは全て除去し、静的値を直書きする。
 *   他シート（見積表紙・ロゴ画像等）は JSZip 方式で一切変更しない。
 *
 * ■ 書き込み列（K列以降は絶対に書き込まない）
 *   明細行 → C:名称  E:数量  F:単位  G:単価  H:金額  J:備考
 *   見出し行 → B:グループ名  H:グループ合計
 *
 * ■ 制約
 *   MAX_DATA_ROWS(283行) を超える場合はエラー
 *   グループ数が SUMMARY_ROW_COUNT(10) を超える場合は警告のみ（超過分はスキップ）
 */

import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractMemoContent } from '@/lib/estimate/memo-utils'

// ──────────────────────────────────────────────────────────
// 定数
// ──────────────────────────────────────────────────────────

const TEMPLATE_FILENAME  = 'estimate-template.xlsx'
const SHEET_PATH         = 'xl/worksheets/sheet1.xml'
const CALC_CHAIN_PATH    = 'xl/calcChain.xml'

// データセクション（この範囲の行を丸ごと生成した行で置き換える）
const SEED_HEADER_ROW    = 62    // グループ見出し行のひな形
const SEED_ITEM_ROW      = 63    // 明細行のひな形
const DATA_SECTION_START = 62
const FOOTER_START_ROW   = 345   // この行以降はフッター（変更しない）
const MAX_DATA_ROWS      = FOOTER_START_ROW - DATA_SECTION_START  // 283行

// 集計表エリア（B37〜B46 / H37〜H46）
const SUMMARY_ROW_START  = 37
const SUMMARY_ROW_COUNT  = 10

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

export type FillItemV2 = {
  name:          string
  quantity:      number
  unit:          string
  selling_price: number | null
  amount:        number | null
  memo:          string | null
}

export type FillGroupV2 = {
  label:        string
  display_mode: 'detailed' | 'lump_sum'
  sort_order:   number
  items:        FillItemV2[]   // sort_order 昇順で渡すこと
}

export type FillInputV2 = {
  groups:    FillGroupV2[]
  ungrouped: (FillItemV2 & { sort_order: number })[]
  tax_rate:  number            // 例: 0.10
}

export type FillResultV2 = {
  buffer:   Buffer
  warnings: string[]
}

// ──────────────────────────────────────────────────────────
// バリデーション
// ──────────────────────────────────────────────────────────

export function validateFillInputV2(input: FillInputV2): string[] {
  const warnings: string[] = []

  let totalRows = 0
  for (const g of input.groups) {
    totalRows++   // グループ見出し行
    if (g.display_mode === 'detailed') totalRows += g.items.length
  }
  totalRows += input.ungrouped.length

  if (totalRows > MAX_DATA_ROWS) {
    throw new Error(
      `出力行数(${totalRows}行)が上限(${MAX_DATA_ROWS}行)を超えています。` +
      `グループ数または項目数を減らしてください。`,
    )
  }

  if (input.groups.length > SUMMARY_ROW_COUNT) {
    warnings.push(
      `グループ数(${input.groups.length}件)が集計表の上限(${SUMMARY_ROW_COUNT}件)を超えています。` +
      `${input.groups.length - SUMMARY_ROW_COUNT}件のグループが集計表に表示されません。`,
    )
  }

  return warnings
}

// ──────────────────────────────────────────────────────────
// XML ユーティリティ（fill-template.ts と同パターン）
// ──────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * セル要素を書き換える共通ロジック。
 * 自己終了タグと内容ありタグを別々に処理する（fill-template.ts と同実装）。
 */
function replaceCell(
  xml:     string,
  cellRef: string,
  builder: (attrs: string) => string,
): string {
  // ① 自己終了 <c r="X" s="..."/> — [^/]* で / の手前で停止
  xml = xml.replace(
    new RegExp(`<c r="${cellRef}"([^/]*)/>`, 'g'),
    (_m, attrs: string) => builder(attrs),
  )
  // ② コンテンツあり <c r="X" s="...">...</c>
  xml = xml.replace(
    new RegExp(`<c r="${cellRef}"([^>]*)>.*?</c>`, 'gs'),
    (_m, attrs: string) => builder(attrs),
  )
  return xml
}

function writeCellInlineStr(xml: string, cellRef: string, value: string): string {
  const escaped = escapeXml(value)
  return replaceCell(xml, cellRef, (attrs) => {
    const clean = attrs.replace(/\s+t="[^"]*"/, '')
    return `<c r="${cellRef}"${clean} t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
  })
}

function writeCellNumber(xml: string, cellRef: string, value: number): string {
  return replaceCell(xml, cellRef, (attrs) => {
    const clean = attrs.replace(/\s+t="[^"]*"/, '')
    return `<c r="${cellRef}"${clean}><v>${value}</v></c>`
  })
}

/**
 * H列専用: <f>...</f> 式ノードを除去して amount 値を直書き（fill-template.ts 互換）。
 */
function writeCellAmountReplaceFormula(xml: string, cellRef: string, amount: number): string {
  return xml.replace(
    new RegExp(`<c r="${cellRef}"([^>]*)>.*?</c>`, 'gs'),
    (_m, attrs: string) => {
      const clean = attrs.replace(/\s+t="[^"]*"/, '')
      return `<c r="${cellRef}"${clean}><v>${amount}</v></c>`
    },
  )
}

// ──────────────────────────────────────────────────────────
// シード行の抽出
// ──────────────────────────────────────────────────────────

function extractRow(xml: string, rowNum: number): string {
  const m = xml.match(new RegExp(`<row r="${rowNum}"[\\s\\S]*?<\\/row>`))
  if (!m) throw new Error(`テンプレートに行${rowNum}が見つかりません`)
  return m[0]
}

// ──────────────────────────────────────────────────────────
// 行クローン
// ──────────────────────────────────────────────────────────

/**
 * シード行 XML の行番号を toRow に書き換え、全数式ノードを除去する。
 *
 * 数式除去の理由:
 *   - クローン行は静的値のみを持つ。数式参照が壊れても問題ない。
 *   - shared formula のマスター行も同時に削除されるため、参照行との不整合を防ぐ。
 */
function cloneRow(seedXml: string, fromRow: number, toRow: number): string {
  let xml = seedXml
  // ① <row r="N"> の行番号
  xml = xml.replace(new RegExp(`(<row r=")${fromRow}(")`), `$1${toRow}$2`)
  // ② <c r="COLfromRow"> のセル参照（列はA〜最大3文字）
  xml = xml.replace(new RegExp(`(r=")([A-Z]{1,3})${fromRow}(")`, 'g'), `$1$2${toRow}$3`)
  // ③ 自己終了数式ノード <f .../> ← [^/]* で / の手前で停止
  xml = xml.replace(/<f([^/]*)\/>/g, '')
  // ④ コンテンツあり数式ノード <f ...>...</f>
  xml = xml.replace(/<f([^>]*)>[\s\S]*?<\/f>/g, '')
  return xml
}

// ──────────────────────────────────────────────────────────
// クローン行へのセル書き込み
// ──────────────────────────────────────────────────────────

function setStr(rowXml: string, col: string, row: number, value: string): string {
  return writeCellInlineStr(rowXml, `${col}${row}`, value)
}

function setNum(rowXml: string, col: string, row: number, value: number): string {
  return writeCellNumber(rowXml, `${col}${row}`, value)
}

function clearCell(rowXml: string, col: string, row: number): string {
  const ref = `${col}${row}`
  return replaceCell(rowXml, ref, (attrs) => {
    const clean = attrs.replace(/\s+t="[^"]*"/, '')
    return `<c r="${ref}"${clean}/>`
  })
}

// ──────────────────────────────────────────────────────────
// 行生成
// ──────────────────────────────────────────────────────────

function buildItemRow(
  seedItemXml: string,
  targetRow:   number,
  item:        FillItemV2,
): string {
  let row = cloneRow(seedItemXml, SEED_ITEM_ROW, targetRow)
  row = setStr(row, 'C', targetRow, item.name)
  row = setNum(row, 'E', targetRow, item.quantity)
  row = setStr(row, 'F', targetRow, item.unit)
  if (item.selling_price != null) {
    row = setNum(row, 'G', targetRow, item.selling_price)
  } else {
    row = clearCell(row, 'G', targetRow)
  }
  row = setNum(row, 'H', targetRow, item.amount ?? 0)
  const memo = extractMemoContent(item.memo)
  if (memo) row = setStr(row, 'J', targetRow, memo)
  else       row = clearCell(row, 'J', targetRow)
  return row
}

function buildGroupHeaderRow(
  seedHeaderXml: string,
  targetRow:     number,
  label:         string,
  total:         number,
): string {
  let row = cloneRow(seedHeaderXml, SEED_HEADER_ROW, targetRow)
  row = clearCell(row, 'A', targetRow)  // ブロック番号欄をクリア
  row = setStr(row, 'B', targetRow, label)
  row = setNum(row, 'H', targetRow, total)
  return row
}

// ──────────────────────────────────────────────────────────
// トップレベル要素の混合ソート
// ──────────────────────────────────────────────────────────

type TopElement =
  | { kind: 'group'; group: FillGroupV2; order: number }
  | { kind: 'item';  item: FillItemV2 & { sort_order: number }; order: number }

function buildTopElements(input: FillInputV2): TopElement[] {
  return [
    ...input.groups.map(g => ({ kind: 'group' as const, group: g, order: g.sort_order })),
    ...input.ungrouped.map(i => ({ kind: 'item' as const, item: i, order: i.sort_order })),
  ].sort((a, b) => a.order - b.order)
}

// ──────────────────────────────────────────────────────────
// データセクションの置換
// ──────────────────────────────────────────────────────────

function replaceDataSection(xml: string, dataRows: string[]): string {
  // "行62" の開始位置
  const dataStart = xml.indexOf(`<row r="${DATA_SECTION_START}" `)
  if (dataStart === -1) {
    throw new Error(`テンプレートにデータセクション開始行(${DATA_SECTION_START})が見つかりません`)
  }
  // "行345" の開始位置（フッター先頭）
  const footerStart = xml.indexOf(`<row r="${FOOTER_START_ROW}" `)
  if (footerStart === -1) {
    throw new Error(`テンプレートにフッター開始行(${FOOTER_START_ROW})が見つかりません`)
  }
  const before = xml.substring(0, dataStart)
  const after  = xml.substring(footerStart)
  return before + dataRows.join('') + after
}

// ──────────────────────────────────────────────────────────
// 合計・消費税・総合計の静的値書き込み（H54 / H55 / H57）
//
// テンプレートのセル構造（確認済み）:
//   H54 = shared formula SUM(H37:H53)  ← 合計
//   H55 = formula H54*10%              ← 消費税
//   H57 = formula SUM(H54:H56)         ← 総合計
//
// calcChain.xml 削除後に Excel が再計算するが、
// 静的値を書き込むことで再計算なしでも正しい値を表示する。
// ──────────────────────────────────────────────────────────

function fillFooterTotals(xml: string, input: FillInputV2): string {
  const subtotal = [
    ...input.groups.flatMap(g => g.items),
    ...input.ungrouped,
  ].reduce((s, it) => s + (it.amount ?? 0), 0)

  const tax        = Math.round(subtotal * input.tax_rate)
  const grandTotal = subtotal + tax

  xml = writeCellAmountReplaceFormula(xml, 'H54', subtotal)
  xml = writeCellAmountReplaceFormula(xml, 'H55', tax)
  xml = writeCellAmountReplaceFormula(xml, 'H57', grandTotal)

  return xml
}

// ──────────────────────────────────────────────────────────
// グループ集計表エリア（B37〜B46 / H37〜H46）
// ──────────────────────────────────────────────────────────

function fillGroupSummary(xml: string, input: FillInputV2): string {
  const groups = input.groups.slice(0, SUMMARY_ROW_COUNT)

  for (let i = 0; i < SUMMARY_ROW_COUNT; i++) {
    const summaryRow = SUMMARY_ROW_START + i  // 37〜46
    if (i < groups.length) {
      const total = groups[i].items.reduce((s, it) => s + (it.amount ?? 0), 0)
      xml = writeCellInlineStr(xml, `B${summaryRow}`, groups[i].label)
      xml = writeCellAmountReplaceFormula(xml, `H${summaryRow}`, total)
    } else {
      xml = writeCellInlineStr(xml, `B${summaryRow}`, '')
      xml = writeCellAmountReplaceFormula(xml, `H${summaryRow}`, 0)
    }
  }
  return xml
}

// ──────────────────────────────────────────────────────────
// メイン関数
// ──────────────────────────────────────────────────────────

export async function fillTemplateV2(input: FillInputV2): Promise<FillResultV2> {
  const warnings = validateFillInputV2(input)

  const templatePath = path.join(process.cwd(), 'templates', TEMPLATE_FILENAME)
  const templateBuf  = await readFile(templatePath)
  const zip          = await JSZip.loadAsync(templateBuf)

  const sheetEntry = zip.file(SHEET_PATH)
  if (!sheetEntry) throw new Error(`${SHEET_PATH} が見つかりません`)
  let xml = await sheetEntry.async('string')

  // シード行をデータセクション置換前に抽出する
  const seedHeaderXml = extractRow(xml, SEED_HEADER_ROW)
  const seedItemXml   = extractRow(xml, SEED_ITEM_ROW)

  // データ行を生成
  const topElements = buildTopElements(input)
  const dataRows: string[] = []
  let currentRow = DATA_SECTION_START

  for (const el of topElements) {
    if (el.kind === 'group') {
      const total = el.group.items.reduce((s, it) => s + (it.amount ?? 0), 0)
      dataRows.push(buildGroupHeaderRow(seedHeaderXml, currentRow, el.group.label, total))
      currentRow++

      if (el.group.display_mode === 'detailed') {
        for (const item of el.group.items) {
          dataRows.push(buildItemRow(seedItemXml, currentRow, item))
          currentRow++
        }
      }
    } else {
      dataRows.push(buildItemRow(seedItemXml, currentRow, el.item))
      currentRow++
    }
  }

  // データセクションを置換
  xml = replaceDataSection(xml, dataRows)

  // グループ集計表エリアを書き込む（B37〜B46 / H37〜H46）
  xml = fillGroupSummary(xml, input)

  // フッター合計行を静的値で書き込む（H54:合計 / H55:消費税 / H57:総合計）
  xml = fillFooterTotals(xml, input)

  // 数式を静的値に置き換えたため calcChain を削除（Excel 起動時に自動再構築）
  zip.remove(CALC_CHAIN_PATH)

  zip.file(SHEET_PATH, xml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer

  return { buffer, warnings }
}
