'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  createRegisterAttempt, postInvoice,
  type ExistingDocument, type RegisterAttempt, type SimilarInvoiceSummary,
} from '@/lib/cost-ledger/invoice-client'

// ── 型定義 ────────────────────────────────────────────────

type CostLedgerItem = {
  id: string
  name: string
  vendor_name: string | null
  estimate_cost: number | null
  actual_cost: number | null
}

type ExtractedInvoice = {
  vendor_name: string
  invoice_number: string | null
  total_amount: number | null
  invoice_date: string | null
  payment_due_date: string | null
  items: Array<{ name: string; amount: number | null }>
  raw_warning: string | null
  /** サーバーが画像のバイト列から計算した SHA-256（AI の出力ではない） */
  document_sha256: string
}

/** 登録できなかった・登録できたか分からないときの案内 */
type Blocker =
  | { kind: 'duplicate'; existing: ExistingDocument | null }
  | { kind: 'similar'; similar: SimilarInvoiceSummary[] }
  | { kind: 'unknown'; message: string }

/** 登録できたときの結果（画面は DB が返した値で表示する） */
type SavedState = { actualCost: number | null; synced: boolean; replayed: boolean }
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

type Props = {
  projectId: string
  /** 登録できたとき（再送で保存済みだったときも）。親は台帳と内訳を DB から読み直す */
  onRegistered?: (itemId: string) => void
}

