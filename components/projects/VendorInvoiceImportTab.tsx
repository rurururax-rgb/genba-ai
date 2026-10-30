'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  createRegisterAttempt, postInvoice,
  type ExistingDocument, type RegisterAttempt, type SimilarInvoiceSummary,
} from '@/lib/cost-ledger/invoice-client'
import { registerAmountRisk, reviewInvoiceAmounts, toAmount, type AdjustmentKind, type AmountReview, type TaxTreatment } from '@/lib/cost-ledger/ocr-amounts'
import type { ExtractedVendorInvoice } from '@/lib/cost-ledger/ocr-extraction'
import { checkInvoiceImageFile, formatMegabytes, prepareInvoiceImage } from '@/lib/cost-ledger/invoice-image'

// ── 型定義 ────────────────────────────────────────────────

type CostLedgerItem = {
  id: string
  name: string
  vendor_name: string | null
  estimate_cost: number | null
  actual_cost: number | null
}

/** 登録できなかった・登録できたか分からないときの案内 */
type Blocker =
  | { kind: 'duplicate'; existing: ExistingDocument | null }
  | { kind: 'similar'; similar: SimilarInvoiceSummary[] }
  | { kind: 'unknown'; message: string }

/** 登録できたときの結果（画面は DB が返した値で表示する） */
type SavedState = { actualCost: number | null; synced: boolean; replayed: boolean; amount: number }
// ── デザイントークン（EstimateImportTab と共通）──────────

const G = {
  dark:        '#2B5E40',
  med:         '#3D7A55',
  light:       '#E3EFE7',
  hover:       '#EDF5EF',
  cardBg:      '#FFFFFF',
  border:      '#BDD1C3',
  borderLight: '#DFF0E4',
  textPri:     '#192C1F',
  textSec:     '#4E6557',
  textTer:     '#8AA491',
} as const

const fmt = (n: number) => Math.round(n).toLocaleString('ja-JP')

const TREATMENT_LABEL: Record<TaxTreatment, string> = {
  exclusive:   '外税（税抜＋消費税）',
  inclusive:   '内税（税込金額のみ）',
  non_taxable: '非課税・不課税',
  unknown:     '不明',
}

const ADJUSTMENT_LABEL: Record<AdjustmentKind, string> = {
  discount:    '値引き',
  withholding: '源泉徴収',
  other:       'その他の増減',
}

const ZOOMS = [1, 1.5, 2, 3] as const

type Props = {
  projectId: string
  /** 登録できたとき（再送で保存済みだったときも）。親は台帳と内訳を DB から読み直す */
  onRegistered?: (itemId: string) => void
}

