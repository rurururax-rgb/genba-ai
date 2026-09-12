/**
 * lib/excel/fill-template-v2.ts
 *
 * ブロック構造を保持した見積内訳書 Excel 出力（v2）。
 *
 * ■ テンプレート構造（確認済み）
 *   データセクション: 行62〜344（283行 = 11ブロック）
 *     ブロック0〜9: 各26行（ヘッダー1 + 明細19 + SUM1 + 区切り5）
 *     ブロック10: 23行（ヘッダー1 + 明細19 + SUM1 + 区切り2）
 *     ※ ブロック10の区切り行3〜5（345〜347）はフッター保持エリアに含まれる
 *   フッター保持エリア: 行345〜（replaceDataSectionNodesで保持）
 *
 * ■ 書き込み列（K列以降は絶対に書き込まない）
 *   明細行 → C:名称  E:数量  F:単位  G:単価  H:金額  J:備考
 *   見出し行 → B:グループ名  H:グループ合計
 *
 * ■ グループ上限
 *   MAX 11グループ（NUM_BLOCKS）
 *   1グループあたり MAX 19項目（ITEMS_PER_BLOCK）
 *   ※ 超過分は警告を出してスキップ
 */

import JSZip from 'jszip'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractMemoContent } from '@/lib/estimate/memo-utils'

// ──────────────────────────────────────────────────────────
// 定数
// ──────────────────────────────────────────────────────────

const TEMPLATE_FILENAME  = 'estimate-template.xlsx'
const SHEET_PATH         = 'xl/worksheets/sheet1.xml'
const CALC_CHAIN_PATH    = 'xl/calcChain.xml'

const SEED_HEADER_ROW    = 62   // ブロック0のヘッダー行（全ブロックの基準）
const DATA_SECTION_START = 62
const FOOTER_START_ROW   = 345  // 行345以降をフッターとして保持

const NUM_BLOCKS         = 11   // 10完全ブロック + 1部分ブロック
const ITEMS_PER_BLOCK    = 19   // 明細スロット数/ブロック
const BLOCK_INTERVAL     = 26   // 1ブロックの行数（完全ブロック）
const SUM_OFFSET         = 20   // ヘッダー行からSUM行までのオフセット（1+19=20）
const SEP_COUNT          = 5    // 区切り行数（完全ブロック）

const SUMMARY_ROW_START  = 37
const SUMMARY_ROW_COUNT  = 10

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

type XNode = Record<string, unknown>

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
  items:        FillItemV2[]
}

export type FillInputV2 = {
  groups:    FillGroupV2[]
  ungrouped: (FillItemV2 & { sort_order: number })[]
  tax_rate:  number
}

export type FillResultV2 = {
  buffer:   Buffer
  warnings: string[]
}

// ブロックに書き込むデータ（グループまたはグループ外項目の集まり）
type BlockData = {
  label:        string
  display_mode: 'detailed' | 'lump_sum'
  items:        FillItemV2[]
  total:        number
}

// ──────────────────────────────────────────────────────────
// バリデーション
// ──────────────────────────────────────────────────────────

export function validateFillInputV2(input: FillInputV2): string[] {
  const warnings: string[] = []

  // 必要なブロック数を計算（19項目超えの場合は繰り越しブロック分を含む）
  let totalBlocks = 0
  for (const g of input.groups) {
    if (g.display_mode === 'lump_sum' || g.items.length === 0) {
      totalBlocks++
    } else {
      totalBlocks += Math.ceil(g.items.length / ITEMS_PER_BLOCK)
    }
  }
  if (input.ungrouped.length > 0) {
    totalBlocks += Math.ceil(input.ungrouped.length / ITEMS_PER_BLOCK)
  }

  if (totalBlocks > NUM_BLOCKS) {
    throw new Error(
      `必要なブロック数(${totalBlocks})がテンプレートの上限(${NUM_BLOCKS})を超えています。` +
      `項目数を削減するかグループを分割してください。`,
    )
  }

  // 集計表の上限チェック（警告のみ）
  if (input.groups.length > SUMMARY_ROW_COUNT) {
    warnings.push(
      `グループ数(${input.groups.length}件)が集計表の上限(${SUMMARY_ROW_COUNT}件)を超えています。` +
      `${input.groups.length - SUMMARY_ROW_COUNT}件のグループが集計表に表示されません。`,
    )
  }

  return warnings
}

