/**
 * lib/excel/fill-spec-sheet.ts
 *
 * 仕様書大／中テンプレートに、AI抽出データを書き込んで返す。
 *
 * ■ テンプレート構造（estimate-template.xlsx）
 *   仕様書大: 3列グループ × 3ブロック = 9部屋
 *   仕様書中: 2列グループ × 3ブロック = 6部屋
 *
 * ■ 部屋ブロック（各20行）
 *   ブロック1: 開始行 7  (玄関・ホール / トイレ      / 洋室②)
 *   ブロック2: 開始行 27 (LDK           / 廊下        / 洋室③)
 *   ブロック3: 開始行 47 (洗面室         / 洋室①     / 洋室④)
 *
 * ■ 部位 × 行オフセット
 *   天井=0, 壁=2, 床=4, 廻り縁=6, 巾木=8, 建具=10, 照明器具=12, 住宅設備=14, 他=16
 *   ※ LDK は住宅設備が2行（キッチン=14, カップボード=16）、他=18
 *
 * ■ 列グループ
 *   Bグループ: 仕様=D, メーカー=E, 品番=H
 *   Jグループ: 仕様=L, メーカー=M, 品番=P
 *   Rグループ: 仕様=T, メーカー=U, 品番=X  (大のみ)
 */

import ExcelJS from 'exceljs'
import path from 'path'
import { readFile } from 'node:fs/promises'
import type { SpecDetailResult } from '@/app/api/ai/extract-spec-detail/route'

export type SheetType = '大' | '中'

// ── 部屋マッピング ─────────────────────────────────────────

type RoomDef = {
  startRow: number
  specCol:  string
  makerCol: string
  productCol: string
  isLDK?: boolean
}

const ROOM_MAP_LARGE: Record<string, RoomDef> = {
  '玄関・ホール': { startRow: 7,  specCol: 'D', makerCol: 'E', productCol: 'H' },
  'トイレ':       { startRow: 7,  specCol: 'L', makerCol: 'M', productCol: 'P' },
  '洋室②':       { startRow: 7,  specCol: 'T', makerCol: 'U', productCol: 'X' },
  'LDK':          { startRow: 27, specCol: 'D', makerCol: 'E', productCol: 'H', isLDK: true },
  '廊下':         { startRow: 27, specCol: 'L', makerCol: 'M', productCol: 'P' },
  '洋室③':       { startRow: 27, specCol: 'T', makerCol: 'U', productCol: 'X' },
  '洗面室':       { startRow: 47, specCol: 'D', makerCol: 'E', productCol: 'H' },
  '洋室①':       { startRow: 47, specCol: 'L', makerCol: 'M', productCol: 'P' },
  '洋室④':       { startRow: 47, specCol: 'T', makerCol: 'U', productCol: 'X' },
}

const ROOM_MAP_MEDIUM: Record<string, RoomDef> = {
  '玄関・ホール': { startRow: 7,  specCol: 'D', makerCol: 'E', productCol: 'H' },
  'トイレ':       { startRow: 7,  specCol: 'L', makerCol: 'M', productCol: 'P' },
  'LDK':          { startRow: 27, specCol: 'D', makerCol: 'E', productCol: 'H', isLDK: true },
  '廊下':         { startRow: 27, specCol: 'L', makerCol: 'M', productCol: 'P' },
  '洗面室':       { startRow: 47, specCol: 'D', makerCol: 'E', productCol: 'H' },
  '洋室①':       { startRow: 47, specCol: 'L', makerCol: 'M', productCol: 'P' },
}

// ── 部位 × 行オフセット ────────────────────────────────────

// 通常の部屋
const PART_ROW_OFFSET: Record<string, number> = {
  '天井':     0,
  '壁':       2,
  '床':       4,
  '廻り縁':   6,
  '巾木':     8,
  '建具':    10,
  '照明器具':12,
  '住宅設備':14,
  '他':      16,
}

// LDK は住宅設備が2行あるため専用マッピング
const PART_ROW_OFFSET_LDK: Record<string, number> = {
  '天井':     0,
  '壁':       2,
  '床':       4,
  '廻り縁':   6,
  '巾木':     8,
  '建具':    10,
  '照明器具':12,
  '住宅設備':14, // キッチン
  '他':      18,
}

// ── メイン関数 ─────────────────────────────────────────────

export async function fillSpecSheet(
  data: SpecDetailResult,
  sheetType: SheetType,
): Promise<Buffer> {
  const templatePath = path.join(process.cwd(), 'templates', 'estimate-template.xlsx')
  const templateBuf  = await readFile(templatePath)

  const wb = new ExcelJS.Workbook()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(templateBuf as any)

  const sheetName = sheetType === '大' ? '仕様書大' : '仕様書　中'
  const ws = wb.getWorksheet(sheetName)
  if (!ws) throw new Error(`シート「${sheetName}」が見つかりません`)

  const roomMap = sheetType === '大' ? ROOM_MAP_LARGE : ROOM_MAP_MEDIUM

  for (const roomData of data.rooms) {
    const def = roomMap[roomData.room_name]
    if (!def) continue // テンプレートにない部屋はスキップ

    const offsetMap = def.isLDK ? PART_ROW_OFFSET_LDK : PART_ROW_OFFSET

    for (const partData of roomData.parts) {
      const offset = offsetMap[partData.part]
      if (offset === undefined) continue // 未知の部位はスキップ

      const row = def.startRow + offset

      if (partData.spec    != null) writeCell(ws, def.specCol,     row, partData.spec)
      if (partData.maker   != null) writeCell(ws, def.makerCol,    row, partData.maker)
      if (partData.product != null) writeCell(ws, def.productCol,  row, partData.product)
    }
  }

  const buf = await wb.xlsx.writeBuffer()
  return buf as unknown as Buffer
}

// ── ヘルパー：セルに値を書き込む（スタイルを保持したまま）──

function writeCell(ws: ExcelJS.Worksheet, col: string, row: number, value: string) {
  const cell = ws.getCell(`${col}${row}`)
  cell.value = value
}

// ── テンプレートの部屋一覧をエクスポート（UIで使用）──────

export function getAvailableRooms(sheetType: SheetType): string[] {
  const map = sheetType === '大' ? ROOM_MAP_LARGE : ROOM_MAP_MEDIUM
  return Object.keys(map)
}

export const ALL_PARTS = Object.keys(PART_ROW_OFFSET)
