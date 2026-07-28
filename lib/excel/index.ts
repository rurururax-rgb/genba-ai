import ExcelJS from 'exceljs'
import { groupByCategory } from '@/lib/estimate/categories'

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

export type ExcelProject = {
  name: string
  customer_name: string | null
  site_address:  string | null
  company_name:  string
}

export type ExcelItem = {
  name:          string
  quantity:      number
  unit:          string
  selling_price: number | null
  amount:        number | null
  category:      string | null
  memo:          string | null
}

// ──────────────────────────────────────────────────────────
// 共通スタイル定数
// ──────────────────────────────────────────────────────────

const THIN   = { style: 'thin'   as const }
const MEDIUM = { style: 'medium' as const }

const BORDER_ALL: Partial<ExcelJS.Borders> = {
  top: THIN, left: THIN, bottom: THIN, right: THIN,
}
const BORDER_MEDIUM: Partial<ExcelJS.Borders> = {
  top: MEDIUM, left: MEDIUM, bottom: MEDIUM, right: MEDIUM,
}

const FILL_HEADER: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' },
}
const FILL_TOTAL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3B3' },
}

const AMT_FMT  = '#,##0'
const QTY_FMT  = '#,##0.##'  // 小数2桁まで（整数なら小数点不表示）

// Excel のシート名禁止文字を除去し 31 文字以内に収める
function safeSheetName(name: string): string {
  return name.replace(/[/\\?*[\]]/g, '').slice(0, 31)
}

// ──────────────────────────────────────────────────────────
// メイン関数
// ──────────────────────────────────────────────────────────

