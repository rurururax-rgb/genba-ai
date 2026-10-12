/**
 * 業者請求書 OCR の金額照合（lib/cost-ledger/ocr-amounts.ts）。
 * 原価台帳は税抜で集計するため、登録金額（税抜）の候補は原本の印字からだけ作る。税込 ÷ 1.1 はしない。
 * すべて架空の請求書の値。
 */

import { describe, expect, it } from 'vitest'
import { reviewInvoiceAmounts, toAmount, toPrintedAmounts, type PrintedAmounts } from '@/lib/cost-ledger/ocr-amounts'

const printed = (p: Partial<PrintedAmounts>): PrintedAmounts => ({
  subtotal_excl_tax: null, tax_amount: null, total_incl_tax: null, tax_treatment: 'unknown', tax_breakdown: [], ...p,
})
const warns = (r: ReturnType<typeof reviewInvoiceAmounts>) => r.messages.filter(m => m.level === 'warn').map(m => m.text)

describe('reviewInvoiceAmounts', () => {
  it('税抜 100,000・消費税 10,000・税込 110,000 → 税抜 100,000 を候補にし、整合 OK', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, suggested_from: 'printed_subtotal', status: 'ok' })
    expect(warns(r)).toEqual([])
  })

  it('税込 110,000 しか記載がない → 候補なし・要確認（1.1 で割らない）', () => {
    const r = reviewInvoiceAmounts(printed({ total_incl_tax: 110000, tax_treatment: 'unknown' }))
    expect(r).toMatchObject({ suggested_excl_tax: null, suggested_from: null, status: 'needs_review' })
    expect(warns(r)[0]).toContain('税込合計しか読み取れませんでした')
  })

  it('内税（税込 110,000・うち消費税 10,000）→ 印字どうしの差 100,000 を候補にする（出どころを示す）', () => {
    const r = reviewInvoiceAmounts(printed({ total_incl_tax: 110000, tax_amount: 10000, tax_treatment: 'inclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, suggested_from: 'printed_total_minus_tax', status: 'ok' })
    expect(r.messages.some(m => m.level === 'info' && m.text.includes('税込合計 ¥110,000 − 消費税額 ¥10,000'))).toBe(true)
  })

  it('税率 8%（税抜 100,000・消費税 8,000・税込 108,000）→ 税抜 100,000', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 8000, total_incl_tax: 108000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 8, taxable_amount: 100000, tax_amount: 8000 }],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
  })

  it('8%・10% 混在（内訳の合計が一致）→ 合計の税抜を候補にし、混在を知らせる', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 5000 }, { rate: 8, taxable_amount: 50000, tax_amount: 4000 }],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
    expect(r.messages.find(m => m.level === 'info')?.text).toContain('10%・8%')
  })

  it('8%・10% 混在で内訳の合計が合わない → 要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 60000, tax_amount: 6000 }, { rate: 8, taxable_amount: 50000, tax_amount: 4000 }],
    }))
    expect(r.status).toBe('needs_review')
    expect(warns(r).join()).toContain('対象額の合計（¥110,000）')
    expect(warns(r).join()).toContain('消費税額の合計（¥10,000）')
  })

  it('消費税の記載がない（税抜とも税込とも書かれていない金額 100,000 だけを税抜として読んだ）→ 候補は出すが要確認', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000 }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'needs_review' })
    expect(warns(r)[0]).toContain('この金額が税抜かどうか原本で確認してください')
  })

  it('非課税（50,000）→ 税込 = 税抜として候補にする', () => {
    const r = reviewInvoiceAmounts(printed({ total_incl_tax: 50000, tax_treatment: 'non_taxable' }))
    expect(r).toMatchObject({ suggested_excl_tax: 50000, suggested_from: 'non_taxable_total', status: 'ok' })
  })

  it('非課税なのに消費税額がある → 要確認', () => {
    const r = reviewInvoiceAmounts(printed({ total_incl_tax: 55000, tax_amount: 5000, tax_treatment: 'non_taxable' }))
    expect(r.status).toBe('needs_review')
  })

  it('値引き後の税抜 99,000＋消費税 9,900 が税込 108,900 と一致 → OK', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 99000, tax_amount: 9900, total_incl_tax: 108900, tax_treatment: 'exclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 99000, status: 'ok' })
  })

  it('端数処理で合計が 3 円合わない（税抜 100,000＋税 10,000 ≠ 税込 110,003）→ 差額を示して要確認', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110003, tax_treatment: 'exclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'needs_review' })
    expect(warns(r)[0]).toContain('差 ¥3')
  })

  it('金額の読み取りに失敗（すべて null）→ 候補なし・要確認', () => {
    const r = reviewInvoiceAmounts(printed({}))
    expect(r).toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
    expect(warns(r)[0]).toContain('金額を読み取れませんでした')
  })

  it('1 円未満の端数・0 円は要確認（0 円は候補にしない）', () => {
    expect(reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100.5, tax_amount: 10, total_incl_tax: 110.5 })).status).toBe('needs_review')
    expect(reviewInvoiceAmounts(printed({ subtotal_excl_tax: 0, tax_amount: 0, total_incl_tax: 0 })))
      .toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
  })

  it('消費税が税込合計より大きい・税込が税抜より小さい → 要確認', () => {
    expect(reviewInvoiceAmounts(printed({ total_incl_tax: 1000, tax_amount: 5000 })))
      .toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
    expect(reviewInvoiceAmounts(printed({ subtotal_excl_tax: 110000, total_incl_tax: 100000 })).status).toBe('needs_review')
  })

  it('税抜と税込だけ（消費税額の記載なし）→ 税抜を候補にし、整合 OK', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, total_incl_tax: 110000 }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
  })
})

describe('toAmount / toPrintedAmounts（AI の出力の形は信用しない）', () => {
  it('数値・カンマや円記号付きの文字列を金額にし、負数・文字・桁外れは null', () => {
    expect(toAmount(110000)).toBe(110000)
    expect(toAmount('¥110,000円')).toBe(110000)
    expect(toAmount('-5')).toBeNull()
    expect(toAmount('約十万')).toBeNull()
    expect(toAmount(1e13)).toBeNull()
    expect(toAmount(null)).toBeNull()
    expect(toAmount('')).toBeNull()
  })

  it('税区分は決まった値だけ。内訳の税率は 0〜100 だけ', () => {
    const p = toPrintedAmounts({
      subtotal_excl_tax: '100,000', tax_amount: 10000, total_incl_tax: 'x', tax_treatment: 'maybe',
      tax_breakdown: [{ rate: 10, taxable_amount: 100000, tax_amount: 10000 }, { rate: 1000 }, 'junk'],
    })
    expect(p).toEqual({
      subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: null, tax_treatment: 'unknown',
      tax_breakdown: [
        { rate: 10, taxable_amount: 100000, tax_amount: 10000 },
        { rate: null, taxable_amount: null, tax_amount: null },
        { rate: null, taxable_amount: null, tax_amount: null },
      ],
    })
    expect(toPrintedAmounts(null).tax_treatment).toBe('unknown')
  })
})