// ──────────────────────────────────────────────────────────
// XML パーサー / ビルダー
// ──────────────────────────────────────────────────────────

function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes:       false,
    attributeNamePrefix:    '@_',
    preserveOrder:          true,
    allowBooleanAttributes: true,
    parseTagValue:          false,
    parseAttributeValue:    false,
    trimValues:             false,
  })
}

function createBuilder(): XMLBuilder {
  return new XMLBuilder({
    ignoreAttributes:          false,
    attributeNamePrefix:       '@_',
    preserveOrder:             true,
    suppressBooleanAttributes: false,
    suppressEmptyNode:         true,
    format:                    false,
  })
}

// ──────────────────────────────────────────────────────────
// ナビゲーション
// ──────────────────────────────────────────────────────────

function getSheetDataWrapper(doc: XNode[]): XNode {
  const ws = doc.find(n => 'worksheet' in n) as XNode | undefined
  if (!ws) throw new Error('worksheet 要素が見つかりません')
  const sd = (ws.worksheet as XNode[]).find(n => 'sheetData' in n) as XNode | undefined
  if (!sd) throw new Error('sheetData 要素が見つかりません')
  return sd
}

function findRowWrapper(rows: XNode[], rowNum: number): XNode | undefined {
  return rows.find(n => 'row' in n && (n[':@'] as XNode)['@_r'] === String(rowNum))
}

function findCellWrapper(rowWrapper: XNode, cellRef: string): XNode | undefined {
  return (rowWrapper.row as XNode[]).find(
    n => 'c' in n && (n[':@'] as XNode)['@_r'] === cellRef,
  )
}

// ──────────────────────────────────────────────────────────
// 行クローン
// ──────────────────────────────────────────────────────────

/**
 * シード行を深複製して行番号を書き換え、全数式ノードを除去する。
 * fast-xml-parser の構造では <f> は子ノードのキーが 'f' であるため、
 * filter(child => !('f' in child)) で shared/通常を問わず一括除去できる。
 */
function cloneRowNode(rowWrapper: XNode, toRow: number): XNode {
  const cloned = structuredClone(rowWrapper) as XNode

  // ① 行番号を更新
  ;(cloned[':@'] as XNode)['@_r'] = String(toRow)

  // ② 各セルのセル参照を更新し、数式ノードを除去
  for (const cellWrapper of cloned.row as XNode[]) {
    if (!('c' in cellWrapper)) continue
    const attrs = cellWrapper[':@'] as XNode
    const oldRef = attrs['@_r'] as string
    attrs['@_r'] = oldRef.replace(/\d+$/, String(toRow))
    cellWrapper.c = (cellWrapper.c as XNode[]).filter(child => !('f' in child))
  }
  return cloned
}

// ──────────────────────────────────────────────────────────
// セル書き込み
// ──────────────────────────────────────────────────────────

function setCellString(rowWrapper: XNode, col: string, rowNum: number, value: string): void {
  const cell = findCellWrapper(rowWrapper, `${col}${rowNum}`)
  if (!cell) return
  const attrs = cell[':@'] as XNode
  attrs['@_t'] = 'inlineStr'
  cell.c = [{ is: [{ t: [{ '#text': value }], ':@': { '@_xml:space': 'preserve' } }] }]
}

function setCellNumber(rowWrapper: XNode, col: string, rowNum: number, value: number): void {
  const cell = findCellWrapper(rowWrapper, `${col}${rowNum}`)
  if (!cell) return
  const attrs = cell[':@'] as XNode
  delete attrs['@_t']
  cell.c = [{ v: [{ '#text': String(value) }] }]
}

function clearCellNode(rowWrapper: XNode, col: string, rowNum: number): void {
  const cell = findCellWrapper(rowWrapper, `${col}${rowNum}`)
  if (!cell) return
  const attrs = cell[':@'] as XNode
  delete attrs['@_t']
  cell.c = []
}

