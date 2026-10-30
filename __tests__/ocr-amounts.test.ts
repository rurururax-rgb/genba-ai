/**
 * 業者請求書 OCR の金額照合（lib/cost-ledger/ocr-amounts.ts）。
 * 原価台帳は税抜で集計するため、登録金額（税抜）の候補は原本の印字からだけ作る。税込 ÷ 1.1 はしない。
 * すべて架空の請求書の値。
 */

import { describe, expect, it } from 'vitest'
import { registerAmountRisk, reviewInvoiceAmounts, toAmount, toPrintedAmounts, type PrintedAmounts } from '@/lib/cost-ledger/ocr-amounts'

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
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, total_incl_tax: 110000, tax_treatment: 'exclusive' }))
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
      adjustments: [],
      printed_tax_rates: [],
    })
    expect(toPrintedAmounts(null).tax_treatment).toBe('unknown')
  })
})

describe('税率ごとの内訳は金額の判定に影響しない（合計欄しかない原本では内訳は空配列）', () => {
  // 原本に合計欄しかない請求書（A 外税・E 値引き後・B 内税）。
  // 以前の AI は合計欄から「10% 対象 100,000 / 税 10,000」の1行を組み立てていた。その行の有無で判定が変わらないこと
  // （合計欄の「消費税（10%）」は printed_tax_rates として受け取り、どちらの場合も 10% で検算する）
  const cases: Array<[string, Partial<PrintedAmounts>, PrintedAmounts['tax_breakdown'], { suggested: number; from: string }]> = [
    ['A 外税', { subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', printed_tax_rates: [10] },
      [{ rate: 10, taxable_amount: 100000, tax_amount: 10000 }], { suggested: 100000, from: 'printed_subtotal' }],
    ['B 内税（うち消費税 10%）', { tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'inclusive', printed_tax_rates: [10] },
      [{ rate: 10, taxable_amount: null, tax_amount: 10000 }], { suggested: 100000, from: 'printed_total_minus_tax' }],
  ]
  for (const [name, amounts, synthesized, expected] of cases) {
    it(`${name}：内訳なし（空配列）でも、合計欄から作った1行があっても、候補・判定・メッセージは同じ`, () => {
      const empty = reviewInvoiceAmounts(printed({ ...amounts, tax_breakdown: [] }))
      const withRow = reviewInvoiceAmounts(printed({ ...amounts, tax_breakdown: synthesized }))
      expect(empty).toMatchObject({ suggested_excl_tax: expected.suggested, suggested_from: expected.from, status: 'ok' })
      expect(withRow).toEqual(empty)
    })
  }

  it('印字された単一税率（8%）の1行の内訳は正規化で消えず、判定も変わらない', () => {
    const p = toPrintedAmounts({
      subtotal_excl_tax: 100000, tax_amount: 8000, total_incl_tax: 108000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 8, taxable_amount: 100000, tax_amount: 8000 }],
    })
    expect(p.tax_breakdown).toEqual([{ rate: 8, taxable_amount: 100000, tax_amount: 8000 }])
    expect(reviewInvoiceAmounts(p)).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
  })

  it('印字された 8%・10% 混在の内訳は2行とも残り、混在を知らせる（内訳が空なら混在の案内は出ない）', () => {
    const mixed = toPrintedAmounts({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 5000 }, { rate: 8, taxable_amount: 50000, tax_amount: 4000 }],
    })
    expect(mixed.tax_breakdown).toHaveLength(2)
    const r = reviewInvoiceAmounts(mixed)
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'ok' })
    expect(r.messages.some(m => m.text.includes('税率が混在'))).toBe(true)
    expect(reviewInvoiceAmounts({ ...mixed, tax_breakdown: [] }).messages.some(m => m.text.includes('税率が混在'))).toBe(false)
  })

  it('F 端数差（税抜 98,765＋税 9,877 ≠ 税込 108,641）は内訳が空でも差 ¥1 で要確認のまま', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 98765, tax_amount: 9877, total_incl_tax: 108641, tax_treatment: 'exclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 98765, status: 'needs_review' })
    expect(warns(r)[0]).toContain('差 ¥1')
  })
})

