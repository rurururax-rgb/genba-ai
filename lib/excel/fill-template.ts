/**
 * lib/excel/fill-template.ts
 *
 * 「株式会社ラグズ建築_見積テンプレート_修正版_最終.xlsx」の
 * 「見積内訳書」シートに estimate_items データを書き込む。
 *
 * ■ 実装方針（重要）
 *   exceljs 等でファイル全体を読み書きすると、テンプレートに埋め込まれた
 *   セル内画像（Googleスプレッドシート由来）が破損する。
 *   そのため JSZip で xl/worksheets/sheet1.xml のみを文字列レベルで書き換え、
 *   他のエントリは一切変更しない方式をとる。
 *
 * ■ ブロック構造
 *   ブロックN のデータ行開始 = 63 + (N-1) × 26、データ行 19 行
 *   工種名は B37〜B46（ブロック1→B37, ブロック2→B38...）
 *
 * ■ 書き込み列（K列以降は絶対に書き込まない）
 *   A: 名称  E: 数量  F: 呼称/単位  G: 単価
 *   H: 金額（式ノードを除去して amount 値を直書き）
 *   J: 備考（extractMemoContent でプレフィクスを除去）
 *   I: 書き込まない（定価、データなし）
 */

import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CATEGORY_TO_BLOCK,
  validateCategoriesForExcel,
  groupByCategory,
} from '@/lib/estimate/categories'
import { extractMemoContent } from '@/lib/estimate/memo-utils'

// ──────────────────────────────────────────────────────────
// 定数
// ──────────────────────────────────────────────────────────

const TEMPLATE_FILENAME = '株式会社ラグズ建築_見積テンプレート_修正版_最終.xlsx'
const SHEET_PATH        = 'xl/worksheets/sheet1.xml'
const CALC_CHAIN_PATH   = 'xl/calcChain.xml'

const BLOCK_DATA_START  = 63   // ブロック1の最初のデータ行
const BLOCK_INTERVAL    = 26   // ブロック間の行数差
const ROWS_PER_BLOCK    = 19   // 1ブロック最大データ行数
const CATEGORY_ROW_BASE = 37   // B37=ブロック1, B38=ブロック2, ...

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

export type FillItem = {
  name:          string
  quantity:      number
  unit:          string
  selling_price: number | null
  amount:        number | null
  category:      string | null
  memo:          string | null
}

// ──────────────────────────────────────────────────────────
// メイン関数
// ──────────────────────────────────────────────────────────

/**
 * テンプレートに estimate_items を書き込み、Buffer を返す。
 * @param items        書き込む見積項目
 * @param templatePath テンプレートファイルパス（省略時: プロジェクトルート）
 */
