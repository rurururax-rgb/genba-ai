import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { clipInsertionLine, intersectBoxes, type Box } from '@/lib/estimate/insertion-line'

// 本番で計測した 1347px 幅の配置：サイドバー 0–80 / テーブル 93–1334
const TABLE: Box = { left: 93, right: 1334, top: 120, bottom: 694 }

function inside(line: { left: number; width: number; top: number; height: number }, b: Box) {
  return line.left >= b.left && line.left + line.width <= b.right
    && line.top >= b.top && line.top + line.height <= b.bottom
}

describe('見積エディタ 挿入ライン：テーブルの表示範囲内だけに描く', () => {
  it('行がテーブルより広くても（横スクロール時）左右はテーブル境界で切る', () => {
    const line = clipInsertionLine({ left: 93 - 400, right: 93 - 400 + 1900 }, 300, TABLE)!
    expect(line).toEqual({ left: 93, width: 1334 - 93, top: 298, height: 4 })
    expect(inside(line, TABLE)).toBe(true)
  })

  it('サイドバー側（x < 93）や画面右端へはみ出さない', () => {
    const line = clipInsertionLine({ left: 0, right: 1347 }, 400, TABLE)!
    expect(line.left).toBe(93)
    expect(line.left + line.width).toBe(1334)
  })

  it('行が表示範囲内ならその幅のまま', () => {
    expect(clipInsertionLine({ left: 200, right: 900 }, 400, TABLE)).toEqual({ left: 200, width: 700, top: 398, height: 4 })
  })

  it('y が表示範囲の上下外なら非表示（sticky ツールバーの裏・画面外の行）', () => {
    expect(clipInsertionLine({ left: 93, right: 1334 }, 119, TABLE)).toBeNull()
    expect(clipInsertionLine({ left: 93, right: 1334 }, 695, TABLE)).toBeNull()
  })

  it('境界ちょうどの y でもラインの太さ分が範囲外に出ない', () => {
    expect(inside(clipInsertionLine({ left: 93, right: 1334 }, 120, TABLE)!, TABLE)).toBe(true)
    expect(inside(clipInsertionLine({ left: 93, right: 1334 }, 694, TABLE)!, TABLE)).toBe(true)
  })

  it('行が横方向に完全に表示範囲外・表示範囲なしなら非表示', () => {
    expect(clipInsertionLine({ left: 1400, right: 1600 }, 300, TABLE)).toBeNull()
    expect(clipInsertionLine({ left: 93, right: 1334 }, 300, null)).toBeNull()
  })

  it('表示範囲 = テーブル ∩ スクロール領域 ∩ sticky ツールバーより下', () => {
    const table   = { left: 93, right: 1334, top: -400, bottom: 926 }  // ページが下へスクロール済み
    const main    = { left: 80, right: 1347, top: 0, bottom: 694 }
    const belowTb = { left: -Infinity, right: Infinity, top: 120, bottom: Infinity }
    expect(intersectBoxes(table, main, belowTb)).toEqual({ left: 93, right: 1334, top: 120, bottom: 694 })
    expect(intersectBoxes(table, { left: 0, right: 50, top: 0, bottom: 10 })).toBeNull()
  })

  it('EstimateTab はラインを viewport 全幅（left: 0 / right: 0）で描かない', () => {
    const src = readFileSync(path.join(process.cwd(), 'components/projects/EstimateTab.tsx'), 'utf8')
    const at = src.indexOf('data-testid="estimate-insertion-line"')
    expect(at).toBeGreaterThan(0)
    const block = src.slice(at - 600, at + 600)
    expect(block).not.toMatch(/right:\s*0/)
    expect(src).toContain('clipInsertionLine(')
  })
})
