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

/** 原本に印字された金額（読めないものは null） */
export type PrintedAmounts = {
  subtotal_excl_tax: number | null
  tax_amount: number | null
  total_incl_tax: number | null
  tax_treatment: TaxTreatment
  tax_breakdown: TaxBreakdownRow[]
}

export type AmountMessage = { level: 'info' | 'warn'; text: string }

export type AmountReview = {
  /** 登録金額（税抜）の候補。判断できなければ null（人が入力する） */
  suggested_excl_tax: number | null
  /** 候補の出どころ */
  suggested_from: 'printed_subtotal' | 'printed_total_minus_tax' | 'non_taxable_total' | null
  /** ok = 印字された金額どうしに矛盾がなく税抜の候補がある / needs_review = 人が原本で確かめる必要がある */
  status: 'ok' | 'needs_review'
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
  }
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

  // 税率の内訳（8%・10% 混在など）
  const rates = [...new Set(a.tax_breakdown.map(b => b.rate).filter((r): r is number => r != null))].sort((x, y) => y - x)
  if (rates.length > 1) info(`税率が混在しています（${rates.map(r => `${r}%`).join('・')}）。合計の税抜金額を登録します`)
  const rows = a.tax_breakdown.filter(b => b.taxable_amount != null || b.tax_amount != null)
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
      if (ex != null && inc != null && ex !== inc) { warn('非課税と読み取りましたが、税抜金額と合計が一致しません'); needsReview = true }
    }
  } else if (ex != null) {
    suggested = ex
    from = 'printed_subtotal'
    if (tax != null && inc != null) {
      if (ex + tax !== inc) {
        warn(`税抜金額 ${yen(ex)} ＋ 消費税額 ${yen(tax)} が税込合計 ${yen(inc)} と一致しません（差 ${yen(Math.abs(ex + tax - inc))}）。値引き・端数処理を原本で確認してください`)
        needsReview = true
      }
    } else if (tax == null && inc == null) {
      warn('消費税額・税込合計の記載を読み取れませんでした。この金額が税抜かどうか原本で確認してください')
      needsReview = true
    } else if (tax == null && inc != null) {
      if (inc < ex) { warn('税込合計が税抜金額より小さくなっています'); needsReview = true }
      else info('消費税額の記載はありません（税込合計 − 税抜金額 で確認できます）')
    }
  } else if (inc != null && tax != null) {
    if (tax > inc) {
      warn('消費税額が税込合計より大きくなっています')
      needsReview = true
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
    messages,
  }
}
