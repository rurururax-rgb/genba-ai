import { describe, it, expect } from 'vitest'
import { parseNumericInput, resolveNumericCommit } from '@/lib/input/numeric-input'

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
