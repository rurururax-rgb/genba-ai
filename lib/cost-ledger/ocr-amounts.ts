/**
 * 業者請求書 OCR の金額（税抜・消費税・税込）の正規化と照合。
 *
 * 原価台帳の実績原価（cost_ledger_invoices.amount の合計 = cost_ledger_items.actual_cost）は**税抜**で集計する
 * （先方の原価台帳 Excel の「請求実績」は税抜。粗利は 受注金額（税抜）− 実績原価。
 *  docs/db/p1-2-atomic-cost-ledger-invoice-writes.md の「請求実績の税区分」）。
 *
 * - 金額は原本に印字された値だけを使う（AI に計算させない。税込 ÷ 1.1 のような割り戻しはしない）。
 * - 登録金額（税抜）の候補を出すのは、原本に税抜金額があるとき、または税込合計と消費税額の両方があるとき
 *   （内税の「うち消費税」を含む）と、非課税と明記されているときだけ。
 * - 判断できなければ候補を出さずに「要確認」とし、人が原本を見て入力する。候補があっても登録前に人が確認する。
 *
 * サーバー（AI の読み取り結果の検査）と画面（人が直した値の検査）の両方で使う。
 */

export type TaxTreatment = 'exclusive' | 'inclusive' | 'non_taxable' | 'unknown'

/** 税率ごとの内訳（原本に印字されていれば） */
export type TaxBreakdownRow = {
  rate: number | null          // 10 / 8 / 0。読めなければ null
  taxable_amount: number | null // その税率の対象額（税抜）
  tax_amount: number | null
}

/**
 * 小計と合計のあいだに印字された増減（値引き・源泉徴収など）。金額は印字の絶対値（マイナス記号は付けない）。
 * あると税抜金額がどの段階の金額か曖昧になるため、照合は必ず「要確認」にする
 */
export type AdjustmentKind = 'discount' | 'withholding' | 'other'
export type AdjustmentRow = {
  kind: AdjustmentKind
  amount: number | null
}

/** 原本に印字された金額（読めないものは null） */
export type PrintedAmounts = {
  subtotal_excl_tax: number | null
  tax_amount: number | null
  total_incl_tax: number | null
  tax_treatment: TaxTreatment
  tax_breakdown: TaxBreakdownRow[]
  /** 値引き・源泉徴収などの印字（なければ空配列。省略時も空とみなす） */
  adjustments?: AdjustmentRow[]
  /** 合計欄・消費税の行に印字された税率（「消費税（10%）」「うち消費税 10%」→ [10]）。印字がなければ空配列。省略時も空 */
  printed_tax_rates?: number[]
}

export type AmountMessage = { level: 'info' | 'warn'; text: string }

/**
 * 照合の内訳。金額の計算が合うことと、税区分・税率が原本の印字と合うことは別々に評価する
 * （計算が合っていても税区分が印字と矛盾していれば「整合OK」にしない）。
 * - arithmetic: consistent = 印字どうしの計算が合う / inconsistent = 合わない / unverifiable = 照合できる金額がそろわない
 * - treatment:  consistent = 税区分と印字された金額の組み合わせが合う / inconsistent = 合わない / unknown = 税区分が不明
 * - tax_rate:   consistent = 原本に印字された税率で消費税額を検算できた / inconsistent = 合わない / not_checked = 税率の印字がない等で検算しない
 */
export type AmountChecks = {
  arithmetic: 'consistent' | 'inconsistent' | 'unverifiable'
  treatment: 'consistent' | 'inconsistent' | 'unknown'
  tax_rate: 'consistent' | 'inconsistent' | 'not_checked'
}

export type AmountReview = {
  /** 登録金額（税抜）の候補。判断できなければ null（人が入力する） */
  suggested_excl_tax: number | null
  /** 候補の出どころ */
  suggested_from: 'printed_subtotal' | 'printed_total_minus_tax' | 'non_taxable_total' | null
  /** ok = 印字された金額どうしに矛盾がなく税抜の候補がある / needs_review = 人が原本で確かめる必要がある */
  status: 'ok' | 'needs_review'
  checks: AmountChecks
  messages: AmountMessage[]
}

