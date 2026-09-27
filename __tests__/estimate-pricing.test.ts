import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MARKUP_RATE,
  getEffectiveMarkupRate,
  calculateSellingPrice,
  resolveSellingPrice,
  calculateGrossMarginRate,
  markupToMarginRate,
} from '@/lib/estimate/pricing'

// ── DEFAULT_MARKUP_RATE ───────────────────────────────────────

describe('DEFAULT_MARKUP_RATE', () => {
  it('is 1.45', () => {
    expect(DEFAULT_MARKUP_RATE).toBe(1.45)
  })
})

// ── getEffectiveMarkupRate ────────────────────────────────────

describe('getEffectiveMarkupRate', () => {
  it('TEST 5: project=1.45, override=null → 1.45', () => {
    expect(getEffectiveMarkupRate(1.45, null)).toBe(1.45)
  })

  it('TEST 6: project=1.45, override=1.30 → 1.30', () => {
    expect(getEffectiveMarkupRate(1.45, 1.30)).toBe(1.30)
  })

  it('TEST 7: project=null, override=null → DEFAULT_MARKUP_RATE', () => {
    expect(getEffectiveMarkupRate(null, null)).toBe(DEFAULT_MARKUP_RATE)
  })

  it('project=undefined, override=undefined → DEFAULT_MARKUP_RATE', () => {
    expect(getEffectiveMarkupRate(undefined, undefined)).toBe(DEFAULT_MARKUP_RATE)
  })

  it('project=1.30, override=1.20 → override wins (1.20)', () => {
    expect(getEffectiveMarkupRate(1.30, 1.20)).toBe(1.20)
  })

  it('project=null, override=1.20 → 1.20', () => {
    expect(getEffectiveMarkupRate(null, 1.20)).toBe(1.20)
  })
})

// ── calculateSellingPrice ─────────────────────────────────────

describe('calculateSellingPrice', () => {
  it('TEST 1: cost=100000, markup=1.45 → 145000', () => {
    expect(calculateSellingPrice(100000, 1.45)).toBe(145000)
  })

  it('TEST 2: cost=100000, markup=1.40 → 140000', () => {
    expect(calculateSellingPrice(100000, 1.40)).toBe(140000)
  })

  it('TEST 3: cost=110000, markup=1.30 → 143000', () => {
    expect(calculateSellingPrice(110000, 1.30)).toBe(143000)
  })

  it('TEST 4: rounding — cost=33333, markup=1.45 matches Math.round(33333*1.45)', () => {
    const expected = Math.round(33333 * 1.45)
    expect(calculateSellingPrice(33333, 1.45)).toBe(expected)
  })

  it('markup=null uses DEFAULT_MARKUP_RATE', () => {
    expect(calculateSellingPrice(100000, null)).toBe(Math.round(100000 * DEFAULT_MARKUP_RATE))
  })

  it('markup=undefined uses DEFAULT_MARKUP_RATE', () => {
    expect(calculateSellingPrice(100000, undefined)).toBe(Math.round(100000 * DEFAULT_MARKUP_RATE))
  })

  it('TEST 9: cost=0 → 0', () => {
    expect(calculateSellingPrice(0, 1.45)).toBe(0)
  })

  it('cost=null → null', () => {
    expect(calculateSellingPrice(null, 1.45)).toBeNull()
  })

  it('cost=undefined → null', () => {
    expect(calculateSellingPrice(undefined, 1.45)).toBeNull()
  })

  it('TEST 10: markup=0 → null (invalid)', () => {
    expect(calculateSellingPrice(100000, 0)).toBeNull()
  })

  it('markup=-1 → null (invalid)', () => {
    expect(calculateSellingPrice(100000, -1)).toBeNull()
  })

  it('cost=NaN → null', () => {
    expect(calculateSellingPrice(NaN, 1.45)).toBeNull()
  })

  it('markup=NaN → null', () => {
    expect(calculateSellingPrice(100000, NaN)).toBeNull()
  })

  it('cost=Infinity → null', () => {
    expect(calculateSellingPrice(Infinity, 1.45)).toBeNull()
  })
})

// ── resolveSellingPrice ───────────────────────────────────────

describe('resolveSellingPrice', () => {
  it('mode=auto: calculates from cost and markup', () => {
    expect(resolveSellingPrice('auto', null, 100000, 1.45)).toBe(145000)
  })

  it('mode=auto: uses DEFAULT_MARKUP_RATE when markup null', () => {
    expect(resolveSellingPrice('auto', null, 100000, null)).toBe(Math.round(100000 * DEFAULT_MARKUP_RATE))
  })

  it('mode=manual: preserves existing selling_price regardless of cost change', () => {
    expect(resolveSellingPrice('manual', 138000, 100000, 1.45)).toBe(138000)
  })

  it('mode=manual: returns null when existingSelling is null', () => {
    expect(resolveSellingPrice('manual', null, 100000, 1.45)).toBeNull()
  })

  it('mode=manual: existingSelling=0 → 0', () => {
    expect(resolveSellingPrice('manual', 0, 100000, 1.45)).toBe(0)
  })

  it('mode=auto: cost=null → null', () => {
    expect(resolveSellingPrice('auto', 50000, null, 1.45)).toBeNull()
  })
})

// ── calculateGrossMarginRate ──────────────────────────────────

describe('calculateGrossMarginRate', () => {
  it('TEST 8: markup=1.45 → cost=100, selling=145 → ≈0.3103448', () => {
    const cost    = 100000
    const selling = Math.round(cost * 1.45) // 145000
    const result  = calculateGrossMarginRate(cost, selling)
    expect(result).not.toBeNull()
    expect(result!).toBeCloseTo(0.3103448, 5)
  })

  it('selling=0 → null (division by zero)', () => {
    expect(calculateGrossMarginRate(100000, 0)).toBeNull()
  })

  it('cost=null → null', () => {
    expect(calculateGrossMarginRate(null, 145000)).toBeNull()
  })

  it('selling=null → null', () => {
    expect(calculateGrossMarginRate(100000, null)).toBeNull()
  })

  it('cost=selling → 0 (no margin)', () => {
    expect(calculateGrossMarginRate(100000, 100000)).toBeCloseTo(0, 10)
  })
})

// ── markupToMarginRate ────────────────────────────────────────

describe('markupToMarginRate', () => {
  it('1.45 → ≈0.3103448', () => {
    const result = markupToMarginRate(1.45)
    expect(result).not.toBeNull()
    expect(result!).toBeCloseTo(0.3103448, 5)
  })

  it('1.0 → 0 (no margin)', () => {
    expect(markupToMarginRate(1.0)).toBeCloseTo(0, 10)
  })

  it('0 → null (invalid)', () => {
    expect(markupToMarginRate(0)).toBeNull()
  })

  it('negative → null', () => {
    expect(markupToMarginRate(-1)).toBeNull()
  })

  it('NaN → null', () => {
    expect(markupToMarginRate(NaN)).toBeNull()
  })

  it('Infinity → null', () => {
    expect(markupToMarginRate(Infinity)).toBeNull()
  })
})