// フッター・集計表用: f・v を含む既存子ノードを全て破棄して静的値を書き込む
function setFormulaCell(rowWrapper: XNode, col: string, rowNum: number, value: number): void {
  const cell = findCellWrapper(rowWrapper, `${col}${rowNum}`)
  if (!cell) return
  delete (cell[':@'] as XNode)['@_t']
  cell.c = [{ v: [{ '#text': String(value) }] }]
}

// ──────────────────────────────────────────────────────────
// データセクション置換
// ──────────────────────────────────────────────────────────

function replaceDataSectionNodes(rows: XNode[], newRows: XNode[]): XNode[] {
  const before = rows.filter(
    n => !('row' in n) || Number((n[':@'] as XNode)['@_r']) < DATA_SECTION_START,
  )
  const after = rows.filter(
    n => 'row' in n && Number((n[':@'] as XNode)['@_r']) >= FOOTER_START_ROW,
  )
  return [...before, ...newRows, ...after]
}

// ──────────────────────────────────────────────────────────
// 孤立した共有数式子セルの除去
// ──────────────────────────────────────────────────────────

function stripOrphanedSharedFormulaChildren(rows: XNode[]): number {
  const rowWrappers = rows.filter(n => 'row' in n)

  const masterSis = new Set<string>()
  for (const rowWrapper of rowWrappers) {
    for (const cellWrapper of rowWrapper.row as XNode[]) {
      if (!('c' in cellWrapper)) continue
      for (const child of cellWrapper.c as XNode[]) {
        if (!('f' in child)) continue
        const fAttrs = (child[':@'] ?? {}) as XNode
        if (fAttrs['@_ref'] && fAttrs['@_si'] != null) {
          masterSis.add(String(fAttrs['@_si']))
        }
      }
    }
  }

  let removed = 0
  for (const rowWrapper of rowWrappers) {
    for (const cellWrapper of rowWrapper.row as XNode[]) {
      if (!('c' in cellWrapper)) continue
      const before = (cellWrapper.c as XNode[]).length
      cellWrapper.c = (cellWrapper.c as XNode[]).filter(child => {
        if (!('f' in child)) return true
        const fAttrs = (child[':@'] ?? {}) as XNode
        if (fAttrs['@_ref']) return true
        const si = fAttrs['@_si']
        if (si == null) return true
        return masterSis.has(String(si))
      })
      removed += before - (cellWrapper.c as XNode[]).length
    }
  }
  return removed
}

// ──────────────────────────────────────────────────────────
// グループ集計表（B37〜B46 / H37〜H46）
// ──────────────────────────────────────────────────────────

function fillGroupSummaryNodes(rows: XNode[], input: FillInputV2): void {
  const groups = input.groups.slice(0, SUMMARY_ROW_COUNT)

  for (let i = 0; i < SUMMARY_ROW_COUNT; i++) {
    const summaryRow = SUMMARY_ROW_START + i
    const rowWrapper = findRowWrapper(rows, summaryRow)
    if (!rowWrapper) continue

    if (i < groups.length) {
      const total = groups[i].items.reduce((s, it) => s + (it.amount ?? 0), 0)
      setCellString(rowWrapper, 'B', summaryRow, groups[i].label)
      setFormulaCell(rowWrapper, 'H', summaryRow, total)
    } else {
      setCellString(rowWrapper, 'B', summaryRow, '')
      setFormulaCell(rowWrapper, 'H', summaryRow, 0)
    }
  }
}

// ──────────────────────────────────────────────────────────
// フッター合計（H54 / H55 / H57）
// ──────────────────────────────────────────────────────────

function fillFooterTotalsNodes(rows: XNode[], input: FillInputV2): void {
  const subtotal = [
    ...input.groups.flatMap(g => g.items),
    ...input.ungrouped,
  ].reduce((s, it) => s + (it.amount ?? 0), 0)

  const tax        = Math.round(subtotal * input.tax_rate)
  const grandTotal = subtotal + tax

  for (const [rowNum, value] of [[54, subtotal], [55, tax], [57, grandTotal]] as [number, number][]) {
    const rowWrapper = findRowWrapper(rows, rowNum)
    if (rowWrapper) setFormulaCell(rowWrapper, 'H', rowNum, value)
  }
}

