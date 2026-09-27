import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MARKUP_RATE,
  getEffectiveMarkupRate,
  calculateSellingPrice,
  resolveSellingPrice,
  calculateGrossMarginRate,
  markupToMarginRate,
  marginRateToMarkup,
  deriveMarkupRate,
  isValidMarkupRate,
  normalizeMarkupOverride,
  getItemPricingState,
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

// ── marginRateToMarkup（粗利率 → 掛け率 → 売価の逆算） ─────────────

describe('marginRateToMarkup', () => {
  it('margin 37.5% → markup 1.6', () => {
    expect(marginRateToMarkup(0.375)).toBeCloseTo(1.6, 10)
  })

  it('原価100,000 × 粗利30% → 売価 142,857（cost / (1 - margin) と一致）', () => {
    expect(calculateSellingPrice(100000, marginRateToMarkup(0.30))).toBe(142857)
  })

  it('原価20,000 × 粗利37.5% → 売価 32,000', () => {
    expect(calculateSellingPrice(20000, marginRateToMarkup(0.375))).toBe(32000)
  })

  it('原価20,000 × 粗利35% → 売価 30,769', () => {
    expect(calculateSellingPrice(20000, marginRateToMarkup(0.35))).toBe(30769)
  })

  it('markupToMarginRate の逆関数になっている', () => {
    for (const m of [1.2, 1.45, 1.6, 2.5]) {
      expect(marginRateToMarkup(markupToMarginRate(m)!)).toBeCloseTo(m, 10)
    }
  })

  it('margin 0 → 1.0（原価売り）', () => {
    expect(marginRateToMarkup(0)).toBe(1)
  })

  it('margin >= 1 / 無効値 → null', () => {
    expect(marginRateToMarkup(1)).toBeNull()
    expect(marginRateToMarkup(1.2)).toBeNull()
    expect(marginRateToMarkup(NaN)).toBeNull()
  })
})

// ── deriveMarkupRate ─────────────────────────────────────────

describe('deriveMarkupRate', () => {
  it('29,000 / 20,000 → 1.45', () => {
    expect(deriveMarkupRate(20000, 29000)).toBeCloseTo(1.45, 10)
  })

  it('原価 null / 0 以下 → null', () => {
    expect(deriveMarkupRate(null, 29000)).toBeNull()
    expect(deriveMarkupRate(0, 29000)).toBeNull()
    expect(deriveMarkupRate(-1, 29000)).toBeNull()
  })

  it('売価 null → null', () => {
    expect(deriveMarkupRate(20000, null)).toBeNull()
  })
})

// ── isValidMarkupRate / normalizeMarkupOverride ─────────────────

describe('isValidMarkupRate', () => {
  it('0.01〜9.99 のみ有効', () => {
    expect(isValidMarkupRate(0.01)).toBe(true)
    expect(isValidMarkupRate(9.99)).toBe(true)
    expect(isValidMarkupRate(0)).toBe(false)
    expect(isValidMarkupRate(10)).toBe(false)
    expect(isValidMarkupRate(NaN)).toBe(false)
  })
})

describe('normalizeMarkupOverride', () => {
  it('案件標準と同値なら null', () => {
    expect(normalizeMarkupOverride(1.45, 1.45)).toBeNull()
  })

  it('案件標準未設定なら DEFAULT と比較', () => {
    expect(normalizeMarkupOverride(DEFAULT_MARKUP_RATE, null)).toBeNull()
  })

  it('異なる値はそのまま', () => {
    expect(normalizeMarkupOverride(1.6, 1.45)).toBe(1.6)
  })
})

// ── getItemPricingState ────────────────────────────────────────

describe('getItemPricingState', () => {
  it('AUTO + override なし → project、実粗利は売価から算出', () => {
    const s = getItemPricingState({ cost_price: 20000, selling_price: 29000, selling_price_mode: 'auto', markup_rate_override: null }, 1.45)
    expect(s.basis).toBe('project')
    expect(s.configuredRate).toBe(1.45)
    expect(s.actualMarkup).toBeCloseTo(1.45, 10)
    expect(s.actualMargin).toBeCloseTo(0.3103, 3)
  })

  it('AUTO + override → override', () => {
    const s = getItemPricingState({ cost_price: 20000, selling_price: 32000, selling_price_mode: 'auto', markup_rate_override: 1.6 }, 1.45)
    expect(s.basis).toBe('override')
    expect(s.configuredRate).toBe(1.6)
    expect(s.actualMargin).toBeCloseTo(0.375, 10)
  })

  it('MANUAL + override（売価未反映）→ manual。表示値は実売価ベースで矛盾しない', () => {
    const s = getItemPricingState({ cost_price: 20000, selling_price: 29000, selling_price_mode: 'manual', markup_rate_override: 1.6 }, 1.45)
    expect(s.basis).toBe('manual')
    expect(s.actualMarkup).toBeCloseTo(1.45, 10)
    expect(s.actualMargin).toBeCloseTo(markupToMarginRate(s.actualMarkup!)!, 10)
  })

  it('原価 null → no_cost', () => {
    const s = getItemPricingState({ cost_price: null, selling_price: 29000, selling_price_mode: 'manual' }, 1.45)
    expect(s.basis).toBe('no_cost')
    expect(s.actualMarkup).toBeNull()
    expect(s.actualMargin).toBeNull()
  })

  it('原価 0 → no_cost', () => {
    const s = getItemPricingState({ cost_price: 0, selling_price: 0, selling_price_mode: 'auto' }, 1.45)
    expect(s.basis).toBe('no_cost')
  })

  it('mode 未指定は auto 扱い', () => {
    const s = getItemPricingState({ cost_price: 100, selling_price: 145 }, 1.45)
    expect(s.basis).toBe('project')
  })
})