describe('値引き・源泉徴収・税率混在：根拠がなければ照合 OK にしない（トライアル前の修正）', () => {
  const discount = (amount: number) => ({ kind: 'discount' as const, amount })
  const withholding = (amount: number) => ({ kind: 'withholding' as const, amount })

  it('値引き後の税抜合計が印字されていない（小計 100,000・値引き 1,000・税 9,900・税込 108,900）→ 要確認、候補は税込 − 税 = 99,000', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9900, total_incl_tax: 108900, tax_treatment: 'exclusive', adjustments: [discount(1000)],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 99000, suggested_from: 'printed_total_minus_tax', status: 'needs_review' })
    expect(warns(r).join()).toContain('値引きの記載があります')
  })

  it('AI が値引き後の税抜 99,000 を計算して返しても（印字どうしは一致）、値引きの記載があれば照合 OK にしない', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 99000, tax_amount: 9900, total_incl_tax: 108900, tax_treatment: 'exclusive', adjustments: [discount(1000)],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 99000, status: 'needs_review' })
  })

  it('源泉徴収あり（税抜 100,000・税 10,000・税込計 110,000・源泉 10,210）→ 源泉徴収前の税抜 100,000 を候補にするが要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', adjustments: [withholding(10210)],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'needs_review' })
    expect(warns(r).join()).toContain('源泉徴収前の税抜金額')
  })

  it('源泉徴収あり・差引請求額を税込合計として読んだ（税込 99,790・税 10,000）→ 税込 − 税 を候補にしない', () => {
    const r = reviewInvoiceAmounts(printed({
      tax_amount: 10000, total_incl_tax: 99790, tax_treatment: 'exclusive', adjustments: [withholding(10210)],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: null, suggested_from: null, status: 'needs_review' })
  })

  it('源泉徴収と値引きの混在（小計 100,000・値引き 1,000・税 9,900・税込 108,900・源泉 10,107）→ 候補なし・要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9900, total_incl_tax: 108900, tax_treatment: 'exclusive',
      adjustments: [discount(1000), withholding(10107)],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: null, status: 'needs_review' })
    expect(warns(r).join()).toContain('値引きの記載があります')
    expect(warns(r).join()).toContain('源泉徴収')
  })

  it('値引き・源泉徴収以外の増減（相殺など）→ 要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', adjustments: [{ kind: 'other', amount: 5000 }],
    }))
    expect(r.status).toBe('needs_review')
  })

  it('税率混在で税率ごとの対象額が読めていない → 要確認（合計が一致していても）', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 60000, tax_amount: 5800, total_incl_tax: 65800, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: null, tax_amount: 5000 }, { rate: 8, taxable_amount: null, tax_amount: 800 }],
    }))
    expect(r).toMatchObject({ suggested_excl_tax: 60000, status: 'needs_review' })
    expect(warns(r).join()).toContain('読み取りきれませんでした')
  })

  it('税率混在で税抜金額がない（税込・税だけ）→ 要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      tax_amount: 5800, total_incl_tax: 65800, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 5000 }, { rate: 8, taxable_amount: 10000, tax_amount: 800 }],
    }))
    expect(r.status).toBe('needs_review')
  })

  it('税抜と税込だけで、差額が消費税（10%・8%）として説明できない → 要確認', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, total_incl_tax: 120000, tax_treatment: 'exclusive' }))
    expect(r).toMatchObject({ suggested_excl_tax: 100000, status: 'needs_review' })
    // 8% は OK のまま
    expect(reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, total_incl_tax: 108000, tax_treatment: 'exclusive' })).status).toBe('ok')
  })

  it('増減の正規化：マイナス記号・▲ は絶対値、種類が不明なら other、読めない金額は null', () => {
    expect(toPrintedAmounts({ adjustments: [
      { kind: 'discount', amount: '-1,000' }, { kind: 'withholding', amount: '▲10,210' },
      { kind: 'rebate', amount: -500 }, { kind: 'discount', amount: 'x' }, 'junk',
    ] }).adjustments).toEqual([
      { kind: 'discount', amount: 1000 }, { kind: 'withholding', amount: 10210 },
      { kind: 'other', amount: 500 }, { kind: 'discount', amount: null }, { kind: 'other', amount: null },
    ])
  })
})

