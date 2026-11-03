/**
 * 見積書画像 OCR（app/api/ai/extract-estimate）の応答の正規化と、明細の照合。
 *
 * 取り込むのは「業者から自社への見積」の**仕入れ単価（cost_price）**。顧客向けの売価は AI に出させない
 * （売価は取り込み時に案件の掛け率で計算する。app/api/estimate-items/import）。
 *
 * - AI の出力は形・型を信用しない（文字列の数値・欠けた項目・桁外れの値を取り除く）。
 * - 金額は原本に印字された値だけを使う。AI に計算させない（金額 ÷ 数量 で単価を作らせない）。
 *   例外は「数量 1 で単価欄が空・金額だけ印字」の行で、印字された金額をそのまま単価とする（計算ではない）。
 * - 定価・掛率・単価・金額の取り違えは、印字された値どうしの決定的な照合で見つけて「要確認」にする。
 *   AI に正誤を判断させない。値を直すのは人。
 *
 * サーバー（AI の読み取り結果の検査）と画面（人が直した値の検査）の両方で使う。
 */

export type OcrMessage = { level: 'info' | 'warn'; text: string }

export type AdjustmentRow = { label: string; amount: number | null }

/** 読み取った明細 1 行（金額は原本に印字された値。読めなければ null） */
export type EstimateOcrItem = {
  name: string
  /** 印字された数量。読めなければ null（取り込み時は 1 として扱う） */
  quantity: number | null
  unit: string | null
  /** 仕入れ単価（自社が業者に払う単価） */
  cost_price: number | null
  /** cost_price の出どころ。printed_unit_price = 単価欄 / amount_with_qty1 = 数量 1 の行の金額欄 */
  cost_from: 'printed_unit_price' | 'amount_with_qty1' | null
  /** 定価（掛率の掛かる前の金額）。印字が無ければ null */
  list_price: number | null
  /** 掛率（0〜1 の比率）。印字が無ければ null */
  rate: number | null
  /** 明細の金額欄（数量 × 単価）。印字が無ければ null */
  amount: number | null
  vendor_name: string | null
  note: string | null
}

export type EstimateOcrFile = {
  fileName: string
  supplier: string
  document_type: string
  items: EstimateOcrItem[]
  /** 印字された小計（税抜）。無ければ null */
  subtotal: number | null
  /** 明細外の増減（値引き・調整など）。見積の原価には自動で入れない */
  adjustments: AdjustmentRow[]
  /** 原本の明細行の数（AI が数えたもの）。数えられなければ null */
  items_total: number | null
  /** 単価が税込と明記されているか */
  prices_include_tax: boolean
  /** 画像全体についての確認事項（AI の注意書きを含む） */
  messages: OcrMessage[]
}

/** 1 枚の画像から取り込む明細の上限（これを超える分は捨てて警告する） */
export const MAX_ITEMS_PER_FILE = 150

const MAX_AMOUNT = 1e10
const yen = (n: number) => `¥${n.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}`
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strOrNull = (v: unknown, max: number) => str(v, max) || null

/** 数値として受け取る（数値・カンマ付き文字列。負数・非有限・桁外れは null） */
export function toOcrNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[,，\s¥￥円]/g, ''))
    : NaN
  return Number.isFinite(n) && n >= 0 && n < MAX_AMOUNT ? n : null
}

/** 掛率を 0〜1 の比率に揃える（60 / "60%" → 0.6、"0.6" → 0.6）。範囲外は null */
export function toRate(v: unknown): number | null {
  const n = toOcrNumber(typeof v === 'string' ? v.replace(/[%％]/g, '') : v)
  if (n == null || n === 0) return null
  if (n <= 1) return n
  if (n <= 100) return n / 100
  return null
}

/** 印字された金額どうしの差として許す幅（1 円の端数処理） */
const TOLERANCE = 1
const near = (a: number, b: number, tol = TOLERANCE) => Math.abs(a - b) <= tol

/**
 * 明細 1 行の照合。数量 × 単価 と 金額、定価 × 掛率 と 単価 を突き合わせ、取り違え・読み違いの疑いを返す。
 * 人が値を直したあと画面でも呼ぶ（そのとき quantity は人が入力した値）。
 */
export function reviewEstimateItem(item: Pick<EstimateOcrItem, 'quantity' | 'cost_price' | 'cost_from' | 'list_price' | 'rate' | 'amount'>): OcrMessage[] {
  const messages: OcrMessage[] = []
  const warn = (text: string) => messages.push({ level: 'warn', text })
  const info = (text: string) => messages.push({ level: 'info', text })
  const { quantity: q, cost_price: c, list_price: list, rate, amount } = item

  if (q == null) warn('数量を読み取れなかったため 1 としました。原本で確認してください')
  else if (q === 0) warn('数量が 0 です。原本で確認してください')

  if (c == null) {
    warn(amount != null
      ? `単価の記載を読み取れませんでした（金額 ${yen(amount)}）。原本で確認して単価を入力してください`
      : '単価を読み取れませんでした。原本で確認して入力してください')
    return messages
  }
  if (c === 0) warn('単価が 0 円です。原本で確認してください')
  if (item.cost_from === 'amount_with_qty1') info('単価欄が空のため、数量 1 の金額欄の値を単価にしました')

  // 定価・掛率・単価の取り違え
  if (list != null && rate != null && rate < 1) {
    if (near(c, list) && list > 0) {
      warn(`単価が定価（${yen(list)}）と同じです。掛率 ${Math.round(rate * 1000) / 10}% を掛けた後の単価か、原本で確認してください`)
    } else if (!near(list * rate, c, Math.max(TOLERANCE, c * 0.001))) {
      warn(`定価 ${yen(list)} × 掛率 ${Math.round(rate * 1000) / 10}% が単価 ${yen(c)} と一致しません。列の読み違いがないか原本で確認してください`)
    }
  } else if (list != null && rate == null && c > list) {
    warn(`単価（${yen(c)}）が定価（${yen(list)}）より高くなっています。列の読み違いがないか原本で確認してください`)
  }

  // 数量 × 単価 と 金額
  if (amount != null && q != null && q > 0) {
    if (!near(q * c, amount)) {
      if (q > 1 && near(c, amount)) {
        warn(`単価が金額（${yen(amount)}）と同じです。金額欄を単価として読んだ可能性があります。原本で確認してください`)
      } else {
        warn(`数量 ${q} × 単価 ${yen(c)} = ${yen(q * c)} が金額 ${yen(amount)} と一致しません。原本で確認してください`)
      }
    }
  }
  return messages
}