// ──────────────────────────────────────────────────────────
// ブロックデータ構築
// ──────────────────────────────────────────────────────────

function buildBlocksWithOverflow(input: FillInputV2): BlockData[] {
  const blocks: BlockData[] = []
  const sortedGroups = [...input.groups].sort((a, b) => a.sort_order - b.sort_order)

  for (const g of sortedGroups) {
    if (g.display_mode === 'lump_sum') {
      blocks.push({
        label:        g.label,
        display_mode: 'lump_sum',
        items:        [],
        total:        g.items.reduce((s, it) => s + (it.amount ?? 0), 0),
      })
    } else if (g.items.length === 0) {
      blocks.push({ label: g.label, display_mode: 'detailed', items: [], total: 0 })
    } else {
      for (let offset = 0; offset < g.items.length; offset += ITEMS_PER_BLOCK) {
        const chunk = g.items.slice(offset, offset + ITEMS_PER_BLOCK)
        blocks.push({
          label:        offset === 0 ? g.label : `${g.label}（続き）`,
          display_mode: 'detailed',
          items:        chunk,
          total:        chunk.reduce((s, it) => s + (it.amount ?? 0), 0),
        })
      }
    }
  }

  if (input.ungrouped.length > 0) {
    const sorted = [...input.ungrouped].sort((a, b) => a.sort_order - b.sort_order)
    for (let offset = 0; offset < sorted.length; offset += ITEMS_PER_BLOCK) {
      const chunk = sorted.slice(offset, offset + ITEMS_PER_BLOCK)
      blocks.push({
        label:        offset === 0 ? '' : '（続き）',
        display_mode: 'detailed',
        items:        chunk,
        total:        chunk.reduce((s, it) => s + (it.amount ?? 0), 0),
      })
    }
  }

  return blocks
}

// ──────────────────────────────────────────────────────────
// 生成 XML の検証
// ──────────────────────────────────────────────────────────

