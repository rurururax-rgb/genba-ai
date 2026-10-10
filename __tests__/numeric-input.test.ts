import { describe, it, expect } from 'vitest'
import {
  normalizeNumberDraft, numberDraftValue, parseNumericInput, resolveNumericCommit, syncNumberDraft,
} from '@/lib/input/numeric-input'

describe('parseNumericInput', () => {
  const valid: Array<[string, number]> = [
    ['12345', 12345],
    ['１２３４５', 12345],
    ['145,000', 145000],
    ['¥145,000', 145000],
    ['￥１４５，０００', 145000],
    ['145,000円', 145000],
    ['1,234,567', 1234567],
    ['12 000', 12000],
    [' 300 ', 300],
    ['0', 0],
    ['０', 0],
    ['1.5', 1.5],
    ['１．５', 1.5],
    ['.5', 0.5],
    ['1.', 1],
    ['-500', -500],
    ['−500', -500],
    ['ー５００', -500],
    ['－1,000', -1000],
    ['-20%', -20],
    ['37.5％', 37.5],
    ['×1.45', 1.45],
  ]
  it.each(valid)('%s → %s', (input, expected) => {
    expect(parseNumericInput(input)).toBe(expected)
  })

  const invalid = ['', '   ', '-', '.', 'abc', '12abc', 'abc12', '1e5', '1.2.3', '1-2', '--5', 'NaN', 'Infinity', '０ｘ１０', '十万', '１２３あ']
  it.each(invalid)('解釈できない入力 %j は null（0 や NaN にしない）', input => {
    expect(parseNumericInput(input)).toBeNull()
  })

  it('以前の parseFloat の誤動作を再現しない（145,000 が 145 にならない）', () => {
    expect(parseFloat('145,000')).toBe(145)          // 旧挙動
    expect(parseNumericInput('145,000')).toBe(145000) // 新挙動
  })
})

describe('resolveNumericCommit（数値セルの確定時の扱い）', () => {
  it('空欄 → clear（値を消す意図）', () => {
    expect(resolveNumericCommit('')).toEqual({ action: 'clear' })
    expect(resolveNumericCommit('   ')).toEqual({ action: 'clear' })
  })

  it('解釈できる値 → save', () => {
    expect(resolveNumericCommit('￥１４５，０００')).toEqual({ action: 'save', value: 145000 })
    expect(resolveNumericCommit('0')).toEqual({ action: 'save', value: 0 })
    expect(resolveNumericCommit('-500')).toEqual({ action: 'save', value: -500 })
  })

  it('解釈できない値 → revert（保存しない・空欄にもしない）', () => {
    expect(resolveNumericCommit('abc')).toEqual({ action: 'revert' })
    expect(resolveNumericCommit('12abc')).toEqual({ action: 'revert' })
    expect(resolveNumericCommit('1e5')).toEqual({ action: 'revert' })
  })
})

describe('normalizeNumberDraft（type="number" の入力中の文字列）', () => {
  const cases: Array<[string, string]> = [
    ['01000', '1000'],
    ['001000', '1000'],
    ['01', '1'],
    ['00', '0'],
    ['0', '0'],
    ['', ''],
    ['1000', '1000'],
    ['1050', '1050'],
    ['0.5', '0.5'],
    ['00.5', '0.5'],
    ['-05', '-5'],
    ['-0', '-0'],
    ['-', '-'],
  ]
  it.each(cases)('%j → %j', (raw, expected) => {
    expect(normalizeNumberDraft(raw)).toBe(expected)
  })
})

describe('numberDraftValue / syncNumberDraft', () => {
  it('空欄は 0、それ以外は数値', () => {
    expect(numberDraftValue('')).toBe(0)
    expect(numberDraftValue('0')).toBe(0)
    expect(numberDraftValue('1000')).toBe(1000)
    expect(numberDraftValue('-500')).toBe(-500)
    expect(numberDraftValue('0.5')).toBe(0.5)
  })

  it('draft が値を表していれば入力中の文字列を残し、違えば値に合わせる', () => {
    expect(syncNumberDraft('', 0)).toBe('')        // 全消去の途中（値は 0）
    expect(syncNumberDraft('1000', 1000)).toBe('1000')
    expect(syncNumberDraft('1000', 250000)).toBe('250000') // 支払種別の自動入力
    expect(syncNumberDraft('', 1000)).toBe('1000')
  })

  /** NumberDraftInput と同じ手順: DOM の文字列 → 正規化した draft と確定値 */
  const type = (domValues: string[]) => domValues.map(raw => {
    const draft = normalizeNumberDraft(raw)
    return { draft, value: numberDraftValue(draft) }
  })

  it('初期値 0 に続けて 1000 と打つと、表示は 1000（01000 にならない）', () => {
    // 0 の後ろにカーソル → 1, 0, 0, 0 を順に入力
    expect(type(['01', '10', '100', '1000'])).toEqual([
      { draft: '1', value: 1 }, { draft: '10', value: 10 }, { draft: '100', value: 100 }, { draft: '1000', value: 1000 },
    ])
  })

  it('全消去 → 再入力、0 円の確定、途中の数字の変更', () => {
    expect(type(['', '5', '50'])).toEqual([{ draft: '', value: 0 }, { draft: '5', value: 5 }, { draft: '50', value: 50 }])
    expect(type(['0'])).toEqual([{ draft: '0', value: 0 }])
    expect(type(['1500'])).toEqual([{ draft: '1500', value: 1500 }]) // 1000 の 2 桁目を 5 に
  })
})
