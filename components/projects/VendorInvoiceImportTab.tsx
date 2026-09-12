'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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
  total_amount: number | null
  invoice_date: string | null
  payment_due_date: string | null
  items: Array<{ name: string; amount: number | null }>
  raw_warning: string | null
}

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

type Props = { projectId: string }

export function VendorInvoiceImportTab({ projectId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile]             = useState<File | null>(null)
  const [preview, setPreview]       = useState<string | null>(null)
  const [dragging, setDragging]     = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const [extracted, setExtracted]   = useState<ExtractedInvoice | null>(null)
  const [vendorName, setVendorName] = useState('')
  const [amount, setAmount]         = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [note, setNote]             = useState('')

  const [ledgerItems, setLedgerItems] = useState<CostLedgerItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string>('')

  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)

  // 原価台帳アイテムを取得
  useEffect(() => {
    fetch(`/api/cost-ledger?project_id=${projectId}`)
      .then(r => r.json())
      .then(data => {
        if (data.items) setLedgerItems(data.items as CostLedgerItem[])
      })
      .catch(() => {/* ignore */})
  }, [projectId])

  // ファイルセット
  const handleFile = useCallback((f: File) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowed.includes(f.type)) {
      setError('JPEG / PNG / WebP の画像ファイルを選択してください')
      return
    }
    if (f.size > 8 * 1024 * 1024) {
      setError('8MB 以下のファイルを選択してください')
      return
    }
    setFile(f)
    setError(null)
    setExtracted(null)
    setSaved(false)
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target?.result as string)
    reader.readAsDataURL(f)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) handleFile(dropped)
  }, [handleFile])

  // AI抽出
  const extract = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/ai/extract-vendor-invoice', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI抽出に失敗しました')
      const result = data as ExtractedInvoice
      setExtracted(result)
      setVendorName(result.vendor_name ?? '')
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
      setError(e instanceof Error ? e.message : 'AI抽出に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  // 台帳に登録
  const register = async () => {
    if (!selectedItemId) { setError('登録先の台帳項目を選択してください'); return }
    const parsedAmount = parseFloat(amount.replace(/,/g, ''))
    if (!amount || isNaN(parsedAmount)) { setError('金額を入力してください'); return }
    setSaving(true)
    setError(null)
    try {
      const body = {
        amount:       parsedAmount,
        invoice_date: invoiceDate || null,
        payment_date: paymentDate || null,
        note:         note || (vendorName ? `${vendorName}からの請求` : null),
      }
      const res = await fetch(`/api/cost-ledger/${selectedItemId}/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '登録に失敗しました')
      setSaved(true)
      // 完了後リセット
      setTimeout(() => {
        setFile(null)
        setPreview(null)
        setExtracted(null)
        setVendorName('')
        setAmount('')
        setInvoiceDate('')
        setPaymentDate('')
        setNote('')
        setSelectedItemId('')
        setSaved(false)
      }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました')
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
        onClick={() => inputRef.current?.click()}
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
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
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
              background: loading ? G.border : `linear-gradient(135deg, ${G.dark} 0%, ${G.med} 100%)`,
              color: '#fff',
              border: 'none',
              borderRadius: 10,
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
              <input
                value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                placeholder="例: ○○建材株式会社"
                style={inputStyle}
              />
            </Field>

            <Field label="請求金額（税込）">
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="例: 125000"
                inputMode="numeric"
                style={inputStyle}
              />
            </Field>

            <Field label="請求日">
              <input
                type="date"
                value={invoiceDate}
                onChange={e => setInvoiceDate(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="支払期日">
              <input
                type="date"
                value={paymentDate}
                onChange={e => setPaymentDate(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <Field label="メモ（任意）">
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="例: 7月分材料費"
                style={inputStyle}
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
                onChange={e => setSelectedItemId(e.target.value)}
                style={{ ...inputStyle, appearance: 'auto', width: '100%', cursor: 'pointer' }}
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

      {/* ─ 登録ボタン ─ */}
      {extracted && (
        <div style={{ textAlign: 'right' }}>
          {saved ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: G.light, color: G.dark,
              borderRadius: 10, padding: '12px 24px',
              fontSize: 14, fontWeight: 700,
            }}>
              <CheckIcon />
              原価台帳に登録しました
            </div>
          ) : (
            <button
              onClick={register}
              disabled={saving || !selectedItemId}
              style={{
                background: (!selectedItemId || saving)
                  ? G.border
                  : `linear-gradient(135deg, ${G.dark} 0%, ${G.med} 100%)`,
                color: '#fff',
                border: 'none',
                borderRadius: 10,
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: `1.5px solid ${G.border}`,
  borderRadius: 8,
  fontSize: 13,
  color: G.textPri,
  background: '#FAFDFB',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}

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