describe('税区分と金額の根拠を、計算の一致とは別に評価する（OBS-2）', () => {
  it('税区分が不明 → 計算が合っていても要確認（整合OK にしない）', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'unknown' }))
    expect(r.status).toBe('needs_review')
    expect(r.checks).toMatchObject({ arithmetic: 'consistent', treatment: 'unknown' })
    expect(r.suggested_excl_tax).toBe(100000)
  })

  it('QA-B を外税に切り替える（税抜の印字なし・税込と消費税だけ）→ 要確認。候補 100,000 は残す', () => {
    const r = reviewInvoiceAmounts(printed({ tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', printed_tax_rates: [10] }))
    expect(r.status).toBe('needs_review')
    expect(r.checks.treatment).toBe('inconsistent')
    expect(r.suggested_excl_tax).toBe(100000)
    expect(warns(r).join()).toContain('外税になっていますが、原本に税抜金額の記載がありません')
  })

  it('内税なのに税込合計がなく税抜だけ → 要確認', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, tax_treatment: 'inclusive' }))
    expect(r.status).toBe('needs_review')
    expect(r.checks.treatment).toBe('inconsistent')
  })

  it('QA-A（外税・3 つの金額・10%）と QA-B（内税・税込と消費税・10%）は整合OK のまま', () => {
    const a = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', printed_tax_rates: [10] }))
    expect(a).toMatchObject({ status: 'ok', checks: { arithmetic: 'consistent', treatment: 'consistent', tax_rate: 'consistent' }, messages: [] })
    const b = reviewInvoiceAmounts(printed({ tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'inclusive', printed_tax_rates: [10] }))
    expect(b).toMatchObject({ status: 'ok', suggested_excl_tax: 100000, checks: { arithmetic: 'unverifiable', treatment: 'consistent', tax_rate: 'consistent' } })
  })
})

describe('原本に印字された税率での消費税額の検算（OBS-3）', () => {
  it('QA-B で税額を 9,000 に直す・印字は 10% → 要確認（税率で合わない）', () => {
    const r = reviewInvoiceAmounts(printed({ tax_amount: 9000, total_incl_tax: 110000, tax_treatment: 'inclusive', printed_tax_rates: [10] }))
    expect(r.status).toBe('needs_review')
    expect(r.checks.tax_rate).toBe('inconsistent')
    expect(warns(r).join()).toContain('原本の税率 10% で計算した額と合いません')
  })

  it('税率の印字がなければ検算しない（10% と決めつけない）', () => {
    const r = reviewInvoiceAmounts(printed({ tax_amount: 9000, total_incl_tax: 110000, tax_treatment: 'inclusive' }))
    expect(r.status).toBe('ok')
    expect(r.checks.tax_rate).toBe('not_checked')
  })

  it('8% の請求書：8% で合えば OK。計算は合っても 8% と合わない税額は要確認', () => {
    const ok = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 8000, total_incl_tax: 108000, tax_treatment: 'exclusive', printed_tax_rates: [8] }))
    expect(ok).toMatchObject({ status: 'ok', checks: { tax_rate: 'consistent' } })
    const bad = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', printed_tax_rates: [8] }))
    expect(bad).toMatchObject({ status: 'needs_review', checks: { arithmetic: 'consistent', tax_rate: 'inconsistent' } })
  })

  it('端数処理：切り捨て・四捨五入・切り上げのどれかで説明できれば OK（外税・内税とも）', () => {
    const ex = (tax: number) => reviewInvoiceAmounts(printed({ subtotal_excl_tax: 98765, tax_amount: tax, total_incl_tax: 98765 + tax, tax_treatment: 'exclusive', printed_tax_rates: [10] })).checks.tax_rate
    expect(ex(9876)).toBe('consistent') // 切り捨て
    expect(ex(9877)).toBe('consistent') // 四捨五入・切り上げ
    expect(ex(9875)).toBe('inconsistent')
    // 内税: 108,641 × 10 / 110 = 9,876.45…
    const inc = reviewInvoiceAmounts(printed({ tax_amount: 9876, total_incl_tax: 108641, tax_treatment: 'inclusive', printed_tax_rates: [10] }))
    expect(inc.checks.tax_rate).toBe('consistent')
  })

  it('8%・10% 混在の内訳（QA-C）は行ごとに検算する。正しければ OK', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive', printed_tax_rates: [10, 8],
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 5000 }, { rate: 8, taxable_amount: 50000, tax_amount: 4000 }],
    }))
    expect(r).toMatchObject({ status: 'ok', checks: { arithmetic: 'consistent', tax_rate: 'consistent' } })
  })

  it('混在の内訳で税率と税額が入れ違い（合計は合う）→ 行の検算で要確認', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 50000, tax_amount: 4000 }, { rate: 8, taxable_amount: 50000, tax_amount: 5000 }],
    }))
    expect(r).toMatchObject({ status: 'needs_review', checks: { arithmetic: 'consistent', tax_rate: 'inconsistent' } })
    expect(warns(r)).toHaveLength(2)
  })

  it('内訳の対象額が税込で印字されている（内税の「10%対象 ¥110,000 うち税 ¥10,000」）→ OK', () => {
    const r = reviewInvoiceAmounts(printed({
      tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'inclusive',
      tax_breakdown: [{ rate: 10, taxable_amount: 110000, tax_amount: 10000 }],
    }))
    expect(r.checks.tax_rate).toBe('consistent')
  })

  it('税率が複数印字されているが内訳がない → 税率ごとの対象額が分からないので検算しない', () => {
    const r = reviewInvoiceAmounts(printed({ subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 109000, tax_treatment: 'exclusive', printed_tax_rates: [10, 8] }))
    expect(r.checks.tax_rate).toBe('not_checked')
  })

  it('8% 単一の内訳で対象額の印字なし（QA-H）→ 税抜 × 8% で検算する', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 8000, total_incl_tax: 108000, tax_treatment: 'exclusive',
      tax_breakdown: [{ rate: 8, taxable_amount: null, tax_amount: 8000 }],
    }))
    expect(r).toMatchObject({ status: 'ok', checks: { tax_rate: 'consistent' } })
  })

  it('値引きがある → 対象額の段階が決まらないので検算しない（値引きの要確認はそのまま）', () => {
    const r = reviewInvoiceAmounts(printed({
      subtotal_excl_tax: 100000, tax_amount: 9000, total_incl_tax: 99000, tax_treatment: 'exclusive', printed_tax_rates: [10],
      adjustments: [{ kind: 'discount', amount: 10000 }],
    }))
    expect(r.checks.tax_rate).toBe('not_checked')
    expect(r.status).toBe('needs_review')
  })

  it('printed_tax_rates の正規化：数値と数字の文字列だけ・0 や 100 超・重複は除く', () => {
    expect(toPrintedAmounts({ printed_tax_rates: [10, '8', 10, 0, 150, 'x', null] }).printed_tax_rates).toEqual([10, 8])
    expect(toPrintedAmounts({}).printed_tax_rates).toEqual([])
    // 配列でない・中身が壊れている → 空配列（検算しない）
    expect(toPrintedAmounts({ printed_tax_rates: '10' }).printed_tax_rates).toEqual([])
    expect(toPrintedAmounts({ printed_tax_rates: { rate: 10 } }).printed_tax_rates).toEqual([])
    expect(toPrintedAmounts({ printed_tax_rates: [{ rate: 10 }, '10%', -8] }).printed_tax_rates).toEqual([])
  })

  it('printed_tax_rates が欠落・空配列 → 検算しない（判定は従来どおり）', () => {
    const base = { tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'inclusive' as const }
    const missing = reviewInvoiceAmounts(printed(base))
    const empty = reviewInvoiceAmounts(printed({ ...base, printed_tax_rates: [] }))
    expect(missing).toEqual(empty)
    expect(missing).toMatchObject({ status: 'ok', suggested_excl_tax: 100000, checks: { tax_rate: 'not_checked' } })
  })
})

