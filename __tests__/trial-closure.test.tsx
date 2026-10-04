import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { formatEstimateValidity } from '@/lib/estimate/validity'

const read = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8')

// ── 見積書の有効期間：現在日を推測しない ─────────────────────────────────
describe('見積有効期間：固定の起算日（estimate_valid_from）のみから作る', () => {
  it('起算日あり → 起算日〜N ヶ月後', () => {
    expect(formatEstimateValidity('2026-09-15', 1)).toBe('2026年9月15日 〜 2026年10月15日（1ヶ月）')
    expect(formatEstimateValidity('2026-11-30T00:00:00+09:00', 3)).toBe('2026年11月30日 〜 2027年3月2日（3ヶ月）')
  })

  it('起算日なし・不正値・期間なし → null（画面は「—」、今日の日付で埋めない）', () => {
    expect(formatEstimateValidity(null, 1)).toBeNull()
    expect(formatEstimateValidity(undefined, 1)).toBeNull()
    expect(formatEstimateValidity('', 1)).toBeNull()
    expect(formatEstimateValidity('not-a-date', 1)).toBeNull()
    expect(formatEstimateValidity('2026-09-15', null)).toBeNull()
    expect(formatEstimateValidity('2026-09-15', 0)).toBeNull()
  })

  it('同じ入力なら何度呼んでも同じ結果（表示日で変わらない）', () => {
    expect(formatEstimateValidity('2026-01-31', 1)).toBe(formatEstimateValidity('2026-01-31', 1))
  })

  it('EstimateDocument は new Date() にフォールバックしない', () => {
    const src = read('components/estimate/EstimateDocument.tsx')
    expect(src).not.toMatch(/new Date\(\s*\)/)
    expect(src).toContain('formatEstimateValidity(')
  })
})

// ── Action Honesty ────────────────────────────────────────────────────
describe('Action Honesty：見積画面の請求書ボタンは「開く」', () => {
  it('「請求書を作成」ではなく「請求書を開く」（タブを開くだけで作成しない）', () => {
    const src = read('components/projects/EstimateTab.tsx')
    expect(src).not.toContain('請求書を作成')
    expect(src).toContain('請求書を開く')
  })
})

// ── スマホの案件内ナビ ────────────────────────────────────────────────
describe('スマホ：案件内の画面へ既存タブで移動できる', () => {
  const src = read('components/projects/ProjectTabs.tsx')

  it('lg 未満のみ表示・印刷時は非表示', () => {
    expect(src).toMatch(/className="lg:hidden no-print"/)
  })

  it('見積・原価・工程・基本情報を持つ', () => {
    for (const label of ['基本情報', '見積', '原価台帳', '工程表']) expect(src).toContain(`'${label}'`)
  })

  it('請求タブは legacy 請求が使える会社だけ（invoiceAvailable）', () => {
    expect(src).toMatch(/TABS\.filter\(t => t\.id !== 'invoice' \|\| invoiceAvailable\)/)
  })
})

// ── 原価台帳：受注金額の根拠 ──────────────────────────────────────────
describe('原価台帳：受注金額の出どころを表示（計算は変更しない）', () => {
  it('見積明細合計 or 入力済み契約金額を説明する', () => {
    const src = read('components/projects/CostLedgerTab.tsx')
    expect(src).toContain('見積明細の合計（諸経費・値引前）')
    expect(src).toContain('入力済みの契約金額')
  })
})

// ── 案件を開く間の表示 ───────────────────────────────────────────────
describe('案件を開く間のローディング表示', () => {
  it('loading.tsx がある', () => {
    expect(existsSync(path.join(process.cwd(), 'app/(dashboard)/projects/[id]/loading.tsx'))).toBe(true)
    expect(read('app/(dashboard)/projects/[id]/loading.tsx')).toContain('案件を開いています')
  })
})