const MAX_AMOUNT = 1e12

const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`

/** AI の出力を金額として受け取る（数値・カンマ付き文字列。負数・非有限・桁外れは null） */
export function toAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[,，\s¥￥円]/g, ''))
    : NaN
  return Number.isFinite(n) && n >= 0 && n < MAX_AMOUNT ? n : null
}

const TREATMENTS: readonly TaxTreatment[] = ['exclusive', 'inclusive', 'non_taxable', 'unknown']
const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['discount', 'withholding', 'other']

/** AI の出力の数値を、印字の絶対値として受け取る（「-1,000」「▲1,000」「△1,000」も 1,000） */
function toAbsAmount(v: unknown): number | null {
  if (typeof v === 'number') return toAmount(Math.abs(v))
  if (typeof v === 'string') return toAmount(v.replace(/^[\s]*[-−‐ー▲△]/, ''))
  return null
}

/** AI の出力（形は信用しない）を PrintedAmounts に揃える */
export function toPrintedAmounts(raw: unknown): PrintedAmounts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const breakdown = Array.isArray(r.tax_breakdown) ? r.tax_breakdown : []
  return {
    subtotal_excl_tax: toAmount(r.subtotal_excl_tax),
    tax_amount:        toAmount(r.tax_amount),
    total_incl_tax:    toAmount(r.total_incl_tax),
    tax_treatment:     TREATMENTS.includes(r.tax_treatment as TaxTreatment) ? r.tax_treatment as TaxTreatment : 'unknown',
    tax_breakdown: breakdown.slice(0, 10).map(b => {
      const row = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
      const rate = toAmount(row.rate)
      return {
        rate: rate != null && rate <= 100 ? rate : null,
        taxable_amount: toAmount(row.taxable_amount),
        tax_amount: toAmount(row.tax_amount),
      }
    }),
    adjustments: (Array.isArray(r.adjustments) ? r.adjustments : []).slice(0, 10).map(a => {
      const row = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
      return {
        kind: ADJUSTMENT_KINDS.includes(row.kind as AdjustmentKind) ? row.kind as AdjustmentKind : 'other',
        amount: toAbsAmount(row.amount),
      }
    }),
    printed_tax_rates: [...new Set((Array.isArray(r.printed_tax_rates) ? r.printed_tax_rates : []).slice(0, 5)
      .map(toAmount).filter((x): x is number => x != null && x > 0 && x <= 100))],
  }
}

/** 計算した税額 t を、端数処理（切り捨て・四捨五入・切り上げ）のどれかで tax と説明できるか */
const roundsTo = (t: number, tax: number) => [Math.floor(t), Math.round(t), Math.ceil(t)].includes(tax)

/** 税抜金額 × 税率 の消費税として、端数処理（切り捨て・四捨五入・切り上げ）のどれかで説明できるか */
function plausibleTax(excl: number, tax: number): boolean {
  return [10, 8].some(rate => roundsTo((excl * rate) / 100, tax))
}

/**
 * 印字された税率で消費税額を説明できるか。対象額が税抜（× 税率）でも税込（× 税率 ÷ (100 + 税率)）でもよい
 * （内税の請求書は「10%対象 ¥110,000（うち消費税 ¥10,000）」のように税込の対象額を印字することがある）
 */
function taxMatchesRate(base: { excl: number | null; incl: number | null }, rate: number, tax: number): boolean {
  return (base.excl != null && roundsTo((base.excl * rate) / 100, tax))
    || (base.incl != null && roundsTo((base.incl * rate) / (100 + rate), tax))
}

/**
 * 印字された金額を照合し、登録金額（税抜）の候補と、確認が必要な点を返す。
 * 候補は計算で作らない（例外は 税込合計 − 印字された消費税額。どちらも原本の値）。
 */
export function reviewInvoiceAmounts(a: PrintedAmounts): AmountReview {
  const { subtotal_excl_tax: ex, tax_amount: tax, total_incl_tax: inc } = a
  const messages: AmountMessage[] = []
  const warn = (text: string) => messages.push({ level: 'warn', text })
  const info = (text: string) => messages.push({ level: 'info', text })

  let suggested: number | null = null
  let from: AmountReview['suggested_from'] = null
  let needsReview = false
  // 印字どうしの計算が合わないことが分かった
  let arithmeticBad = false

  // 税率の内訳（8%・10% 混在など）
  const rates = [...new Set(a.tax_breakdown.map(b => b.rate).filter((r): r is number => r != null))].sort((x, y) => y - x)
  if (rates.length > 1) info(`税率が混在しています（${rates.map(r => `${r}%`).join('・')}）。合計の税抜金額を登録します`)
  const rows = a.tax_breakdown.filter(b => b.taxable_amount != null || b.tax_amount != null)
  if (rates.length > 1) {
    const complete = rows.length > 0 && a.tax_breakdown.every(b => b.rate != null && b.taxable_amount != null && b.tax_amount != null)
    if (!complete || ex == null) {
      warn('税率が混在していますが、税率ごとの対象額・税額または税抜金額を読み取りきれませんでした。原本で確認してください')
      needsReview = true
    }
  }
  if (rows.length > 0) {
    const sumTaxable = rows.every(b => b.taxable_amount != null) ? rows.reduce((s, b) => s + (b.taxable_amount ?? 0), 0) : null
    const sumTax = rows.every(b => b.tax_amount != null) ? rows.reduce((s, b) => s + (b.tax_amount ?? 0), 0) : null
    if (ex != null && sumTaxable != null && sumTaxable !== ex) {
      warn(`税率ごとの対象額の合計（${yen(sumTaxable)}）が税抜金額（${yen(ex)}）と一致しません`)
      needsReview = true
    }
    if (tax != null && sumTax != null && sumTax !== tax) {
      warn(`税率ごとの消費税額の合計（${yen(sumTax)}）が消費税額（${yen(tax)}）と一致しません`)
      needsReview = true
    }
    if ((ex != null && sumTaxable != null && sumTaxable !== ex) || (tax != null && sumTax != null && sumTax !== tax)) arithmeticBad = true
  }

  if (a.tax_treatment === 'non_taxable') {
    // 非課税・不課税: 税込 = 税抜
    const base = ex ?? inc
    if (base == null) {
      warn('非課税と読み取りましたが、金額を読み取れませんでした')
      needsReview = true
    } else {
      suggested = base
      from = ex != null ? 'printed_subtotal' : 'non_taxable_total'
      info('非課税の請求書として読み取りました（消費税なし）。原本で確認してください')
      if (tax != null && tax > 0) { warn('非課税と読み取りましたが、消費税額が記載されています'); needsReview = true }
      if (ex != null && inc != null && ex !== inc) { warn('非課税と読み取りましたが、税抜金額と合計が一致しません'); needsReview = true; arithmeticBad = true }
    }
  } else if (ex != null) {
    suggested = ex
    from = 'printed_subtotal'
    if (tax != null && inc != null) {
      if (ex + tax !== inc) {
        warn(`税抜金額 ${yen(ex)} ＋ 消費税額 ${yen(tax)} が税込合計 ${yen(inc)} と一致しません（差 ${yen(Math.abs(ex + tax - inc))}）。値引き・端数処理を原本で確認してください`)
        needsReview = true; arithmeticBad = true
      }
    } else if (tax == null && inc == null) {
      warn('消費税額・税込合計の記載を読み取れませんでした。この金額が税抜かどうか原本で確認してください')
      needsReview = true
    } else if (tax == null && inc != null) {
      if (inc < ex) { warn('税込合計が税抜金額より小さくなっています'); needsReview = true; arithmeticBad = true }
      else if (!plausibleTax(ex, inc - ex)) {
        // 差額が 10%・8% の消費税として説明できない（値引き・別の費用・読み違いの可能性）
        warn(`税込合計 ${yen(inc)} − 税抜金額 ${yen(ex)} = ${yen(inc - ex)} が消費税（10%・8%）と合いません。原本で確認してください`)
        needsReview = true; arithmeticBad = true
      } else info('消費税額の記載はありません（税込合計 − 税抜金額 で確認できます）')
    }
  } else if (inc != null && tax != null) {
    if (tax > inc) {
      warn('消費税額が税込合計より大きくなっています')
      needsReview = true; arithmeticBad = true
    } else {
      suggested = inc - tax
      from = 'printed_total_minus_tax'
      info(`税抜金額の記載がないため、税込合計 ${yen(inc)} − 消費税額 ${yen(tax)} を税抜金額の候補にしました`)
    }
  } else if (inc != null) {
    warn('税込合計しか読み取れませんでした。税抜金額を原本で確認して入力してください（税込から割り戻した金額は使いません）')
    needsReview = true
  } else {
    warn('金額を読み取れませんでした。原本を見て税抜金額を入力してください')
    needsReview = true
  }

  // 値引き・源泉徴収などがある請求書は、税抜金額がどの段階の金額か印字だけでは決めきれないため、必ず要確認にする
  const adjustments = a.adjustments ?? []
  const hasDiscount = adjustments.some(x => x.kind === 'discount')
  const hasWithholding = adjustments.some(x => x.kind === 'withholding')
  const hasOther = adjustments.some(x => x.kind === 'other')
  const consistent = ex != null && tax != null && inc != null && ex + tax === inc
  if (hasWithholding) {
    // 源泉徴収後の「差引請求額」を税込合計として読んでいる可能性がある。税込 − 消費税 は候補にしない。
    // 原価台帳には源泉徴収前の税抜金額を登録する（源泉所得税は支払時に差し引く税で、原価は減らない）
    warn('源泉徴収の記載があります。登録金額は源泉徴収前の税抜金額です。原本で確認してください')
    needsReview = true
    if (from === 'printed_total_minus_tax' || (from === 'printed_subtotal' && !consistent)) {
      suggested = null
      from = null
    }
  }
  if (hasDiscount) {
    warn('値引きの記載があります。税抜金額が値引き後の金額か原本で確認してください')
    needsReview = true
    // 印字された税抜金額が税込合計と合わない（値引き前の小計の可能性）。源泉徴収がなければ、印字された 税込合計 − 消費税額 を候補にする
    if (!hasWithholding && from === 'printed_subtotal' && !consistent && inc != null && tax != null && tax <= inc) {
      suggested = inc - tax
      from = 'printed_total_minus_tax'
      info(`印字された税抜金額は値引き前の可能性があるため、税込合計 ${yen(inc)} − 消費税額 ${yen(tax)} を税抜金額の候補にしました`)
    }
  }
  if (hasOther) {
    warn('小計と合計のあいだに値引き・源泉徴収以外の増減（調整・相殺など）があります。原本で確認してください')
    needsReview = true
  }

  // ── 税区分と印字された金額の組み合わせ（計算の一致とは別に評価する）──
  let treatmentCheck: AmountChecks['treatment'] = 'consistent'
  if (a.tax_treatment === 'unknown') {
    treatmentCheck = 'unknown'
    warn('税区分（外税・内税・非課税）を読み取れませんでした。原本で確認して選んでください')
    needsReview = true
  } else if (a.tax_treatment === 'exclusive' && ex == null && inc != null) {
    // 外税の請求書なら税抜（小計）が印字されるはず。税込と消費税だけなら内税の可能性が高い
    treatmentCheck = 'inconsistent'
    warn('外税になっていますが、原本に税抜金額の記載がありません。内税ではないか原本で確認してください')
    needsReview = true
  } else if (a.tax_treatment === 'inclusive' && inc == null && ex != null) {
    treatmentCheck = 'inconsistent'
    warn('内税になっていますが、原本に税込合計の記載がありません。外税ではないか原本で確認してください')
    needsReview = true
  } else if (a.tax_treatment === 'non_taxable' && tax != null && tax > 0) {
    treatmentCheck = 'inconsistent'
  }

  // ── 原本に印字された税率での消費税額の検算（印字がある場合だけ。10% 固定では判定しない）──
  // 値引き・源泉徴収などがあると対象額がどの段階か決めきれないため検算しない（すでに要確認）
  let rateCheck: AmountChecks['tax_rate'] = 'not_checked'
  if (a.tax_treatment !== 'non_taxable' && adjustments.length === 0) {
    const checkedRows = a.tax_breakdown.filter(b => b.rate != null && b.tax_amount != null && b.taxable_amount != null)
    const printedRates = a.printed_tax_rates ?? []
    if (checkedRows.length > 0) {
      // 税率ごとの内訳: 行ごとに 対象額 × 税率 を検算する（8%・10% 混在に対応）
      const bad = checkedRows.filter(b => !taxMatchesRate({ excl: b.taxable_amount, incl: b.taxable_amount }, b.rate!, b.tax_amount!))
      rateCheck = bad.length === 0 ? 'consistent' : 'inconsistent'
      for (const b of bad) warn(`${b.rate}% の対象額 ${yen(b.taxable_amount!)} に対して消費税額 ${yen(b.tax_amount!)} が合いません。原本で確認してください`)
    } else if (tax != null && (ex != null || inc != null)) {
      // 内訳の行がない（または対象額が印字されていない）: 合計欄に印字された税率がちょうど 1 つのときだけ検算する。
      // 税率が複数印字されていて内訳がなければ、税率ごとの対象額が分からないので検算しない
      const rowRates = [...new Set(a.tax_breakdown.map(b => b.rate).filter((r): r is number => r != null))]
      const candidates = rowRates.length === 1 ? rowRates : rowRates.length === 0 ? printedRates : []
      if (candidates.length === 1) {
        const rate = candidates[0]
        if (taxMatchesRate({ excl: ex, incl: inc }, rate, tax)) rateCheck = 'consistent'
        else {
          rateCheck = 'inconsistent'
          warn(`消費税額 ${yen(tax)} が、原本の税率 ${rate}% で計算した額と合いません。原本で確認してください`)
        }
      }
    }
    if (rateCheck === 'inconsistent') needsReview = true
  }

  const arithmetic: AmountChecks['arithmetic'] = arithmeticBad ? 'inconsistent'
    : (ex != null && tax != null && inc != null) || (a.tax_treatment === 'non_taxable' && ex != null && inc != null) ? 'consistent'
    : 'unverifiable'

  if (suggested != null && !Number.isInteger(suggested)) {
    warn('金額に 1 円未満の端数があります。原本で確認してください')
    needsReview = true
  }
  if (suggested === 0) {
    warn('税抜金額が 0 円です。原本で確認してください')
    suggested = null
    from = null
    needsReview = true
  }

  return {
    suggested_excl_tax: suggested,
    suggested_from: from,
    status: needsReview || suggested == null ? 'needs_review' : 'ok',
    checks: { arithmetic, treatment: treatmentCheck, tax_rate: rateCheck },
    messages,
  }
}

/**
 * 登録金額が原本の税抜と食い違う危険。あれば警告と追加の確認を求める（正当な例外は確認すれば登録できる）。
 * - total_incl: 登録金額が税込合計と同じ（税込を税抜として登録しようとしている可能性が高い）
 * - differs: 原本の印字から決まる税抜の候補と違う
 */
export function registerAmountRisk(
  registered: number | null,
  review: Pick<AmountReview, 'suggested_excl_tax'>,
  printed: { excl: number | null; incl: number | null; treatment: TaxTreatment },
): { kind: 'total_incl' | 'differs'; message: string; confirmLabel: string } | null {
  if (registered === null) return null
  const suggestion = review.suggested_excl_tax
  if (printed.treatment !== 'non_taxable' && printed.incl != null && registered === printed.incl && registered !== printed.excl) {
    return {
      kind: 'total_incl',
      message: `登録金額 ${yen(registered)} は税込合計と同じです。原価台帳は税抜で集計します`
        + (suggestion != null && suggestion !== registered ? `（原本の税抜は ${yen(suggestion)}）` : ''),
      confirmLabel: '税込合計と同じ金額を、税抜として登録する',
    }
  }
  if (suggestion != null && registered !== suggestion) {
    return {
      kind: 'differs',
      message: `登録金額 ${yen(registered)} は原本の税抜 ${yen(suggestion)} と異なります`,
      confirmLabel: '原本の税抜と異なる金額で登録する',
    }
  }
  return null
}