export const needsReview = (messages: OcrMessage[]) => messages.some(m => m.level === 'warn')

/** 画像全体の照合（明細の金額合計と小計、増減の行、明細の数） */
export function reviewEstimateFile(f: Pick<EstimateOcrFile, 'items' | 'subtotal' | 'adjustments' | 'items_total' | 'prices_include_tax'>, aiWarnings: string[] = [], droppedItems = 0): OcrMessage[] {
  const messages: OcrMessage[] = []
  const warn = (text: string) => messages.push({ level: 'warn', text })

  if (f.prices_include_tax) warn('単価が税込と書かれています。原価は税抜で登録するため、原本で確認してください')

  for (const a of f.adjustments) {
    warn(`原本に「${a.label || '値引き・調整'}」${a.amount != null ? ` ${yen(a.amount)}` : ''} があります。見積の原価には反映していません。必要なら見積エディタで調整してください`)
  }

  if (f.subtotal != null && f.items.length > 0 && f.items.every(i => i.amount != null)) {
    const sum = f.items.reduce((s, i) => s + (i.amount ?? 0), 0)
    if (!near(sum, f.subtotal)) {
      warn(`読み取った明細の金額合計 ${yen(sum)} が小計 ${yen(f.subtotal)} と一致しません。読み落とし・読み違いがないか原本で確認してください（複数ページの見積書では、他のページの分を含む場合があります）`)
    }
  }

  if (droppedItems > 0) {
    warn(`明細が多いため、最初の ${MAX_ITEMS_PER_FILE} 行だけを取り込みました（残り ${droppedItems} 行）。画像を分けて読み取ってください`)
  } else if (f.items_total != null && f.items_total > f.items.length) {
    warn(`原本の明細は ${f.items_total} 行ありますが、${f.items.length} 行しか読み取れませんでした。残りは原本で確認してください`)
  }

  for (const w of aiWarnings) warn(`AI の注意書き: ${w}`)
  return messages
}

/**
 * AI の出力を画面に返す形に揃える（形・型は信用しない）。
 * 単価の補完は「数量 1 の行の印字された金額」だけ。それ以外の計算はしない。
 */
export function normalizeEstimateExtraction(raw: unknown, fileName: string): EstimateOcrFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const supplier = str(r.supplier, 200)
  const rawItems = Array.isArray(r.items) ? r.items : []

  const items: EstimateOcrItem[] = rawItems.map(i => {
    const it = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>
    const quantity = toOcrNumber(it.quantity)
    const printedUnit = toOcrNumber(it.cost_price)
    const amount = toOcrNumber(it.amount)
    let cost_price = printedUnit
    let cost_from: EstimateOcrItem['cost_from'] = printedUnit != null ? 'printed_unit_price' : null
    if (cost_price == null && amount != null && quantity === 1) {
      cost_price = amount
      cost_from = 'amount_with_qty1'
    }
    return {
      name: str(it.name, 200),
      quantity,
      unit: strOrNull(it.unit, 20),
      cost_price,
      cost_from,
      list_price: toOcrNumber(it.list_price),
      rate: toRate(it.rate),
      amount,
      vendor_name: strOrNull(it.vendor_name, 200) ?? (supplier || null),
      note: strOrNull(it.note, 500),
    }
  }).filter(i => i.name !== '')

  const dropped = Math.max(0, items.length - MAX_ITEMS_PER_FILE)
  const kept = items.slice(0, MAX_ITEMS_PER_FILE)

  const adjustments: AdjustmentRow[] = (Array.isArray(r.adjustments) ? r.adjustments : []).slice(0, 10).map(a => {
    const row = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    return { label: str(row.label, 50), amount: toOcrNumber(row.amount) }
  }).filter(a => a.label || a.amount != null)

  const itemsTotal = toOcrNumber(r.items_total)
  const aiWarnings = [
    ...(Array.isArray(r.warnings) ? r.warnings : []),
    ...(typeof r.raw_warning === 'string' ? [r.raw_warning] : []),
  ].map(w => str(w, 300)).filter(Boolean).slice(0, 10)

  const file = {
    fileName: fileName.slice(0, 200),
    supplier,
    document_type: str(r.document_type, 50),
    items: kept,
    subtotal: toOcrNumber(r.subtotal),
    adjustments,
    items_total: itemsTotal != null && Number.isInteger(itemsTotal) ? itemsTotal : null,
    prices_include_tax: r.prices_include_tax === true,
  }
  return { ...file, messages: reviewEstimateFile(file, aiWarnings, dropped) }
}