describe('registerAmountRisk：登録金額が原本の税抜と食い違う危険（OBS-1）', () => {
  const qaB = { excl: null, incl: 110000, treatment: 'inclusive' as const }
  it('候補どおり → 危険なし', () => {
    expect(registerAmountRisk(100000, { suggested_excl_tax: 100000 }, qaB)).toBeNull()
    expect(registerAmountRisk(null, { suggested_excl_tax: 100000 }, qaB)).toBeNull()
  })
  it('税込合計と同じ 110,000 → total_incl。税抜の候補も示す', () => {
    const r = registerAmountRisk(110000, { suggested_excl_tax: 100000 }, qaB)
    expect(r?.kind).toBe('total_incl')
    expect(r?.message).toBe('登録金額 ¥110,000 は税込合計と同じです。原価台帳は税抜で集計します（原本の税抜は ¥100,000）')
  })
  it('候補と違う 95,000 → differs', () => {
    expect(registerAmountRisk(95000, { suggested_excl_tax: 100000 }, qaB)?.kind).toBe('differs')
  })
  it('候補がない（QA-D 税込のみ）：税込と同じなら total_incl、それ以外の手入力は危険なし', () => {
    const d = { excl: null, incl: 110000, treatment: 'unknown' as const }
    expect(registerAmountRisk(110000, { suggested_excl_tax: null }, d)?.message).toBe('登録金額 ¥110,000 は税込合計と同じです。原価台帳は税抜で集計します')
    expect(registerAmountRisk(100000, { suggested_excl_tax: null }, d)).toBeNull()
  })
  it('非課税（税込 = 税抜）や、税抜と税込が同じ印字 → 税込と同じでも total_incl にしない', () => {
    expect(registerAmountRisk(50000, { suggested_excl_tax: 50000 }, { excl: null, incl: 50000, treatment: 'non_taxable' })).toBeNull()
    expect(registerAmountRisk(50000, { suggested_excl_tax: 50000 }, { excl: 50000, incl: 50000, treatment: 'exclusive' })).toBeNull()
  })
})