/** 金額欄の文字列を数値にする（カンマ可。数値以外が混ざっていれば null） */
function parseAmount(v: string): number | null {
  const t = v.replace(/[,，\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n !== 0 ? n : null
}

export function VendorInvoiceImportTab({ projectId, onRegistered }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile]             = useState<File | null>(null)
  const [preview, setPreview]       = useState<string | null>(null)
  const [dragging, setDragging]     = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const [extracted, setExtracted]   = useState<ExtractedInvoice | null>(null)
  const [vendorName, setVendorName] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [amount, setAmount]         = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [note, setNote]             = useState('')

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
    setAmount('')
    setInvoiceDate('')
    setPaymentDate('')
    setNote('')
    setSelectedItemId('')
    setSaved(null)
    setBlocker(null)
    setError(null)
  }, [attempt])

  // ファイルセット
  const handleFile = useCallback((f: File) => {
    // 登録の送信中は画像を変えない（どの画像の登録か分からなくなる）
    if (attempt.busy) return
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowed.includes(f.type)) {
      setError('JPEG / PNG / WebP の画像ファイルを選択してください')
      return
    }
    if (f.size > 8 * 1024 * 1024) {
      setError('8MB 以下のファイルを選択してください')
      return
    }
    clearDocument()
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

  // AI抽出
  const extract = async () => {
    if (!file || loading) return
    const gen = genRef.current
    const ctrl = new AbortController()
    extractAbortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/ai/extract-vendor-invoice', { method: 'POST', body: fd, signal: ctrl.signal })
      const data = await res.json()
      // 読み取り中に画像が変わった。古い結果は使わない
      if (genRef.current !== gen) return
      if (!res.ok) throw new Error(data.error ?? 'AI抽出に失敗しました')
      const result = data as ExtractedInvoice
      if (typeof result.document_sha256 !== 'string') throw new Error('AI抽出に失敗しました')
      // 新しい画像の読み取り結果 = 新しい登録操作
      attempt.reset()
      setExtracted(result)
      setVendorName(result.vendor_name ?? '')
      setInvoiceNumber(result.invoice_number ?? '')
      setAmount(result.total_amount != null ? String(Math.round(result.total_amount)) : '')
      setInvoiceDate(result.invoice_date ?? '')
      setPaymentDate(result.payment_due_date ?? '')

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

  // 台帳に登録。confirmSimilar = 「以前の請求書と似ています」を確認したうえで登録する
  const register = async (confirmSimilar = false) => {
    if (!extracted || attempt.busy) return
    if (!selectedItemId) { setError('登録先の台帳項目を選択してください'); return }
    const parsedAmount = parseAmount(amount)
    if (parsedAmount === null) { setError('金額を正しく入力してください'); return }
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
        note:            note || (vendorName ? `${vendorName}からの請求` : null),
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
          setSaved({ actualCost: result.newActualCost, synced: result.synced, replayed: result.replayed })
          loadLedgerItems()
          onRegistered?.(itemId)
          // 再集計に失敗したときは案内を残す（自動で消さない）
          if (result.synced) {
            setTimeout(() => {
              if (genRef.current !== gen) return
              clearDocument()
              setFile(null)
              setPreview(null)
            }, 2000)
          }
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

  const selectedItem = ledgerItems.find(i => i.id === selectedItemId)

  return (
    <div style={{ padding: '24px 20px', maxWidth: 760, margin: '0 auto' }}>

      {/* ─ ページタイトル ─ */}
      <div style={{ marginBottom: 24 }}>
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
          業者からの請求書画像をアップロードして、原価台帳に実績を登録します
        </p>
      </div>

      {/* ─ ドロップゾーン ─ */}
      <div
        onClick={() => { if (!saving) inputRef.current?.click() }}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? G.med : G.border}`,
          borderRadius: 14,
          background: dragging ? G.hover : G.light,
          padding: preview ? 0 : '36px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 0.18s',
          marginBottom: 20,
          overflow: 'hidden',
          minHeight: preview ? 0 : undefined,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleFile(f) }}
        />
        {preview ? (
          <div style={{ position: 'relative' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="請求書プレビュー"
              style={{ width: '100%', maxHeight: 320, objectFit: 'contain', display: 'block', borderRadius: 12 }}
            />
            <div style={{
              position: 'absolute', bottom: 8, right: 8,
              background: 'rgba(0,0,0,0.55)',
              color: '#fff', fontSize: 11, borderRadius: 6, padding: '3px 10px',
            }}>
              クリックして変更
            </div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 10, color: G.med }}>
              <UploadIcon />
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: G.textSec, marginBottom: 4 }}>
              請求書画像をドラッグ＆ドロップ
            </p>
            <p style={{ fontSize: 12, color: G.textTer }}>
              またはクリックしてファイルを選択（JPEG / PNG / WebP・最大8MB）
            </p>
          </>
        )}
      </div>

      {/* ─ AI抽出ボタン ─ */}
      {file && !extracted && (
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <button
            onClick={extract}
            disabled={loading}
            style={{
              background: loading ? G.border : G.dark,
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '12px 36px',
              fontSize: 14,
              fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: loading ? 'none' : '0 4px 14px rgba(43,94,64,0.35)',
              transition: 'all 0.18s',
            }}
          >
            <SparkleIcon />
            {loading ? 'AI が読み取り中...' : 'AI で情報を抽出'}
          </button>
          <p style={{ fontSize: 11, color: G.textTer, marginTop: 8 }}>
            業者名・金額・日付を自動読み取りします
          </p>
        </div>
      )}

      {/* ─ エラー ─ */}
      {error && (
        <div style={{
          background: '#FFF0F4', border: '1px solid #F5C2D0',
          borderRadius: 10, padding: '10px 14px',
          fontSize: 13, color: '#C0385A',
          marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* ─ 抽出結果フォーム ─ */}
      {extracted && (
        <div style={{
          background: G.cardBg,
          border: `1.5px solid ${G.borderLight}`,
          borderRadius: 14,
          padding: 20,
          marginBottom: 20,
          boxShadow: '0 2px 12px rgba(43,94,64,0.07)',
        }}>
          {/* ヘッダー */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            <div style={{
              width: 5, height: 18, borderRadius: 3,
              background: `linear-gradient(180deg, ${G.dark} 0%, ${G.med} 100%)`,
            }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: G.textPri }}>
              AI 抽出結果の確認・編集
            </span>
          </div>

          {extracted.raw_warning && (
            <div style={{
              background: '#FFFBEB', border: '1px solid #FDE68A',
              borderRadius: 8, padding: '8px 12px',
              fontSize: 12, color: '#92400E',
              marginBottom: 16,
            }}>
              ⚠ {extracted.raw_warning}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="業者名">
              <Input
                inputSize="compact"
                value={vendorName}
                onChange={e => edited(setVendorName)(e.target.value)}
                placeholder="例: ○○建材株式会社"
              />
            </Field>

            <Field label="請求書番号">
              <Input
                inputSize="compact"
                value={invoiceNumber}
                onChange={e => edited(setInvoiceNumber)(e.target.value)}
                placeholder="例: INV-2026-0123"
              />
            </Field>

            <Field label="請求金額（税込）">
              <Input
                inputSize="compact"
                value={amount}
                onChange={e => edited(setAmount)(e.target.value)}
                placeholder="例: 125000"
                inputMode="numeric"
              />
            </Field>

            <Field label="請求日">
              <Input
                type="date"
                inputSize="compact"
                value={invoiceDate}
                onChange={e => edited(setInvoiceDate)(e.target.value)}
              />
            </Field>

            <Field label="支払期日">
              <Input
                type="date"
                inputSize="compact"
                value={paymentDate}
                onChange={e => edited(setPaymentDate)(e.target.value)}
              />
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <Field label="メモ（任意）">
              <Input
                inputSize="compact"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="例: 7月分材料費"
              />
            </Field>
          </div>

          {/* 明細プレビュー */}
          {extracted.items.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 11, color: G.textTer, marginBottom: 6, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                抽出された明細（参考）
              </p>
              <div style={{
                border: `1px solid ${G.borderLight}`,
                borderRadius: 8, overflow: 'hidden',
              }}>
                {extracted.items.slice(0, 8).map((item, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '7px 12px',
                    borderBottom: i < Math.min(extracted.items.length, 8) - 1 ? `1px solid ${G.borderLight}` : 'none',
                    background: i % 2 === 0 ? '#FAFDFB' : '#FFFFFF',
                    fontSize: 12,
                  }}>
                    <span style={{ color: G.textSec }}>{item.name}</span>
                    <span style={{ color: G.textPri, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {item.amount != null ? `¥${fmt(item.amount)}` : '—'}
                    </span>
                  </div>
                ))}
                {extracted.items.length > 8 && (
                  <div style={{ padding: '6px 12px', fontSize: 11, color: G.textTer, textAlign: 'center', background: '#FAFDFB' }}>
                    他 {extracted.items.length - 8} 件
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─ 登録先の台帳項目を選択 ─ */}
      {extracted && (
        <div style={{
          background: G.cardBg,
          border: `1.5px solid ${G.borderLight}`,
          borderRadius: 14,
          padding: 20,
          marginBottom: 20,
          boxShadow: '0 2px 12px rgba(43,94,64,0.07)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <div style={{
              width: 5, height: 18, borderRadius: 3,
              background: `linear-gradient(180deg, ${G.dark} 0%, ${G.med} 100%)`,
            }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: G.textPri }}>
              登録先の台帳項目
            </span>
          </div>

          {ledgerItems.length === 0 ? (
            <p style={{ fontSize: 13, color: G.textTer }}>
              原価台帳がまだ作成されていません。先に「原価台帳」タブで台帳を初期化してください。
            </p>
          ) : (
            <>
              <select
                value={selectedItemId}
                onChange={e => edited(setSelectedItemId)(e.target.value)}
                className="h-9 w-full rounded-[8px] border border-[#D5DED8] bg-white px-[10px] text-sm text-[#1A2E24] outline-none hover:border-[#AFC4B5] focus:border-[#2B5E40] focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] cursor-pointer"
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

              {selectedItem && (
                <div style={{
                  marginTop: 10, padding: '10px 14px',
                  background: G.light, borderRadius: 8,
                  fontSize: 12, color: G.textSec,
                  display: 'flex', gap: 16,
                }}>
                  <span><strong>予算:</strong> {selectedItem.estimate_cost != null ? `¥${fmt(selectedItem.estimate_cost)}` : '—'}</span>
                  <span><strong>実績累計:</strong> {selectedItem.actual_cost != null ? `¥${fmt(selectedItem.actual_cost)}` : '—'}</span>
                  {amount && !isNaN(parseFloat(amount.replace(/,/g, ''))) && (
                    <span style={{ color: G.dark, fontWeight: 600 }}>
                      → 登録後: ¥{fmt((selectedItem.actual_cost ?? 0) + parseFloat(amount.replace(/,/g, '')))}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ─ 登録できなかった・登録できたか分からないときの案内 ─ */}
      {extracted && blocker && !saved && <BlockerCard
        blocker={blocker}
        saving={saving}
        onConfirmSimilar={() => register(true)}
        onCancel={() => setBlocker(null)}
      />}

      {/* ─ 登録ボタン ─ */}
      {extracted && (
        <div style={{ textAlign: 'right' }}>
          {saved ? (
            <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: G.light, color: G.dark,
                borderRadius: 10, padding: '12px 24px',
                fontSize: 14, fontWeight: 700,
              }}>
                <CheckIcon />
                {saved.replayed ? 'この請求書は前回の送信で登録済みでした' : '原価台帳に登録しました'}
                {saved.synced && saved.actualCost != null && (
                  <span style={{ fontWeight: 500, fontSize: 12 }}>（実績累計 ¥{fmt(saved.actualCost)}）</span>
                )}
              </div>
              {!saved.synced && (
                <div style={NOTICE_WARN}>
                  請求は保存されました。実績原価の再集計に失敗したため、表示中の金額が古い可能性があります。
                  画面を再読み込みして確認してください（もう一度登録する必要はありません）。
                </div>
              )}
            </div>
          ) : blocker?.kind === 'duplicate' || blocker?.kind === 'similar' ? null : (
            <button
              onClick={() => register()}
              disabled={saving || !selectedItemId}
              style={{
                background: (!selectedItemId || saving) ? G.border : G.dark,
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '12px 32px',
                fontSize: 14,
                fontWeight: 700,
                cursor: (!selectedItemId || saving) ? 'not-allowed' : 'pointer',
                boxShadow: (!selectedItemId || saving) ? 'none' : '0 4px 14px rgba(43,94,64,0.35)',
                transition: 'all 0.18s',
              }}
            >
              {saving ? '登録中...' : '原価台帳に登録'}
            </button>
          )}
        </div>
      )}
    </div>
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