/** 金額欄の文字列を数値にする（カンマ・円記号可。数値以外が混ざっていれば null。0 は登録できないので null） */
function parseAmount(v: string): number | null {
  const t = v.replace(/[,，\s¥￥円]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n !== 0 ? n : null
}

/** 原本の金額欄（空欄 = 記載なし） */
const amountText = (n: number | null) => (n != null ? String(n) : '')

export function VendorInvoiceImportTab({ projectId, onRegistered }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile]             = useState<File | null>(null)
  const [preview, setPreview]       = useState<string | null>(null)
  const [zoom, setZoom]             = useState<number>(1)
  const [dragging, setDragging]     = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  // 送信前に画像を縮小したときの案内（元の大きさ → 送った大きさ）
  const [uploadNote, setUploadNote] = useState<string | null>(null)

  const [extracted, setExtracted]   = useState<ExtractedVendorInvoice | null>(null)
  const [vendorName, setVendorName] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  // 支払日 = 実際に支払った日（原価台帳の「支払日」）。請求書の支払期日は入れない
  const [paymentDate, setPaymentDate] = useState('')
  const [note, setNote]             = useState('')

  // 原本に印字された金額（人が直せる）。登録金額とは分けて持つ
  const [printedEx, setPrintedEx]   = useState('')
  const [printedTax, setPrintedTax] = useState('')
  const [printedInc, setPrintedInc] = useState('')
  const [treatment, setTreatment]   = useState<TaxTreatment>('unknown')
  // 原価台帳に登録する金額（税抜）と、その金額を担当者が原本で確認したか
  const [registerAmount, setRegisterAmount] = useState('')
  const [confirmed, setConfirmed]   = useState(false)
  // 登録金額が原本の税抜（候補）と違う・税込合計と同じときの追加の確認
  const [deviationConfirmed, setDeviationConfirmed] = useState(false)

  const [ledgerItems, setLedgerItems] = useState<CostLedgerItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string>('')

  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState<SavedState | null>(null)
  const [blocker, setBlocker]       = useState<Blocker | null>(null)

  // 画像ごとの世代。画像を変えたら古い読み取り結果・タイマーは捨てる
  const genRef = useRef(0)
  const extractAbortRef = useRef<AbortController | null>(null)
  // 1回の登録操作（送信中の二重送信を止め、再試行では同じ idempotency_key を使う）
  // （中身は書き換わるが、画面の表示には使わない。連打の判定に再描画を待たないため state にしない）
  const [attempt] = useState<RegisterAttempt>(() => createRegisterAttempt())

  // 原価台帳アイテムを取得
  const loadLedgerItems = useCallback(() => {
    fetch(`/api/cost-ledger?project_id=${projectId}`)
      .then(r => r.json())
      .then(data => {
        if (data.items) setLedgerItems(data.items as CostLedgerItem[])
      })
      .catch(() => {/* ignore */})
  }, [projectId])

  useEffect(() => { loadLedgerItems() }, [loadLedgerItems])

  useEffect(() => () => { extractAbortRef.current?.abort() }, [])

  /** 画像を変えた・登録が終わった。読み取り結果・画像ハッシュ・登録キーをすべて捨てる */
  const clearDocument = useCallback(() => {
    genRef.current += 1
    extractAbortRef.current?.abort()
    extractAbortRef.current = null
    attempt.reset()
    setLoading(false)
    setExtracted(null)
    setVendorName('')
    setInvoiceNumber('')
    setInvoiceDate('')
    setPaymentDate('')
    setNote('')
    setPrintedEx('')
    setPrintedTax('')
    setPrintedInc('')
    setTreatment('unknown')
    setRegisterAmount('')
    setConfirmed(false)
    setDeviationConfirmed(false)
    setSelectedItemId('')
    setSaved(null)
    setBlocker(null)
    setError(null)
    setUploadNote(null)
  }, [attempt])

  // ファイルセット
  const handleFile = useCallback((f: File) => {
    // 登録の送信中は画像を変えない（どの画像の登録か分からなくなる）
    if (attempt.busy) return
    // 前の画像の選択・プレビュー・読み取り結果・登録候補は、新しいファイルが使えるかどうかに関係なく捨てる
    // （使えないファイルを選んだあとに、前の請求書を読み取ったり登録したりできないようにする）
    clearDocument()
    setFile(null)
    setPreview(null)
    setZoom(1)
    // HEIC・PDF など対応していない形式は理由と対処を案内する。大きい画像は読み取り時に縮小して送る
    const check = checkInvoiceImageFile(f)
    if (!check.ok) {
      setError(check.message)
      return
    }
    setFile(f)
    const gen = genRef.current
    const reader = new FileReader()
    reader.onload = e => { if (genRef.current === gen) setPreview(e.target?.result as string) }
    reader.readAsDataURL(f)
  }, [attempt, clearDocument])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) handleFile(dropped)
  }, [handleFile])

  const pickFile = () => { if (!saving && !attempt.busy) inputRef.current?.click() }

  // AI抽出
  const extract = async () => {
    if (!file || loading) return
    const gen = genRef.current
    const ctrl = new AbortController()
    extractAbortRef.current = ctrl
    setLoading(true)
    setError(null)
    setUploadNote(null)
    try {
      // 送信前に 3.5MB 以下へ縮小する（Vercel の 4.5MB 制限）。縮小できなければ送らずに案内する
      const prepared = await prepareInvoiceImage(file)
      if (genRef.current !== gen) return
      if (!prepared.ok) throw new Error(prepared.message)
      if (prepared.resized) {
        setUploadNote(`送信用に画像を縮小しました（${formatMegabytes(prepared.originalBytes)} → ${formatMegabytes(prepared.file.size)}）。数字が読みにくければ撮り直してください`)
      }
      const fd = new FormData()
      fd.append('file', prepared.file)
      const res = await fetch('/api/ai/extract-vendor-invoice', { method: 'POST', body: fd, signal: ctrl.signal })
      // サーバーに届く前に断られた場合（Vercel の容量制限など）は JSON ではない
      const data = await res.json().catch(() => null)
      // 読み取り中に画像が変わった。古い結果は使わない
      if (genRef.current !== gen) return
      if (!res.ok || !data) {
        throw new Error(data?.error ?? (res.status === 413
          ? '画像が大きすぎて送れませんでした。請求書の部分だけが写るように撮り直してください'
          : '読み取りに失敗しました。時間をおいてもう一度お試しください'))
      }
      const result = data as ExtractedVendorInvoice
      if (typeof result.document_sha256 !== 'string' || !result.amounts || !result.review) throw new Error('AI抽出に失敗しました')
      // 新しい画像の読み取り結果 = 新しい登録操作
      attempt.reset()
      setExtracted(result)
      setVendorName(result.vendor_name ?? '')
      setInvoiceNumber(result.invoice_number ?? '')
      setInvoiceDate(result.invoice_date ?? '')
      setPrintedEx(amountText(result.amounts.subtotal_excl_tax))
      setPrintedTax(amountText(result.amounts.tax_amount))
      setPrintedInc(amountText(result.amounts.total_incl_tax))
      setTreatment(result.amounts.tax_treatment)
      // 登録金額の初期値は、原本の印字から決まる税抜の候補だけ（なければ空欄。担当者が入力する）
      setRegisterAmount(amountText(result.review.suggested_excl_tax))
      setConfirmed(false)
      setDeviationConfirmed(false)

      // 業者名でledger itemを自動選択
      if (result.vendor_name) {
        const match = ledgerItems.find(
          item => item.vendor_name?.trim().toLowerCase() === result.vendor_name.trim().toLowerCase()
        )
        if (match) setSelectedItemId(match.id)
      }
    } catch (e) {
      if (genRef.current !== gen) return
      setError(e instanceof Error ? e.message : 'AI抽出に失敗しました')
    } finally {
      if (genRef.current === gen) {
        setLoading(false)
        extractAbortRef.current = null
      }
    }
  }

  // 内容を直したら「似ています」の確認はやり直す（直した内容で判定し直す）
  const edited = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setBlocker(b => (b?.kind === 'similar' ? null : b))
  }

  // 原本の金額（人が直した値）で照合し直す。AI の判定をそのまま使わない
  const review = useMemo(() => reviewInvoiceAmounts({
    subtotal_excl_tax: toAmount(printedEx),
    tax_amount:        toAmount(printedTax),
    total_incl_tax:    toAmount(printedInc),
    tax_treatment:     treatment,
    tax_breakdown:     extracted?.amounts.tax_breakdown ?? [],
    adjustments:       extracted?.amounts.adjustments ?? [],
    printed_tax_rates: extracted?.amounts.printed_tax_rates ?? [],
  }), [printedEx, printedTax, printedInc, treatment, extracted])

  // 原本の金額・税区分や登録金額を変えたら、確認はやり直す（確認したときの内容と登録する内容を一致させる）。
  // 登録金額は書き換えない（原本の税抜を使うかは担当者が選ぶ）
  const editedAmount = <T,>(set: (v: T) => void) => (v: T) => { edited(set)(v); setConfirmed(false); setDeviationConfirmed(false) }

  const parsedRegister = parseAmount(registerAmount)
  const changeRegisterAmount = editedAmount(setRegisterAmount)
  const risk = registerAmountRisk(parsedRegister, review, {
    excl: toAmount(printedEx), incl: toAmount(printedInc), treatment,
  })

  // 台帳に登録。confirmSimilar = 「以前の請求書と似ています」を確認したうえで登録する
  const register = async (confirmSimilar = false) => {
    if (!extracted || attempt.busy) return
    if (!selectedItemId) { setError('登録先の台帳項目を選択してください'); return }
    const parsedAmount = parseAmount(registerAmount)
    if (parsedAmount === null) { setError('登録金額（税抜）を正しく入力してください'); return }
    if (!confirmed) { setError('登録金額が税抜であることを原本で確認し、チェックを入れてください'); return }
    if (risk && !deviationConfirmed) { setError(risk.confirmLabel + '場合は、チェックを入れてください'); return }
    const gen = genRef.current
    const itemId = selectedItemId
    setSaving(true)
    setError(null)
    try {
      const result = await attempt.submit(key => postInvoice(itemId, {
        source:          'ocr',
        amount:          parsedAmount,
        invoice_date:    invoiceDate || null,
        payment_date:    paymentDate || null,
        // メモ欄が空なら null（担当者が入力した内容だけを保存する）
        note:            note.trim() || null,
        vendor_name:     vendorName || null,
        invoice_number:  invoiceNumber || null,
        document_sha256: extracted.document_sha256,
        confirm_similar: confirmSimilar,
      }, key))
      if (!result || genRef.current !== gen) return

      switch (result.kind) {
        case 'saved':
          // この登録操作は終わり。次の登録は新しいキーで行う
          attempt.reset()
          setBlocker(null)
          setSaved({ actualCost: result.newActualCost, synced: result.synced, replayed: result.replayed, amount: parsedAmount })
          loadLedgerItems()
          onRegistered?.(itemId)
          break
        case 'duplicate_document':
          setBlocker({ kind: 'duplicate', existing: result.existing })
          break
        case 'similar':
          setBlocker({ kind: 'similar', similar: result.similar })
          break
        case 'unknown':
          // 保存されたか分からない。自動で再送しない（同じキーで押し直せば二重にならない）
          setBlocker({ kind: 'unknown', message: result.message })
          break
        case 'rejected':
          setBlocker(null)
          setError(result.message)
          if (result.status === 409) { loadLedgerItems(); onRegistered?.(itemId) }
          break
      }
    } finally {
      setSaving(false)
    }
  }

  /** 登録が終わった画面を片付けて、次の請求書へ */
  const startNext = () => {
    clearDocument()
    setFile(null)
    setPreview(null)
  }

  const selectedItem = ledgerItems.find(i => i.id === selectedItemId)
  const canRegister = !!extracted && !!selectedItemId && parsedRegister !== null && confirmed && (!risk || deviationConfirmed) && !saving
  const reviewSuggestion = review.suggested_excl_tax
  const showUseSuggestion = reviewSuggestion != null && parsedRegister !== reviewSuggestion

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      style={{ display: 'none' }}
      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleFile(f) }}
    />
  )

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1240, margin: '0 auto' }}>

      {/* ─ ページタイトル ─ */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `linear-gradient(135deg, ${G.dark} 0%, ${G.med} 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <ReceiptIcon />
          </div>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: G.textPri, margin: 0 }}>
            業者請求書取り込み
          </h2>
        </div>
        <p style={{ fontSize: 12, color: G.textTer, marginLeft: 42 }}>
          請求書の画像と読み取り結果を見比べて、税抜金額を確認してから原価台帳に登録します
        </p>
      </div>

      {fileInput}

      {/* ─ ドロップゾーン（画像の選択前） ─ */}
      {!file && (
        <div
          onClick={pickFile}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${dragging ? G.med : G.border}`,
            borderRadius: 14,
            background: dragging ? G.hover : G.light,
            padding: '36px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.18s',
            marginBottom: 20,
          }}
        >
          <div style={{ marginBottom: 10, color: G.med }}>
            <UploadIcon />
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, color: G.textSec, marginBottom: 4 }}>
            請求書画像をドラッグ＆ドロップ
          </p>
          <p style={{ fontSize: 12, color: G.textTer }}>
            またはクリックしてファイルを選択（JPEG / PNG / WebP・最大8MB）
          </p>
        </div>
      )}

      {!file && error && <ErrorBox message={error} />}

      {/* ─ 原本（左）と読み取り結果（右）。スマートフォンでは上下 ─ */}
      {file && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">

          {/* ── 左: 請求書の原本 ── */}
          <section
            aria-label="請求書の原本"
            className="lg:sticky lg:top-4"
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            style={{ ...CARD, padding: 0, overflow: 'hidden', outline: dragging ? `2px dashed ${G.med}` : 'none' }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
              padding: '10px 12px', borderBottom: `1px solid ${G.borderLight}`, background: '#FAFDFB',
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: G.textPri }}>請求書の原本</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ToolButton label="縮小" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(z => ZOOMS[Math.max(0, ZOOMS.indexOf(z as typeof ZOOMS[number]) - 1)])}>−</ToolButton>
                <span style={{ fontSize: 12, color: G.textSec, minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                  {zoom === 1 ? '全体' : `${Math.round(zoom * 100)}%`}
                </span>
                <ToolButton label="拡大" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z as typeof ZOOMS[number]) + 1)])}>＋</ToolButton>
                <button type="button" onClick={pickFile} disabled={saving} style={SUB_BUTTON}>
                  画像を変更
                </button>
              </div>
            </div>
            <div
              className="h-[55vh] lg:h-[calc(100vh-180px)]"
              style={{ overflow: 'auto', background: '#F3F5F4', minHeight: 280 }}
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt="請求書の原本"
                  style={{ width: `${zoom * 100}%`, maxWidth: 'none', display: 'block', margin: zoom === 1 ? '0 auto' : 0 }}
                />
              ) : (
                <p style={{ fontSize: 12, color: G.textTer, padding: 20 }}>画像を読み込んでいます…</p>
              )}
            </div>
          </section>

          {/* ── 右: 読み取り結果と登録 ── */}
          <section aria-label="読み取り結果と登録" style={{ minWidth: 0 }}>
            {error && <ErrorBox message={error} />}
            {uploadNote && <div style={{ ...NOTICE_INFO, marginBottom: 12 }}>{uploadNote}</div>}

            {!extracted && (
              <div style={{ ...CARD, textAlign: 'center' }}>
                <button
                  onClick={extract}
                  disabled={loading}
                  style={{
                    background: loading ? G.border : G.dark,
                    color: '#fff', border: 'none', borderRadius: 8,
                    padding: '12px 36px', minHeight: 44,
                    fontSize: 14, fontWeight: 700,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <SparkleIcon />
                  {loading ? '読み取り中...' : '請求書を読み取る'}
                </button>
                <p style={{ fontSize: 11, color: G.textTer, marginTop: 8 }}>
                  業者名・金額・日付を読み取ります。登録前に原本と見比べて確認してください
                </p>
              </div>
            )}

            {extracted && (
              <>
                {/* 請求書の情報 */}
                <div style={CARD}>
                  <CardTitle>請求書の情報</CardTitle>
                  {extracted.warnings.length > 0 && (
                    <div style={{ ...NOTICE_ALERT, marginBottom: 12 }}>
                      {extracted.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <Field label="業者名">
                      <Input inputSize="compact" value={vendorName} onChange={e => edited(setVendorName)(e.target.value)} placeholder="例: ○○建材株式会社" />
                    </Field>
                    <Field label="請求書番号">
                      <Input inputSize="compact" value={invoiceNumber} onChange={e => edited(setInvoiceNumber)(e.target.value)} placeholder="例: INV-2026-0123" />
                    </Field>
                    <Field label="請求日">
                      <Input type="date" inputSize="compact" value={invoiceDate} onChange={e => edited(setInvoiceDate)(e.target.value)} />
                    </Field>
                    <Field label="支払期日（参考）">
                      <div style={{ fontSize: 13, color: G.textSec, minHeight: 36, display: 'flex', alignItems: 'center' }}>
                        {extracted.payment_due_date ?? '記載なし'}
                      </div>
                    </Field>
                  </div>
                  <p style={{ fontSize: 11, color: G.textTer, marginTop: 6 }}>
                    支払期日は原価台帳には登録しません（台帳の「支払日」は実際に支払った日です）
                  </p>
                </div>

                {/* 原本の金額 */}
                <div style={CARD}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                    <CardTitle noMargin>原本の金額</CardTitle>
                    <StatusChip review={review} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    <AmountField label="税抜金額" value={printedEx} onChange={editedAmount(setPrintedEx)} />
                    <AmountField label="消費税額" value={printedTax} onChange={editedAmount(setPrintedTax)} />
                    <AmountField label="税込合計" value={printedInc} onChange={editedAmount(setPrintedInc)} />
                    <Field label="税区分">
                      <select
                        value={treatment}
                        onChange={e => editedAmount(setTreatment)(e.target.value as TaxTreatment)}
                        className="h-9 w-full rounded-[8px] border border-[#D5DED8] bg-white px-[10px] text-sm text-[#1A2E24] outline-none hover:border-[#AFC4B5] focus:border-[#2B5E40] focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] cursor-pointer"
                      >
                        {(Object.keys(TREATMENT_LABEL) as TaxTreatment[]).map(t => <option key={t} value={t}>{TREATMENT_LABEL[t]}</option>)}
                      </select>
                    </Field>
                  </div>
                  <p style={{ fontSize: 11, color: G.textTer, marginTop: 6 }}>
                    原本に記載がない金額は空欄のままにしてください。読み取りが違えば原本どおりに直してください
                  </p>
                  {extracted.amounts.tax_breakdown.length > 0 && (
                    <div style={{ marginTop: 10, fontSize: 12, color: G.textSec }}>
                      税率ごとの内訳（AIの読み取り・原本で確認）：
                      {extracted.amounts.tax_breakdown.map((b, i) => (
                        <span key={i} style={{ marginLeft: 8 }}>
                          {b.rate != null ? `${b.rate}%` : '税率不明'} 対象 {b.taxable_amount != null ? `¥${fmt(b.taxable_amount)}` : '—'} ／ 税 {b.tax_amount != null ? `¥${fmt(b.tax_amount)}` : '—'}
                        </span>
                      ))}
                    </div>
                  )}
                  {(extracted.amounts.adjustments ?? []).length > 0 && (
                    <div style={{ marginTop: 10, fontSize: 12, color: G.textSec }}>
                      値引き・源泉徴収など（AIの読み取り・原本で確認）：
                      {(extracted.amounts.adjustments ?? []).map((a, i) => (
                        <span key={i} style={{ marginLeft: 8 }}>
                          {ADJUSTMENT_LABEL[a.kind]} {a.amount != null ? `¥${fmt(a.amount)}` : '—'}
                        </span>
                      ))}
                    </div>
                  )}
                  {review.messages.length > 0 && (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {review.messages.map((m, i) => (
                        <div key={i} style={m.level === 'warn' ? NOTICE_ALERT : NOTICE_INFO}>{m.level === 'warn' ? '⚠ ' : ''}{m.text}</div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 原価台帳に登録する内容 */}
                <div style={CARD}>
                  <CardTitle>原価台帳に登録する内容</CardTitle>

                  <Field label="登録先の台帳項目">
                    {ledgerItems.length === 0 ? (
                      <p style={{ fontSize: 13, color: G.textTer }}>
                        原価台帳がまだ作成されていません。先に原価台帳を初期化してください。
                      </p>
                    ) : (
                      <select
                        value={selectedItemId}
                        onChange={e => edited(setSelectedItemId)(e.target.value)}
                        className="h-11 w-full rounded-[8px] border border-[#D5DED8] bg-white px-[10px] text-sm text-[#1A2E24] outline-none hover:border-[#AFC4B5] focus:border-[#2B5E40] focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] cursor-pointer"
                      >
                        <option value="">-- 台帳項目を選択 --</option>
                        {ledgerItems.map(item => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.vendor_name ? ` （${item.vendor_name}）` : ''}
                            {item.estimate_cost != null ? ` ／ 予算 ¥${fmt(item.estimate_cost)}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {selectedItem && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px',
                      background: G.light, borderRadius: 8,
                      fontSize: 12, color: G.textSec,
                      display: 'flex', gap: 16, flexWrap: 'wrap',
                    }}>
                      <span><strong>予算:</strong> {selectedItem.estimate_cost != null ? `¥${fmt(selectedItem.estimate_cost)}` : '—'}</span>
                      <span><strong>実績累計:</strong> {selectedItem.actual_cost != null ? `¥${fmt(selectedItem.actual_cost)}` : '—'}</span>
                      {/* 登録後の予測は出さない（初期の actual_cost は見積原価のことがあり、登録 API は内訳合計で置き換えるため）。
                          登録後は API が返した DB の値を表示する */}
                    </div>
                  )}

                  <div style={{ marginTop: 14 }}>
                    <Field label="登録金額（税抜）">
                      <Input
                        inputSize="default"
                        value={registerAmount}
                        onChange={e => changeRegisterAmount(e.target.value)}
                        placeholder="原本の税抜金額を入力"
                        inputMode="numeric"
                        aria-describedby="register-amount-help"
                        style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                      />
                    </Field>
                    <div id="register-amount-help" style={{ fontSize: 12, color: G.textSec, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {parsedRegister !== null
                        ? <span>¥{fmt(parsedRegister)}（税抜）を実績原価に加えます</span>
                        : <span style={{ color: '#92400E' }}>税抜金額を入力してください（原価台帳は税抜で集計します）</span>}
                      {showUseSuggestion && (
                        <button type="button" onClick={() => changeRegisterAmount(String(reviewSuggestion))} style={SUB_BUTTON}>
                          原本の税抜 ¥{fmt(reviewSuggestion)} を使う
                        </button>
                      )}
                    </div>
                  </div>

                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14,
                    padding: '10px 12px', borderRadius: 8, minHeight: 44,
                    border: `1px solid ${confirmed ? G.border : '#FDE68A'}`,
                    background: confirmed ? G.light : '#FFFBEB',
                    cursor: parsedRegister === null ? 'not-allowed' : 'pointer',
                    fontSize: 13, color: G.textPri,
                  }}>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={parsedRegister === null || !!saved}
                      onChange={e => setConfirmed(e.target.checked)}
                      style={{ width: 18, height: 18, marginTop: 1, accentColor: G.dark }}
                    />
                    <span>
                      {parsedRegister !== null
                        ? <>登録金額 <strong>¥{fmt(parsedRegister)}</strong> が税抜金額であることを、原本で確認しました</>
                        : '登録金額を入力すると確認できます'}
                    </span>
                  </label>

                  {risk && (
                    <div role="alert" style={{ ...NOTICE_ALERT, marginTop: 10 }}>
                      <div>⚠ {risk.message}</div>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 8, minHeight: 32, cursor: 'pointer', fontWeight: 600 }}>
                        <input
                          type="checkbox"
                          aria-label="原本の税抜と異なる登録金額の確認"
                          checked={deviationConfirmed}
                          disabled={!!saved}
                          onChange={e => setDeviationConfirmed(e.target.checked)}
                          style={{ width: 18, height: 18, marginTop: 1, accentColor: '#92400E' }}
                        />
                        <span>{risk.confirmLabel}</span>
                      </label>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 14 }}>
                    <Field label="支払日（支払済みの場合のみ）">
                      <Input type="date" inputSize="compact" value={paymentDate} onChange={e => edited(setPaymentDate)(e.target.value)} />
                    </Field>
                    <Field label="メモ（任意）">
                      <Input inputSize="compact" value={note} onChange={e => setNote(e.target.value)} placeholder="例: 7月分材料費" />
                    </Field>
                  </div>
                </div>

                {/* 明細プレビュー */}
                {extracted.items.length > 0 && (
                  <details style={{ ...CARD, padding: '12px 16px' }}>
                    <summary style={{ fontSize: 12, color: G.textSec, cursor: 'pointer', fontWeight: 600 }}>
                      読み取った明細（参考・{extracted.items.length} 件
                      {extracted.items_total > extracted.items.length ? ` ／ 原本は ${extracted.items_total} 行。残りは原本で確認` : ''}）
                    </summary>
                    <div style={{ border: `1px solid ${G.borderLight}`, borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
                      {extracted.items.slice(0, 20).map((item, i) => (
                        <div key={i} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                          padding: '7px 12px',
                          borderBottom: i < Math.min(extracted.items.length, 20) - 1 ? `1px solid ${G.borderLight}` : 'none',
                          background: i % 2 === 0 ? '#FAFDFB' : '#FFFFFF',
                          fontSize: 12,
                        }}>
                          <span style={{ color: G.textSec }}>{item.name}</span>
                          <span style={{ color: G.textPri, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                            {item.amount != null ? `¥${fmt(item.amount)}` : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* ─ 登録できなかった・登録できたか分からないときの案内 ─ */}
                {blocker && !saved && <BlockerCard
                  blocker={blocker}
                  saving={saving}
                  onConfirmSimilar={() => register(true)}
                  onCancel={() => setBlocker(null)}
                />}

                {/* ─ 登録ボタン・結果 ─ */}
                <div style={{ textAlign: 'right', marginTop: 4 }}>
                  {saved ? (
                    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                      <div role="status" style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end',
                        background: G.light, color: G.dark,
                        borderRadius: 10, padding: '12px 20px',
                        fontSize: 14, fontWeight: 700,
                      }}>
                        <CheckIcon />
                        {saved.replayed ? 'この請求書は前回の送信で登録済みでした' : `¥${fmt(saved.amount)}（税抜）を原価台帳に登録しました`}
                        {saved.synced && saved.actualCost != null && (
                          <span style={{ fontWeight: 500, fontSize: 12 }}>（実績累計 ¥{fmt(saved.actualCost)}）</span>
                        )}
                      </div>
                      {!saved.synced && (
                        <div style={NOTICE_WARN}>
                          請求は保存済みです（もう一度登録する必要はありません）。
                          ただし実績原価の合計が請求内訳と一致していることを確認できませんでした。
                          原価台帳で実績原価と請求内訳の合計を確認してください。
                        </div>
                      )}
                      <button type="button" onClick={startNext} style={{ ...SUB_BUTTON, minHeight: 44, padding: '0 18px' }}>
                        次の請求書を取り込む
                      </button>
                    </div>
                  ) : blocker?.kind === 'duplicate' || blocker?.kind === 'similar' ? null : (
                    <>
                      <button
                        onClick={() => register()}
                        disabled={!canRegister}
                        style={{
                          background: canRegister ? G.dark : G.border,
                          color: '#fff', border: 'none', borderRadius: 8,
                          padding: '12px 32px', minHeight: 44,
                          fontSize: 14, fontWeight: 700,
                          cursor: canRegister ? 'pointer' : 'not-allowed',
                          transition: 'all 0.18s',
                        }}
                      >
                        {saving ? '登録中...' : '原価台帳に登録'}
                      </button>
                      {!canRegister && !saving && (
                        <p style={{ fontSize: 11, color: G.textTer, marginTop: 6 }}>
                          {!selectedItemId ? '登録先の台帳項目を選んでください'
                            : parsedRegister === null ? '登録金額（税抜）を入力してください'
                            : !confirmed ? '登録金額を原本で確認し、チェックを入れてください'
                            : '原本の税抜と異なる金額の確認にチェックを入れてください'}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

const CARD: React.CSSProperties = {
  background: G.cardBg,
  border: `1.5px solid ${G.borderLight}`,
  borderRadius: 14,
  padding: 18,
  marginBottom: 16,
}

const SUB_BUTTON: React.CSSProperties = {
  minHeight: 32, padding: '0 12px', borderRadius: 8,
  border: `1px solid ${G.border}`, background: '#fff', color: G.textSec,
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
}

const NOTICE_ALERT: React.CSSProperties = {
  background: '#FFFBEB', border: '1px solid #FDE68A',
  borderRadius: 8, padding: '8px 12px',
  fontSize: 12, color: '#92400E',
}

const NOTICE_INFO: React.CSSProperties = {
  background: '#F6FAF7', border: `1px solid ${G.borderLight}`,
  borderRadius: 8, padding: '8px 12px',
  fontSize: 12, color: G.textSec,
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      background: '#FFF0F4', border: '1px solid #F5C2D0',
      borderRadius: 10, padding: '10px 14px',
      fontSize: 13, color: '#C0385A',
      marginBottom: 16,
    }}>
      {message}
    </div>
  )
}

function CardTitle({ children, noMargin }: { children: React.ReactNode; noMargin?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: noMargin ? 0 : 12 }}>
      <div style={{ width: 4, height: 16, borderRadius: 2, background: G.dark }} />
      <span style={{ fontSize: 14, fontWeight: 700, color: G.textPri }}>{children}</span>
    </div>
  )
}

/** 原本の金額の照合結果（AI の判定ではなく、画面の値で照合した結果） */
/**
 * 原本の金額の照合結果。「金額の整合OK」は、要確認の点がなく、印字どうしの計算か印字された税率での検算が合ったときだけ。
 * 税込 − 消費税 で税抜を出しただけで検算できなければ「税抜は計算値」（登録はできる。原本で確認する）
 */
function StatusChip({ review }: { review: AmountReview }) {
  const verified = review.checks.arithmetic === 'consistent' || review.checks.tax_rate === 'consistent'
  const kind = review.status !== 'ok' ? 'review' : verified ? 'ok' : 'derived'
  const ok = kind === 'ok'
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '3px 8px',
      background: ok ? G.light : '#FFFBEB', color: ok ? G.dark : '#92400E',
      border: `1px solid ${ok ? G.border : '#FDE68A'}`,
    }}>
      {kind === 'ok' ? '金額の整合OK' : kind === 'derived' ? '税抜は計算値' : '要確認'}
    </span>
  )
}


function AmountField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const n = toAmount(value)
  return (
    <Field label={label}>
      <Input
        inputSize="compact"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="記載なし"
        inputMode="numeric"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      />
      <div style={{ fontSize: 11, color: G.textTer, marginTop: 3, minHeight: 15, fontVariantNumeric: 'tabular-nums' }}>
        {value.trim() === '' ? '' : n != null ? `¥${fmt(n)}` : '数字で入力してください'}
      </div>
    </Field>
  )
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{ ...SUB_BUTTON, width: 32, padding: 0, fontSize: 15, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  )
}

const NOTICE_WARN: React.CSSProperties = {
  background: '#FFF7ED', border: '1px solid #FED7AA',
  borderRadius: 10, padding: '10px 14px',
  fontSize: 12, color: '#9A3412', textAlign: 'left', maxWidth: 520,
}

const fmtDate = (v: string | null) => (v ? v.slice(0, 10) : '—')

/** created_at（UTC の時刻）を利用者の現地日付で表示する */
const fmtLocalDate = (v: string | null) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function BlockerCard({ blocker, saving, onConfirmSimilar, onCancel }: {
  blocker: Blocker
  saving: boolean
  onConfirmSimilar: () => void
  onCancel: () => void
}) {
  if (blocker.kind === 'unknown') {
    return <div style={{ ...NOTICE_WARN, maxWidth: 'none', marginBottom: 16 }}>{blocker.message}</div>
  }
  if (blocker.kind === 'duplicate') {
    const e = blocker.existing
    return (
      <div style={{ ...NOTICE_WARN, maxWidth: 'none', marginBottom: 16, background: '#FFF0F4', border: '1px solid #F5C2D0', color: '#C0385A' }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>この請求書は登録済みです</div>
        <div>同じ画像がこの案件に登録されています。二重計上を防ぐため、もう一度は登録できません。</div>
        {e && (
          <div style={{ marginTop: 6, color: G.textSec }}>
            登録先: {e.item_name ?? '—'} ／ 金額 ¥{fmt(e.amount)} ／ 請求日 {fmtDate(e.invoice_date)} ／ 登録日 {fmtLocalDate(e.created_at)}
          </div>
        )}
      </div>
    )
  }
  return (
    <div style={{ ...NOTICE_WARN, maxWidth: 'none', marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>以前の請求書と似ています</div>
      <div style={{ marginBottom: 6 }}>二重登録でないか確認してください。別の請求書であれば、そのまま登録できます。</div>
      <div style={{ border: '1px solid #FED7AA', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
        {blocker.similar.map(s => (
          <div key={s.id} style={{ padding: '6px 10px', borderBottom: '1px solid #FFEDD5', color: G.textSec }}>
            {s.item_name ?? '—'} ／ {s.vendor_name ?? '業者名なし'} ／ No. {s.invoice_number ?? '—'} ／ ¥{fmt(s.amount)} ／ 請求日 {fmtDate(s.invoice_date)}
            <span style={{ marginLeft: 6, color: '#9A3412' }}>
              （{s.reason === 'invoice_number' ? '請求書番号が同じ' : '業者名・金額・請求日が同じ'}）
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button onClick={onCancel} disabled={saving} style={{ minHeight: 36, padding: '0 14px', borderRadius: 8, border: `1px solid ${G.border}`, background: '#fff', color: G.textSec, fontSize: 12, cursor: 'pointer' }}>
          キャンセル
        </button>
        <button onClick={onConfirmSimilar} disabled={saving} style={{ minHeight: 36, padding: '0 14px', borderRadius: 8, border: 'none', background: '#9A3412', color: '#fff', fontSize: 12, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
          {saving ? '登録中...' : '別の請求書として登録'}
        </button>
      </div>
    </div>
  )
}

// ── サブコンポーネント ─────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 600,
        color: G.textTer, marginBottom: 5,
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────

// ── アイコン ──────────────────────────────────────────────

function ReceiptIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2 3-2V8z"/>
      <line x1="8" y1="10" x2="16" y2="10"/>
      <line x1="8" y1="14" x2="16" y2="14"/>
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
      stroke="#3D7A55" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#2B5E40" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