export function validateGeneratedXml(xml: string): void {
  const doc = createParser().parse(xml) as XNode[]
  const sdWrapper = getSheetDataWrapper(doc)
  const rows = sdWrapper.sheetData as XNode[]
  const rowWrappers = rows.filter(n => 'row' in n)

  // ① 行番号の重複チェック
  const rowNums = rowWrappers.map(n => (n[':@'] as XNode)['@_r'] as string)
  const dupes = rowNums.filter((n, i) => rowNums.indexOf(n) !== i)
  if (dupes.length > 0) {
    throw new Error(`[validate] 行番号重複: ${dupes.join(', ')}`)
  }

  // ② データセクションの欠損行チェック（行62〜344が全て存在するか）
  const rowNumSet = new Set(rowNums.map(Number))
  const missingRows: number[] = []
  for (let r = DATA_SECTION_START; r < FOOTER_START_ROW; r++) {
    if (!rowNumSet.has(r)) missingRows.push(r)
  }
  if (missingRows.length > 0) {
    const first = missingRows[0]
    const last  = missingRows[missingRows.length - 1]
    const sample = missingRows.slice(0, 5).join(', ')
    throw new Error(
      `[validate] データセクションに欠損行があります: ${missingRows.length}行 ` +
      `(${first}〜${last}, 例: ${sample}${missingRows.length > 5 ? '...' : ''})`,
    )
  }

  // ③・④ 全行に対して: 数式残存（データ行のみ）・<v> 二重を一括チェック
  // ⑤ 共有数式整合性チェック用データ収集
  const sharedMasterSis = new Map<string, string>()
  const sharedChildSis  = new Map<string, string[]>()

  for (const rowWrapper of rowWrappers) {
    const rowNum  = (rowWrapper[':@'] as XNode)['@_r'] as string
    const rowN    = Number(rowNum)
    const isDataRow = rowN >= DATA_SECTION_START && rowN < FOOTER_START_ROW

    for (const cellWrapper of rowWrapper.row as XNode[]) {
      if (!('c' in cellWrapper)) continue
      const children = cellWrapper.c as XNode[]
      const cellRef  = (cellWrapper[':@'] as XNode)['@_r'] as string

      if (isDataRow && children.some(ch => 'f' in ch)) {
        throw new Error(`[validate] 数式が残っています: 行${rowNum} セル${cellRef}`)
      }

      const vCount = children.filter(ch => 'v' in ch).length
      if (vCount > 1) {
        throw new Error(`[validate] <v> ノード二重: 行${rowNum} セル${cellRef} (${vCount}個)`)
      }

      for (const child of children) {
        if (!('f' in child)) continue
        const fAttrs = (child[':@'] ?? {}) as XNode
        const si = String(fAttrs['@_si'] ?? '')
        if (!si) continue
        if (fAttrs['@_ref']) {
          sharedMasterSis.set(si, cellRef)
        } else {
          if (!sharedChildSis.has(si)) sharedChildSis.set(si, [])
          sharedChildSis.get(si)!.push(cellRef)
        }
      }
    }
  }

  // ⑤ 孤立した共有数式子セルの検出
  const orphanSis: string[] = []
  for (const [si, childCells] of sharedChildSis) {
    if (!sharedMasterSis.has(si)) {
      orphanSis.push(`si=${si}(${childCells.length}件, 例:${childCells[0]})`)
    }
  }
  if (orphanSis.length > 0) {
    throw new Error(
      `[validate] 孤立した共有数式子セル（マスターなし）: ${orphanSis.slice(0, 5).join(', ')}` +
      (orphanSis.length > 5 ? ` ... 他${orphanSis.length - 5}種類` : ''),
    )
  }
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
  const xmlString = await sheetEntry.async('string')

  // ① パース（1回だけ）
  const doc = createParser().parse(xmlString) as XNode[]

  const wsWrapper = doc.find(n => 'worksheet' in n) as XNode
  const sdWrapper = (wsWrapper.worksheet as XNode[]).find(n => 'sheetData' in n) as XNode

  // ② テンプレート行一覧を取得
  const allRows: XNode[] = sdWrapper.sheetData as XNode[]

  // ③ ブロック0のSUM行・区切り行シードを取得
  const seedSumRowNum = SEED_HEADER_ROW + SUM_OFFSET  // row 82
  const seedSumWrapper = findRowWrapper(allRows, seedSumRowNum)
  if (!seedSumWrapper) throw new Error(`テンプレートにSUM行(${seedSumRowNum})が見つかりません`)

  const seedSepWrappers: XNode[] = []
  for (let si = 0; si < SEP_COUNT; si++) {
    const r = seedSumRowNum + 1 + si  // rows 83〜87
    const w = findRowWrapper(allRows, r)
    if (!w) throw new Error(`テンプレートに区切り行(${r})が見つかりません`)
    seedSepWrappers.push(w)
  }

  // ④ ブロック別データを構築（19項目超えは次ブロックへ繰り越し）
  const blockDataList = buildBlocksWithOverflow(input)

  // ⑤ データセクション全行を生成（行62〜344 = 283行）
  //    ブロック0〜9: 各26行（ヘッダー1 + 明細19 + SUM1 + 区切り5）
  //    ブロック10: 23行（ヘッダー1 + 明細19 + SUM1 + 区切り2）
  const newRows: XNode[] = []

  for (let blockN = 0; blockN < NUM_BLOCKS; blockN++) {
    const blockBase    = SEED_HEADER_ROW + blockN * BLOCK_INTERVAL  // 62 + N*26
    const blockSumRow  = blockBase + SUM_OFFSET                     // 82 + N*26
    const blockSepBase = blockSumRow + 1                            // 83 + N*26
    const blockData    = blockDataList[blockN] ?? null

    // ─ ヘッダー行 ─
    const templateHeader = findRowWrapper(allRows, blockBase)
    if (!templateHeader) throw new Error(`テンプレートにブロック${blockN}のヘッダー行(${blockBase})が見つかりません`)
    const headerNode = cloneRowNode(templateHeader, blockBase)
    clearCellNode(headerNode, 'A', blockBase)
    if (blockData) {
      setCellString(headerNode, 'B', blockBase, blockData.label)
      // 参考準拠：グループ見出し行には合計を表示しない
      clearCellNode(headerNode, 'H', blockBase)
    } else {
      clearCellNode(headerNode, 'B', blockBase)
      clearCellNode(headerNode, 'H', blockBase)
    }
    newRows.push(headerNode)

    // ─ 明細行（19スロット）─
    const items = blockData?.display_mode === 'detailed' ? blockData.items : []
    for (let slot = 0; slot < ITEMS_PER_BLOCK; slot++) {
      const rowNum = blockBase + 1 + slot
      const templateItem = findRowWrapper(allRows, rowNum)
      if (!templateItem) throw new Error(`テンプレートに明細行(${rowNum})が見つかりません`)
      const itemNode = cloneRowNode(templateItem, rowNum)

      if (slot < items.length) {
        const item = items[slot]
        setCellString(itemNode, 'C', rowNum, item.name)
        setCellNumber(itemNode, 'E', rowNum, item.quantity)
        setCellString(itemNode, 'F', rowNum, item.unit)
        // 参考準拠：数量=1のとき単価欄は空白（金額と同じ値になるため不要）
        if (item.selling_price != null && item.quantity > 1) {
          setCellNumber(itemNode, 'G', rowNum, item.selling_price)
        } else {
          clearCellNode(itemNode, 'G', rowNum)
        }
        setCellNumber(itemNode, 'H', rowNum, item.amount ?? 0)
        const memo = extractMemoContent(item.memo)
        if (memo) setCellString(itemNode, 'J', rowNum, memo)
        else       clearCellNode(itemNode, 'J', rowNum)
      } else {
        // 未使用スロット: 表示列をクリア
        clearCellNode(itemNode, 'C', rowNum)
        clearCellNode(itemNode, 'E', rowNum)
        clearCellNode(itemNode, 'F', rowNum)
        clearCellNode(itemNode, 'G', rowNum)
        clearCellNode(itemNode, 'H', rowNum)
        clearCellNode(itemNode, 'J', rowNum)
      }
      newRows.push(itemNode)
    }

    // ─ SUM行（ブロック0のシードを使用、数式は除去済み）─
    // H列のSUM数式は除去されるため、グループ合計を静的値として書き込む
    const sumNode = cloneRowNode(seedSumWrapper, blockSumRow)
    setCellNumber(sumNode, 'H', blockSumRow, blockData ? blockData.total : 0)
    newRows.push(sumNode)

    // ─ 区切り行（完全ブロック: 5行、ブロック10: 2行）─
    for (let si = 0; si < SEP_COUNT; si++) {
      const sepRowNum = blockSepBase + si
      if (sepRowNum >= FOOTER_START_ROW) break  // ブロック10の3〜5行目はフッター保持エリア
      const sepNode = cloneRowNode(seedSepWrappers[si], sepRowNum)
      newRows.push(sepNode)
    }
  }

  // ⑥ データセクションを置換してドキュメントに反映
  sdWrapper.sheetData = replaceDataSectionNodes(allRows, newRows)
  const updatedRows = sdWrapper.sheetData as XNode[]

  // ⑦ 孤立した共有数式子セルを除去
  //    テンプレートのマスターが削除された後もフッター側の子セルが残るケースを対処
  stripOrphanedSharedFormulaChildren(updatedRows)

  // ⑧ グループ集計表（B37〜B46 / H37〜H46）
  fillGroupSummaryNodes(updatedRows, input)

  // ⑨ フッター合計（H54 / H55 / H57）
  fillFooterTotalsNodes(updatedRows, input)

  // ⑩ シリアライズ（1回だけ）
  const newXml = createBuilder().build(doc)

  // ⑪ 構造検証
  validateGeneratedXml(newXml)

  // ⑫ ZIP に書き戻し
  zip.remove(CALC_CHAIN_PATH)
  zip.file(SHEET_PATH, newXml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer

  return { buffer, warnings }
}