export async function generateEstimateExcel(
  project: ExcelProject,
  items: ExcelItem[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator  = 'genba-ai'
  wb.created  = new Date()
  wb.modified = new Date()

  // category ごとにグループ化（CATEGORY_ORDER 順・共通ロジック）
  const groups     = groupByCategory(items, (i) => i.category)
  const categories = [...groups.keys()]

  // Sheet 1: 表紙
  buildCoverSheet(wb, project)

  // Sheet 2+: 工種別
  const subtotals: { category: string; value: number }[] = []
  categories.forEach((cat, idx) => {
    const sub = buildCategorySheet(wb, idx + 1, cat, groups.get(cat)!)
    subtotals.push({ category: cat, value: sub })
  })

  // 最終シート: 合計
  buildTotalSheet(wb, project, subtotals)

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>
}

// ──────────────────────────────────────────────────────────
// Sheet 1: 表紙
// ──────────────────────────────────────────────────────────

function buildCoverSheet(wb: ExcelJS.Workbook, project: ExcelProject) {
  const ws = wb.addWorksheet('表紙')
  ws.columns = [{ width: 22 }, { width: 36 }]

  const today    = new Date()
  const validity = new Date(today)
  validity.setDate(validity.getDate() + 30)
  const fmt = (d: Date) =>
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`

  // タイトル
  ws.mergeCells('A1:B1')
  const title = ws.getCell('A1')
  title.value     = '内　訳　明　細　書'
  title.font      = { bold: true, size: 18 }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 36

  ws.addRow([])

  const addField = (label: string, value: string | null) => {
    const row = ws.addRow([label, value ?? ''])
    row.getCell(1).font      = { bold: true }
    row.getCell(1).fill      = FILL_HEADER
    row.getCell(1).border    = BORDER_ALL
    row.getCell(2).border    = BORDER_ALL
    row.getCell(2).alignment = { wrapText: true }
    row.height = 20
  }

  addField('工事名',       project.name)
  addField('工事場所',     project.site_address)
  addField('施主名',       project.customer_name)
  addField('施工会社',     project.company_name)
  addField('見積日',       fmt(today))
  addField('見積有効期間', `${fmt(validity)} まで`)

  ws.addRow([])
  const note = ws.addRow(['', '※ 工種別の明細は各シートをご参照ください'])
  note.getCell(2).font      = { italic: true, color: { argb: 'FF666666' } }
  note.getCell(2).alignment = { horizontal: 'left' }
}

// ──────────────────────────────────────────────────────────
// Sheet 2+: 工種別明細
// ──────────────────────────────────────────────────────────

// 戻り値: この工種の小計（数値）
function buildCategorySheet(
  wb:       ExcelJS.Workbook,
  sheetNo:  number,
  category: string,
  items:    ExcelItem[],
): number {
  const ws = wb.addWorksheet(safeSheetName(`${sheetNo}. ${category}`))

  ws.columns = [
    { width: 5,  key: 'no'    },  // A: No.
    { width: 30, key: 'name'  },  // B: 呼称
    { width: 8,  key: 'qty'   },  // C: 数量
    { width: 6,  key: 'unit'  },  // D: 単位
    { width: 14, key: 'price' },  // E: 単価
    { width: 14, key: 'amt'   },  // F: 金額
    { width: 14, key: 'list'  },  // G: 定価（空欄）
    { width: 22, key: 'memo'  },  // H: 備考
  ]

  // Row 1: タイトル
  ws.mergeCells('A1:H1')
  const titleCell    = ws.getCell('A1')
  titleCell.value     = `${sheetNo}. ${category}`
  titleCell.font      = { bold: true, size: 13 }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleCell.border    = BORDER_MEDIUM
  ws.getRow(1).height = 24

  // Row 2: ヘッダー
  const HDR = ['No.', '呼称（品名）', '数量', '単位', '単価', '金額', '定価', '備考']
  const hRow = ws.addRow(HDR)
  hRow.eachCell((cell) => {
    cell.font      = { bold: true }
    cell.fill      = FILL_HEADER
    cell.border    = BORDER_ALL
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  hRow.height = 20

  // Row 3+: 明細
  const DATA_START = 3
  let subtotal = 0
  items.forEach((item, idx) => {
    const row = ws.addRow([
      idx + 1,
      item.name,
      item.quantity,
      item.unit,
      item.selling_price ?? '',
      item.amount        ?? '',  // DB GENERATED の値をそのまま転記
      '',                        // 定価: 手動入力用に空欄
      item.memo ?? '',
    ])

    row.getCell('A').alignment = { horizontal: 'center' }
    row.getCell('C').alignment = { horizontal: 'right' }
    row.getCell('D').alignment = { horizontal: 'center' }
    row.getCell('E').alignment = { horizontal: 'right' }
    row.getCell('F').alignment = { horizontal: 'right' }
    row.getCell('G').alignment = { horizontal: 'right' }
    row.getCell('H').alignment = { wrapText: true }

    row.getCell('C').numFmt = QTY_FMT
    row.getCell('E').numFmt = AMT_FMT
    row.getCell('F').numFmt = AMT_FMT
    row.getCell('G').numFmt = AMT_FMT

    row.eachCell((cell) => { cell.border = BORDER_ALL })

    subtotal += item.amount ?? 0
  })

  // 小計行（SUM 式で Excel 上も再計算される）
  const lastDataRow = DATA_START + items.length - 1
  const subRow = ws.addRow([
    '', '小　計', '', '', '',
    { formula: `SUM(F${DATA_START}:F${lastDataRow})` },
    '', '',
  ])
  subRow.getCell('B').font      = { bold: true }
  subRow.getCell('B').alignment = { horizontal: 'right' }
  subRow.getCell('F').font      = { bold: true }
  subRow.getCell('F').numFmt    = AMT_FMT
  subRow.getCell('F').alignment = { horizontal: 'right' }
  subRow.getCell('F').fill      = FILL_TOTAL
  subRow.eachCell((cell) => { cell.border = BORDER_ALL })

  return subtotal
}

// ──────────────────────────────────────────────────────────
// 最終シート: 合計
// ──────────────────────────────────────────────────────────

function buildTotalSheet(
  wb:        ExcelJS.Workbook,
  project:   ExcelProject,
  subtotals: { category: string; value: number }[],
) {
  const ws = wb.addWorksheet('合計')
  ws.columns = [{ width: 26 }, { width: 18 }]

  // タイトル
  ws.mergeCells('A1:B1')
  const title    = ws.getCell('A1')
  title.value     = '工種別合計'
  title.font      = { bold: true, size: 13 }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  title.border    = BORDER_MEDIUM
  ws.getRow(1).height = 24

  // ヘッダー
  const hRow = ws.addRow(['工　種', '金　額'])
  hRow.eachCell((cell) => {
    cell.font      = { bold: true }
    cell.fill      = FILL_HEADER
    cell.border    = BORDER_ALL
    cell.alignment = { horizontal: 'center' }
  })

  // 工種別小計行（値を直接記入）
  const DATA_START = 3
  subtotals.forEach(({ category, value }) => {
    const row = ws.addRow([category, value])
    row.getCell('B').numFmt    = AMT_FMT
    row.getCell('B').alignment = { horizontal: 'right' }
    row.eachCell((cell) => { cell.border = BORDER_ALL })
  })

  const DATA_END   = DATA_START + subtotals.length - 1
  const TOTAL_ROW  = DATA_END   + 1
  const KEIHI_ROW  = TOTAL_ROW  + 1
  const DISC_ROW   = KEIHI_ROW  + 1
  const TAX_ROW    = DISC_ROW   + 1
  const GRAND_ROW  = TAX_ROW    + 1

  // 合計（SUM 式）
  const totalRow = ws.addRow([
    '合　計',
    { formula: `SUM(B${DATA_START}:B${DATA_END})` },
  ])
  totalRow.getCell('A').font      = { bold: true }
  totalRow.getCell('B').font      = { bold: true }
  totalRow.getCell('B').numFmt    = AMT_FMT
  totalRow.getCell('B').alignment = { horizontal: 'right' }
  totalRow.eachCell((c) => { c.border = BORDER_ALL })

  // 諸経費（空欄・手動入力）
  const kRow = ws.addRow(['諸経費', ''])
  kRow.getCell('B').numFmt    = AMT_FMT
  kRow.getCell('B').alignment = { horizontal: 'right' }
  kRow.eachCell((c) => { c.border = BORDER_ALL })

  // 端数値引（空欄・手動入力）
  const dRow = ws.addRow(['端数値引', ''])
  dRow.getCell('B').numFmt    = AMT_FMT
  dRow.getCell('B').alignment = { horizontal: 'right' }
  dRow.eachCell((c) => { c.border = BORDER_ALL })

  // 消費税（10%固定・式）
  const taxRow = ws.addRow([
    '消費税（10%）',
    { formula: `ROUND(B${TOTAL_ROW}*0.1,0)` },
  ])
  taxRow.getCell('B').numFmt    = AMT_FMT
  taxRow.getCell('B').alignment = { horizontal: 'right' }
  taxRow.eachCell((c) => { c.border = BORDER_ALL })

  // 総合計（合計 + 諸経費 - 端数値引 + 消費税、空欄セルは 0 扱い）
  const grandRow = ws.addRow([
    '総合計（税込）',
    {
      formula:
        `B${TOTAL_ROW}` +
        `+IF(B${KEIHI_ROW}="",0,B${KEIHI_ROW})` +
        `-IF(B${DISC_ROW}="",0,B${DISC_ROW})` +
        `+B${TAX_ROW}`,
    },
  ])
  grandRow.getCell('A').font      = { bold: true, size: 12 }
  grandRow.getCell('B').font      = { bold: true, size: 12 }
  grandRow.getCell('B').numFmt    = AMT_FMT
  grandRow.getCell('B').alignment = { horizontal: 'right' }
  grandRow.getCell('A').fill      = FILL_TOTAL
  grandRow.getCell('B').fill      = FILL_TOTAL
  grandRow.eachCell((c) => {
    c.border = BORDER_MEDIUM
  })
  ws.getRow(GRAND_ROW).height = 22

  // 工事名・施主名を下部に添える
  ws.addRow([])
  ws.addRow(['工事名',   project.name])
  ws.addRow(['施主名',   project.customer_name  ?? ''])
  ws.addRow(['工事場所', project.site_address    ?? ''])
  ws.addRow(['施工会社', project.company_name])
}