export async function fillTemplate(
  items:        FillItem[],
  templatePath: string = path.join(process.cwd(), TEMPLATE_FILENAME),
): Promise<Buffer> {
  // ── 1. バリデーション ──────────────────────────────────

  // 未対応カテゴリがあれば throw（呼び出し元 API が 400 を返す）
  validateCategoriesForExcel(items)

  // カテゴリ別グループ化（CATEGORY_ORDER 順）
  const groups = groupByCategory(items, (i) => i.category)

  // 1ブロック上限チェック
  for (const [cat, catItems] of groups) {
    if (catItems.length > ROWS_PER_BLOCK) {
      throw new Error(
        `「${cat}」の項目数(${catItems.length}件)が上限(${ROWS_PER_BLOCK}件)を超えています`
      )
    }
  }

  // ── 2. ZIP を読み込み sheet1.xml を取得 ───────────────

  const templateBuf = await readFile(templatePath)
  const zip         = await JSZip.loadAsync(templateBuf)

  const sheetEntry = zip.file(SHEET_PATH)
  if (!sheetEntry) throw new Error(`${SHEET_PATH} が見つかりません`)

  let xml = await sheetEntry.async('string')

  // ── 3. B37〜B46 に工種名を書き込む ────────────────────

  for (const [cat, blockNum] of Object.entries(CATEGORY_TO_BLOCK)) {
    const row = CATEGORY_ROW_BASE + (blockNum - 1)  // B37, B38, ...
    xml = writeCellInlineStr(xml, `B${row}`, cat)
  }

  // ── 4. データ行を書き込む ──────────────────────────────

  for (const [cat, catItems] of groups) {
    const blockNum = CATEGORY_TO_BLOCK[cat]
    // 安全ガード: ブロック番号が 1〜10 の範囲外は絶対に書き込まない
    if (blockNum === undefined || blockNum < 1 || blockNum > 10) continue

    const rowStart = BLOCK_DATA_START + (blockNum - 1) * BLOCK_INTERVAL

    for (let i = 0; i < catItems.length; i++) {
      const item = catItems[i]
      const row  = rowStart + i

      // C列: 名称（「名称」ヘッダー A61:C61 の最右・最広列, 幅20.4）
      // A列(5.4)は幅不足でありブロック番号行に使用されるため不可
      // B列(2.1)はセパレーター列で更に狭い
      xml = writeCellInlineStr(xml, `C${row}`, item.name)
      // E列: 数量
      xml = writeCellNumber(xml, `E${row}`, item.quantity)
      // F列: 呼称/単位
      xml = writeCellInlineStr(xml, `F${row}`, item.unit)
      // G列: 単価（null の場合は書き込まない）
      if (item.selling_price != null) {
        xml = writeCellNumber(xml, `G${row}`, item.selling_price)
      }
      // H列: 金額（=S_row*1.45 の式ノードを除去して amount 値を直書き）
      xml = writeCellAmountReplaceFormula(xml, `H${row}`, item.amount ?? 0)
      // J列: 備考（「（現場メモ: ...）」プレフィクスを除去）
      const memoContent = extractMemoContent(item.memo)
      if (memoContent) {
        xml = writeCellInlineStr(xml, `J${row}`, memoContent)
      }
    }
  }

  // ── 5. 式を値に置き換えたため calcChain を削除 ──────────
  // Excel 起動時に自動再構築されるため削除しても問題なし
  zip.remove(CALC_CHAIN_PATH)

  // ── 6. sheet1.xml を戻して ZIP を生成 ──────────────────
  zip.file(SHEET_PATH, xml)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}

// ──────────────────────────────────────────────────────────
// XML セル操作ヘルパー（文字列レベル）
// ──────────────────────────────────────────────────────────

/** XML 特殊文字をエスケープする */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 自己終了タグ <c r="X" s="..." /> と
 * コンテンツあり <c r="X" s="...">...</c> を別々に処理する共通ロジック。
 *
 * なぜ分離するか:
 *   <c r="A" s="301"/> の場合、[^>]* は / も消費してしまう（/ は > ではないため）。
 *   その結果 /> が残らず >.*?</c> にフォールバックし、
 *   後続セルを丸ごと飲み込むバグが発生する。
 *   自己終了パターンでは [^/]* を使って / 手前で停止させることで回避する。
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
  // ② コンテンツあり <c r="X" s="...">...</c> — [^>]* で > の手前で停止
  xml = xml.replace(
    new RegExp(`<c r="${cellRef}"([^>]*)>.*?</c>`, 'gs'),
    (_m, attrs: string) => builder(attrs),
  )
  return xml
}

/**
 * セルをインライン文字列値に書き換える。
 * 既存の t="..." 属性を除去して t="inlineStr" を設定し、
 * <is><t xml:space="preserve">VALUE</t></is> を書き込む。
 */
function writeCellInlineStr(xml: string, cellRef: string, value: string): string {
  const escaped = escapeXml(value)
  return replaceCell(xml, cellRef, (attrs) => {
    const cleanAttrs = attrs.replace(/\s+t="[^"]*"/, '')
    return `<c r="${cellRef}"${cleanAttrs} t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
  })
}

/**
 * セルを数値に書き換える（t 属性なし = デフォルト数値型）。
 */
function writeCellNumber(xml: string, cellRef: string, value: number): string {
  return replaceCell(xml, cellRef, (attrs) => {
    const cleanAttrs = attrs.replace(/\s+t="[^"]*"/, '')
    return `<c r="${cellRef}"${cleanAttrs}><v>${value}</v></c>`
  })
}

/**
 * H列専用: <f>...</f> 式ノードを除去し amount 値を <v> に直書きする。
 * H列セルは常にコンテンツあり（<v>0</v> 等）なので自己終了を考慮しない。
 */
function writeCellAmountReplaceFormula(xml: string, cellRef: string, amount: number): string {
  return xml.replace(
    new RegExp(`<c r="${cellRef}"([^>]*)>.*?</c>`, 'gs'),
    (_m, attrs: string) => {
      const cleanAttrs = attrs.replace(/\s+t="[^"]*"/, '')
      return `<c r="${cellRef}"${cleanAttrs}><v>${amount}</v></c>`
    },
  )
}
