'use client'

import { useCallback, useEffect, useState } from 'react'
import { getClient } from '@/lib/supabase/client'

// ── 型定義 ────────────────────────────────────────────────

type PaymentType = 'contract' | 'start' | 'completion' | 'custom'

type InvoiceItem = {
  id: string
  name: string
  quantity: number
  unit: string
  amount: number
  memo: string
}

type Invoice = {
  id: string
  project_id: string
  invoice_number: string | null
  payment_type: PaymentType
  customer_name: string | null
  construction_name: string | null
  issued_at: string
  payment_due_at: string | null
  items: InvoiceItem[]
  adjustment: number
  memo: string | null
  status: 'draft' | 'issued' | 'paid'
  printed_at: string | null
  created_at: string
  updated_at: string
}

type ProjectInfo = {
  id: string
  name: string | null
  customer_name: string | null
  payment_contract_pct: number | null
  payment_start_pct: number | null
  payment_completion_pct: number | null
}

// ── デザイントークン ──────────────────────────────────────

const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const C = {
  bg:        '#FFFFFF',
  pageBg:    '#F3F7F4',
  border:    '#DDE8E2',
  divider:   '#EEF2EF',
  accent:    '#3D7A55',
  accentBg:  '#EAF3DE',
  accentTint:'#A8D4B5',
  text:      '#1A2E24',
  textSub:   '#2D4A38',
  textMuted: '#7A9185',
  label:     '#6B7A74',
  red:       '#D12953',
  redBg:     '#FFF0F4',
  orange:    '#C4790A',
  orangeBg:  '#FFF7ED',
  blue:      '#1E40AF',
  blueBg:    '#EFF6FF',
  green:     '#2B5E40',
  greenBg:   '#DCFCE7',
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  draft:    { label: '下書き',   color: C.textMuted, bg: '#F1F5F9' },
  issued:   { label: '発行済み', color: C.blue,      bg: C.blueBg  },
  paid:     { label: '入金済み', color: C.green,     bg: C.greenBg },
}

const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  contract:   '契約時',
  start:      '着工時',
  completion: '完工時',
  custom:     'カスタム',
}

const fmt = (v: number) => Math.round(v).toLocaleString('ja-JP')

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

// ── 印刷ウィンドウ ────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  // 令和換算（2019-05-01〜）
  if (d >= new Date('2019-05-01')) {
    return `令和${d.getFullYear() - 2018}年${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const era = d >= new Date('2019-05-01') ? `令和${d.getFullYear() - 2018}年` : `${d.getFullYear()}年`
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${era}${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

function printInvoice(invoice: Partial<Invoice>, subtotal: number, tax: number, total: number) {
  const items = invoice.items ?? []
  // Excelに合わせて最低21行（rows 18-38）表示
  const MIN_ROWS = 21
  const displayRows = items.length < MIN_ROWS
    ? [...items, ...Array(MIN_ROWS - items.length).fill(null)]
    : items

  const f = (v: number) => Math.round(v).toLocaleString('ja-JP')
  const logoUrl = `${window.location.origin}/excel-images/image7.png`
  // 顧客名末尾の「様」が既に入っている場合は除去して重複を防ぐ
  const customerName = (invoice.customer_name || '').replace(/様$/, '').trim() || '　'

  // Excelの列幅比率: A=2.71, B=25.43, C=5.29, D=5.14, E=18.71, F=38 (合計95.28)
  // 左ブロック(A-E): 57.28/95.28 = 60.1%  右ブロック(F): 38/95.28 = 39.9%
  // テーブル列幅(pt換算 A4-198mm内):
  //   A≈5.6mm  B≈52.8mm  C≈11.0mm  D≈10.7mm  E≈38.9mm  F≈79.1mm

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>ご請求書${invoice.invoice_number ? ' ' + invoice.invoice_number : ''}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif;
  font-size: 9pt;
  color: #000;
  background: #f0f0f0;
}
@page { size: A4 portrait; margin: 0; }
@media print {
  html, body { background: #fff; }
  .no-print { display: none !important; }
}

/* ─ 印刷ボタンバー ─ */
.no-print {
  background: #1e3a5f;
  padding: 10pt 14pt;
  display: flex;
  align-items: center;
  gap: 12pt;
  position: sticky;
  top: 0;
  z-index: 10;
}
.print-btn {
  background: #fff;
  color: #1e3a5f;
  border: none;
  border-radius: 4pt;
  padding: 6pt 20pt;
  font-size: 11pt;
  font-weight: bold;
  cursor: pointer;
  font-family: inherit;
}
.print-hint { color: #a0b8d0; font-size: 9pt; }

/* ─ A4ページ ─ */
.page {
  width: 198mm;
  min-height: 277mm;
  background: #fff;
  margin: 10mm auto;
  padding: 10mm 8mm 8mm;
  box-sizing: border-box;
}
@media print {
  .page { margin: 0; width: 100%; padding: 10mm 8mm 8mm; }
}

/* ─ ドキュメント外枠（枠なし） ─ */
.doc {
  width: 100%;
}

/* ─ タイトル行 ─ */
.title-row {
  display: flex;
  align-items: center;
  padding: 6pt 8pt 8pt;
}
.title-left { flex: 1; font-size: 8pt; }
.title-center {
  flex: 2;
  text-align: center;
}
.title-text {
  display: inline-block;
  font-size: 15pt;
  font-weight: bold;
  letter-spacing: 0.6em;
  padding-left: 0.6em;
  padding-bottom: 4pt;
  border-bottom: 2pt solid #000;
}
.title-right { flex: 1; text-align: right; font-size: 9pt; }

/* ─ 上段2カラム ─ */
.info-section {
  display: flex;
  border-bottom: 1pt solid #000;
}
.info-left {
  width: 60.1%;
  padding: 6pt 7pt 5pt;
  display: flex;
  flex-direction: column;
  gap: 4pt;
}
.info-right {
  width: 39.9%;
  padding: 6pt 8pt 4pt;
  display: flex;
  flex-direction: column;
  font-size: 8pt;
}

/* 顧客名 */
.customer-line {
  display: flex;
  align-items: baseline;
  border-bottom: 1.5pt solid #000;
  padding-bottom: 3pt;
  margin-bottom: 5pt;
  gap: 3pt;
}
.customer-name { font-size: 16pt; font-weight: bold; letter-spacing: 0.05em; }
.sama { font-size: 11pt; font-weight: bold; }
.request-note { font-size: 8pt; color: #333; margin-bottom: 4pt; }

/* 振込先（枠なし・プレーンテキスト行） */
.bank-box { font-size: 8pt; line-height: 1.9; }
.bank-title { font-weight: bold; margin-bottom: 1pt; }
.bank-note { font-size: 7.5pt; color: #c00; font-weight: bold; margin-top: 1pt; }

/* 振込金額 */
.amount-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1.5pt solid #000;
  padding: 4pt 8pt;
  margin-top: 5pt;
}
.amount-label { font-size: 8.5pt; font-weight: bold; }
.amount-value { font-size: 18pt; font-weight: bold; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }

.reg-no { font-size: 7pt; color: #555; margin-top: 3pt; }

/* 右カラム */
.issued-date-row {
  text-align: right;
  font-size: 10.5pt;
  font-weight: bold;
  margin-bottom: 5pt;
  letter-spacing: 0.03em;
}
.payment-due-row {
  text-align: right;
  font-size: 8pt;
  color: #444;
  margin-bottom: 4pt;
}
.company-logo {
  width: 100%;
  max-height: 54pt;
  object-fit: contain;
  object-position: center;
  margin: 2pt 0 5pt;
}
.company-addr { font-size: 7.5pt; line-height: 1.7; text-align: center; }
.seal-wrap { display: flex; justify-content: flex-end; margin-top: auto; padding-top: 4pt; }
.seal-box { font-size: 8pt; color: #aaa; }

/* ─ 明細テーブル ─ */
.items-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 8.5pt;
  table-layout: fixed;
}
/* Excelの列幅比率を % で再現（合計100%、幅に依存しない） */
.items-table colgroup col.c-no   { width: 3%; }
.items-table colgroup col.c-name { width: 27%; }
.items-table colgroup col.c-qty  { width: 6%; }
.items-table colgroup col.c-unit { width: 6%; }
.items-table colgroup col.c-amt  { width: 20%; }
.items-table colgroup col.c-memo { width: 38%; }

.items-table th {
  background: #EFEFEF;
  border: 1pt solid #000;
  padding: 3pt 3pt;
  text-align: center;
  font-size: 8.5pt;
  font-weight: bold;
}
.items-table td {
  border: 1pt solid #000;
  padding: 1.5pt 3pt;
  height: 14pt;
  vertical-align: middle;
  overflow: hidden;
}
.td-no   { text-align: center; font-size: 7.5pt; color: #000; }
.td-name { }
.td-qty  { text-align: right; }
.td-unit { text-align: center; }
.td-amt  { text-align: right; font-variant-numeric: tabular-nums; }
.td-memo { }

/* 小計・合計行 */
.items-table tfoot td {
  border: 1pt solid #888;
  padding: 3pt 5pt;
  font-size: 9pt;
  font-weight: bold;
  background: #F5F5F5;
}
.items-table tfoot .total-row td { background: #EAF0E8; font-size: 10pt; }
.foot-label { text-align: right; padding-right: 6pt; }
.foot-value { text-align: right; font-variant-numeric: tabular-nums; }

/* ─ 備考 ─ */
.notes-section {
  border-top: 1pt solid #888;
  padding: 4pt 7pt;
  min-height: 28pt;
  font-size: 8.5pt;
  line-height: 1.6;
}
.notes-label { font-size: 7.5pt; color: #666; margin-bottom: 2pt; font-weight: bold; }
</style>
</head>
<body>

<div class="no-print">
  <button class="print-btn" onclick="window.print()">🖨️　印刷する（A4）</button>
  <span class="print-hint">ブラウザの印刷ダイアログが開きます。「余白：なし」推奨。</span>
</div>

<div class="page">
<div class="doc">

  <!-- ① タイトル行 -->
  <div class="title-row">
    <div class="title-left"></div>
    <div class="title-center"><span class="title-text">ご　請　求　書</span></div>
    <div class="title-right">${invoice.invoice_number ? 'No.&nbsp;' + escHtml(invoice.invoice_number) : ''}</div>
  </div>

  <!-- ② 上段: 顧客・振込先（左60%）／発行日・ロゴ・会社情報（右40%） -->
  <div class="info-section">

    <!-- 左ブロック -->
    <div class="info-left">
      <div class="customer-line">
        <span class="customer-name">${escHtml(customerName)}</span>
        <span class="sama">　様</span>
      </div>
      <div class="request-note">下記のとおり御請求申し上げます。</div>
      <div class="bank-box">
        <div class="bank-title">お支払いは下記口座までお願いします</div>
        <div>　十六銀行　/　鏡島支店</div>
        <div>　【普通】　1326345</div>
        <div>　株式会社　ラグズ建築</div>
        <div>　カ）　ラグズケンチク</div>
        <div class="bank-note">※振込手数料はお客様負担にてお願いいたします。</div>
      </div>
      <div class="amount-row">
        <span class="amount-label">お振込み金額（消費税込）</span>
        <span class="amount-value">¥${f(total)}</span>
      </div>
      <div class="reg-no">登録番号　T2200001044783</div>
    </div>

    <!-- 右ブロック -->
    <div class="info-right">
      <div class="issued-date-row">${formatDate(invoice.issued_at ?? '')}</div>
      ${invoice.payment_due_at
        ? `<div class="payment-due-row">お支払期限：${formatDate(invoice.payment_due_at)}</div>`
        : ''}
      <img src="${logoUrl}" class="company-logo" alt="株式会社ラグズ建築" />
      <div class="company-addr">
        〒500-8388<br>
        岐阜県岐阜市今嶺４丁目5-20<br>
        TEL　058-374-5318<br>
        E-mail　info@rugs_reform.jp<br>
        <span style="font-size:6.5pt;">岐阜県知事許可（般－8）第103774号</span>
      </div>
      <div class="seal-wrap"><div class="seal-box"></div></div>
    </div>

  </div>

  <!-- ③ 明細テーブル（Excelの列幅比率を再現） -->
  <table class="items-table">
    <colgroup>
      <col class="c-no">
      <col class="c-name">
      <col class="c-qty">
      <col class="c-unit">
      <col class="c-amt">
      <col class="c-memo">
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>工　事　名</th>
        <th>数量</th>
        <th>単位</th>
        <th>金　　　額</th>
        <th>備　　考</th>
      </tr>
    </thead>
    <tbody>
      ${displayRows.map((item, i) => item
        ? `<tr>
            <td class="td-no">${i + 1}</td>
            <td class="td-name">${escHtml(item.name)}</td>
            <td class="td-qty">${item.quantity !== 1 ? item.quantity : ''}</td>
            <td class="td-unit">${escHtml(item.unit)}</td>
            <td class="td-amt">${item.amount ? '¥' + f(item.amount) : ''}</td>
            <td class="td-memo">${escHtml(item.memo || '')}</td>
           </tr>`
        : `<tr>
            <td class="td-no" style="color:#bbb;">${i + 1}</td>
            <td class="td-name"></td><td class="td-qty"></td>
            <td class="td-unit"></td><td class="td-amt"></td><td class="td-memo"></td>
           </tr>`
      ).join('\n      ')}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="foot-label">小　　計</td>
        <td class="foot-value">¥${f(subtotal)}</td>
        <td></td>
      </tr>
      <tr>
        <td colspan="4" class="foot-label">消費税（10%）</td>
        <td class="foot-value">¥${f(tax)}</td>
        <td></td>
      </tr>
      ${invoice.adjustment && invoice.adjustment !== 0
        ? `<tr>
            <td colspan="4" class="foot-label">調整額</td>
            <td class="foot-value">¥${f(invoice.adjustment)}</td>
            <td></td>
           </tr>`
        : ''}
      <tr class="total-row">
        <td colspan="4" class="foot-label">合　　計</td>
        <td class="foot-value">¥${f(total)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>

  <!-- ④ 備考 -->
  <div class="notes-section">
    <div class="notes-label">備　考</div>
    <div>${escHtml(invoice.memo || '').replace(/\n/g, '<br>')}</div>
  </div>

</div><!-- /doc -->
</div><!-- /page -->

</body>
</html>`

  const win = window.open('', '_blank', 'width=860,height=1150')
  if (!win) { alert('ポップアップがブロックされました。ブラウザの設定で許可してから再度お試しください。'); return }
  win.document.write(html)
  win.document.close()
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── サブコンポーネント ─────────────────────────────────────

function StatusBadge({ status }: { status: Invoice['status'] }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
      color: cfg.color, background: cfg.bg, fontFamily: FONT, letterSpacing: '0.02em', flexShrink: 0,
    }}>
      {cfg.label}
    </span>
  )
}

function PayTypeBadge({ type }: { type: PaymentType }) {
  const colors: Record<PaymentType, { c: string; bg: string }> = {
    contract:   { c: '#7C3AED', bg: '#F5F3FF' },
    start:      { c: C.orange,  bg: C.orangeBg },
    completion: { c: C.green,   bg: C.greenBg  },
    custom:     { c: C.textMuted, bg: '#F1F5F9' },
  }
  const { c, bg } = colors[type] ?? colors.custom
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
      color: c, background: bg, fontFamily: FONT, letterSpacing: '0.02em', flexShrink: 0,
    }}>
      {PAYMENT_TYPE_LABEL[type]}
    </span>
  )
}

// ── 請求書カード ──────────────────────────────────────────

function InvoiceCard({
  invoice, onEdit, onDelete, onPrint,
}: {
  invoice: Invoice
  onEdit: () => void
  onDelete: () => void
  onPrint: (id: string) => void
}) {
  const subtotal = invoice.items.reduce((s, i) => s + i.amount, 0)
  const tax = Math.floor(subtotal * 0.1)
  const total = subtotal + tax + (invoice.adjustment ?? 0)

  const handlePrint = (e: React.MouseEvent) => {
    e.stopPropagation()
    printInvoice(invoice, subtotal, tax, total)
    onPrint(invoice.id)
  }

  return (
    <div
      onClick={onEdit}
      style={{
        background: C.bg, border: `1.5px solid ${C.border}`,
        borderRadius: 12, padding: '14px 18px', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 10,
        transition: 'border-color 0.15s, box-shadow 0.15s', fontFamily: FONT,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.borderColor = C.accentTint
        ;(e.currentTarget as HTMLElement).style.boxShadow = `0 2px 10px ${C.accent}18`
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.borderColor = C.border
        ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PayTypeBadge type={invoice.payment_type} />
        <StatusBadge status={invoice.status} />
        {invoice.printed_at && (
          <span style={{ fontSize: 10, color: C.textMuted }}>
            {formatDateTime(invoice.printed_at)} に出力
          </span>
        )}
        {invoice.invoice_number && (
          <span style={{ fontSize: 11, color: C.textMuted }}>{invoice.invoice_number}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={handlePrint}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 6,
            padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: FONT,
          }}
        >
          🖨️ 印刷
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{
            background: 'none', border: `1px solid ${C.border}`, cursor: 'pointer',
            color: C.textMuted, fontSize: 11, padding: '4px 8px',
            borderRadius: 4, fontFamily: FONT,
          }}
        >
          削除
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>
          {invoice.customer_name ? `${invoice.customer_name} 様` : '（顧客名未設定）'}
          {invoice.construction_name && (
            <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 8 }}>
              {invoice.construction_name}
            </span>
          )}
        </span>
        <span style={{ fontSize: 20, fontWeight: 800, color: C.green, fontVariantNumeric: 'tabular-nums' }}>
          ¥{fmt(total)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: C.textMuted }}>
        <span>発行日: {invoice.issued_at}</span>
        {invoice.payment_due_at && <span>支払期限: {invoice.payment_due_at}</span>}
        <span>{invoice.items.length}行</span>
      </div>
    </div>
  )
}

// ── 請求書エディタ ─────────────────────────────────────────

function InvoiceEditor({
  invoice: initial,
  projectInfo,
  estimateTotal,
  onSave,
  onClose,
  onPrint,
}: {
  invoice: Partial<Invoice> | null
  projectInfo: ProjectInfo
  estimateTotal: number
  onSave: (data: Partial<Invoice>) => Promise<void>
  onClose: () => void
  onPrint: (id: string) => void
}) {
  const isNew = !initial?.id

  const defaultItems = (): InvoiceItem[] => [{
    id: genId(), name: projectInfo.name ?? '工事', quantity: 1, unit: '式', amount: 0, memo: '',
  }]

  const [form, setForm] = useState<Partial<Invoice>>({
    payment_type: 'custom',
    customer_name: projectInfo.customer_name ?? '',
    construction_name: projectInfo.name ?? '',
    issued_at: new Date().toISOString().slice(0, 10),
    payment_due_at: '',
    invoice_number: '',
    items: defaultItems(),
    adjustment: 0,
    memo: '',
    status: 'draft',
    ...initial,
  })

  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  const items = form.items ?? []
  const subtotal = items.reduce((s, i) => s + (i.amount || 0), 0)
  const tax = Math.floor(subtotal * 0.1)
  const adjustment = form.adjustment ?? 0
  const total = subtotal + tax + adjustment

  // 支払種別変更時に金額を自動入力
  const handlePayTypeChange = (type: PaymentType) => {
    let pct: number | null = null
    if (type === 'contract')   pct = projectInfo.payment_contract_pct
    if (type === 'start')      pct = projectInfo.payment_start_pct
    if (type === 'completion') pct = projectInfo.payment_completion_pct

    setForm(prev => {
      const newForm = { ...prev, payment_type: type }
      if (pct != null && estimateTotal > 0) {
        // 税込合計から逆算して税抜金額を求める
        const inclTax = Math.round(estimateTotal * pct / 100)
        const exclTax = Math.round(inclTax / 1.1)
        const label = PAYMENT_TYPE_LABEL[type]
        newForm.items = [{
          id: genId(),
          name: `${projectInfo.name || '工事'}（${label}）`,
          quantity: 1, unit: '式', amount: exclTax, memo: '',
        }]
      }
      return newForm
    })
  }

  const updateItem = useCallback((idx: number, field: keyof InvoiceItem, val: string | number) => {
    setForm(prev => {
      const next = [...(prev.items ?? [])]
      next[idx] = { ...next[idx], [field]: val }
      return { ...prev, items: next }
    })
  }, [])

  const addItem = () => setForm(prev => ({
    ...prev,
    items: [...(prev.items ?? []), { id: genId(), name: '', quantity: 1, unit: '式', amount: 0, memo: '' }],
  }))

  const removeItem = (idx: number) => setForm(prev => {
    const next = [...(prev.items ?? [])]
    next.splice(idx, 1)
    return { ...prev, items: next }
  })

  async function handleSave() {
    setSaving(true)
    try {
      await onSave({ ...form, status: form.status ?? 'draft' })
      setToast('保存しました')
      setTimeout(() => setToast(''), 2000)
    } catch {
      setToast('保存に失敗しました')
      setTimeout(() => setToast(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  const inputSt: React.CSSProperties = {
    border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 9px',
    fontSize: 13, fontFamily: FONT, color: C.text, background: '#FAFCFB', outline: 'none', width: '100%',
  }
  const labelSt: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: C.label, fontFamily: FONT, marginBottom: 4, display: 'block',
  }

  return (
    <div style={{ background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 14, fontFamily: FONT, overflow: 'hidden' }}>
      {/* エディタヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: `1px solid ${C.divider}`, background: C.accentBg }}>
        <button onClick={onClose} style={{ background: 'none', border: `1px solid ${C.accentTint}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: C.accent, fontFamily: FONT }}>
          ← 一覧に戻る
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
          {isNew ? '請求書を新規作成' : '請求書を編集'}
        </span>
        <span style={{ flex: 1 }} />
        {/* 印刷ボタン */}
        <button
          onClick={() => {
            printInvoice(form, subtotal, tax, total)
            if (form.id) onPrint(form.id)
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 7,
            padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
          </svg>
          印刷プレビュー
        </button>
        <button onClick={handleSave} disabled={saving} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: FONT, opacity: saving ? 0.6 : 1 }}>
          {saving ? '保存中…' : '保存する'}
        </button>
      </div>

      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* ── Row1: 支払種別 / 請求書No. / ステータス ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelSt}>支払種別</label>
            <select value={form.payment_type ?? 'custom'} onChange={e => handlePayTypeChange(e.target.value as PaymentType)} style={{ ...inputSt }}>
              <option value="contract">契約時</option>
              <option value="start">着工時</option>
              <option value="completion">完工時</option>
              <option value="custom">カスタム</option>
            </select>
            {form.payment_type !== 'custom' && estimateTotal > 0 && (() => {
              const pcts: Record<string, number | null> = { contract: projectInfo.payment_contract_pct, start: projectInfo.payment_start_pct, completion: projectInfo.payment_completion_pct }
              const pct = pcts[form.payment_type ?? '']
              return pct != null ? (
                <span style={{ fontSize: 10, color: C.textMuted, marginTop: 3, display: 'block' }}>
                  見積税込合計の {pct}% = ¥{fmt(Math.round(estimateTotal * pct / 100))}
                </span>
              ) : null
            })()}
          </div>
          <div>
            <label style={labelSt}>請求書No.</label>
            <input style={inputSt} value={form.invoice_number ?? ''} onChange={e => setForm(p => ({ ...p, invoice_number: e.target.value }))} placeholder="例：請-2024-001" />
          </div>
          <div>
            <label style={labelSt}>ステータス</label>
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              {(['draft', 'issued', 'paid'] as const).map(s => (
                <button key={s} onClick={() => setForm(p => ({ ...p, status: s }))} style={{ flex: 1, padding: '6px 4px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, border: form.status === s ? `1.5px solid ${C.accent}` : `1px solid ${C.border}`, background: form.status === s ? C.accentBg : C.bg, color: form.status === s ? C.accent : C.textMuted }}>
                  {STATUS_CONFIG[s].label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Row2: 顧客名 / 工事名 / 発行日 / 支払期限 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px 140px', gap: 16 }}>
          <div>
            <label style={labelSt}>顧客名（様）</label>
            <input style={inputSt} value={form.customer_name ?? ''} onChange={e => setForm(p => ({ ...p, customer_name: e.target.value }))} placeholder="例：栗本" />
          </div>
          <div>
            <label style={labelSt}>工事名</label>
            <input style={inputSt} value={form.construction_name ?? ''} onChange={e => setForm(p => ({ ...p, construction_name: e.target.value }))} placeholder="例：犬山市古民家滅築プラン" />
          </div>
          <div>
            <label style={labelSt}>発行日</label>
            <input type="date" style={inputSt} value={form.issued_at ?? ''} onChange={e => setForm(p => ({ ...p, issued_at: e.target.value }))} />
          </div>
          <div>
            <label style={labelSt}>お支払期限</label>
            <input type="date" style={inputSt} value={form.payment_due_at ?? ''} onChange={e => setForm(p => ({ ...p, payment_due_at: e.target.value || null }))} />
          </div>
        </div>

        {/* ── 明細テーブル ── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, letterSpacing: '0.05em' }}>明細</span>
            <button onClick={addItem} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: C.textSub, fontFamily: FONT }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              行を追加
            </button>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {/* ヘッダー */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 64px 52px 150px 1fr 32px', background: '#F8FAF9', borderBottom: `1px solid ${C.divider}`, padding: '0 10px' }}>
              {['工事名 / 内容', '数量', '単位', '金額（税抜）', '備考', ''].map((h, i) => (
                <div key={i} style={{ fontSize: 10, fontWeight: 700, color: C.label, padding: '8px 6px', textAlign: i >= 1 && i <= 3 ? 'right' as const : 'left' as const, letterSpacing: '0.04em' }}>
                  {h}
                </div>
              ))}
            </div>
            {/* 行 */}
            {items.map((item, idx) => (
              <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '2fr 64px 52px 150px 1fr 32px', padding: '5px 10px', borderBottom: idx < items.length - 1 ? `1px solid ${C.divider}` : 'none', alignItems: 'center', gap: 4 }}>
                <input style={{ ...inputSt, fontSize: 12 }} value={item.name} onChange={e => updateItem(idx, 'name', e.target.value)} placeholder="例：リフォーム工事（契約時）" />
                <input type="number" style={{ ...inputSt, fontSize: 12, textAlign: 'right' }} value={item.quantity} min={0} onChange={e => updateItem(idx, 'quantity', Number(e.target.value))} />
                <input style={{ ...inputSt, fontSize: 12, textAlign: 'center' }} value={item.unit} onChange={e => updateItem(idx, 'unit', e.target.value)} />
                <input type="number" style={{ ...inputSt, fontSize: 12, textAlign: 'right' }} value={item.amount} min={0} onChange={e => updateItem(idx, 'amount', Number(e.target.value))} placeholder="0" />
                <input style={{ ...inputSt, fontSize: 12 }} value={item.memo} onChange={e => updateItem(idx, 'memo', e.target.value)} placeholder="備考" />
                <button onClick={() => removeItem(idx)} disabled={items.length <= 1} style={{ background: 'none', border: 'none', cursor: items.length <= 1 ? 'not-allowed' : 'pointer', color: C.textMuted, fontSize: 16, padding: 0, opacity: items.length <= 1 ? 0.3 : 1 }}>×</button>
              </div>
            ))}
          </div>
        </div>

        {/* ── 合計 ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', minWidth: 340 }}>
            {[
              { label: '小計（税抜）', value: `¥${fmt(subtotal)}` },
              { label: '消費税（10%）', value: `¥${fmt(tax)}` },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${C.divider}`, background: C.bg }}>
                <span style={{ fontSize: 12, color: C.label, fontFamily: FONT }}>{label}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${C.divider}` }}>
              <span style={{ fontSize: 12, color: C.label, fontFamily: FONT }}>調整額（端数など）</span>
              <input type="number" value={adjustment} onChange={e => setForm(p => ({ ...p, adjustment: Number(e.target.value) }))} style={{ ...inputSt, width: 120, textAlign: 'right', fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: C.accentBg }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: FONT }}>ご請求金額（税込）</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: C.green, fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}>¥{fmt(total)}</span>
            </div>
          </div>
        </div>

        {/* ── 備考 ── */}
        <div>
          <label style={labelSt}>備考・特記事項</label>
          <textarea value={form.memo ?? ''} onChange={e => setForm(p => ({ ...p, memo: e.target.value || null }))} rows={3}
            placeholder="例：恐れ入りますが、期日までにお振込みいただけますようお願いいたします。"
            style={{ ...inputSt, resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: C.accent, color: '#fff', padding: '10px 24px', borderRadius: 20, fontSize: 13, fontWeight: 600, fontFamily: FONT, zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', pointerEvents: 'none' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ── メインコンポーネント ────────────────────────────────────

export function InvoiceTab({
  projectId,
  projectInfo,
}: {
  projectId: string
  projectInfo: ProjectInfo
}) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<Invoice> | null | 'new'>(null)
  const [estimateTotal, setEstimateTotal] = useState(0)

  const loadInvoices = useCallback(async () => {
    const res = await fetch(`/api/invoices?project_id=${projectId}`)
    if (res.ok) setInvoices(await res.json())
    setLoading(false)
  }, [projectId])

  // 見積合計（税込）をSupabaseから直接集計
  const loadEstimateTotal = useCallback(async () => {
    const supabase = getClient()
    const [{ data: items }, { data: proj }] = await Promise.all([
      supabase.from('estimate_items').select('quantity, selling_price, amount').eq('project_id', projectId).is('deleted_at', null),
      supabase.from('projects').select('misc_expense_override, rounding_discount').eq('id', projectId).single(),
    ])
    if (!items) return
    const subtotal = items.reduce((s, i) =>
      s + (i.selling_price != null ? Math.round(i.quantity * i.selling_price) : (i.amount ?? 0)), 0)
    const misc = proj?.misc_expense_override != null ? proj.misc_expense_override : Math.round(subtotal * 0.08)
    const rounding = proj?.rounding_discount ?? 0
    const taxBase = subtotal + misc - rounding
    setEstimateTotal(taxBase + Math.floor(taxBase * 0.1))
  }, [projectId])

  useEffect(() => {
    loadInvoices()
    loadEstimateTotal()
  }, [loadInvoices, loadEstimateTotal])

  async function handleSave(data: Partial<Invoice>) {
    if (editing === 'new' || !data.id) {
      const res = await fetch('/api/invoices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...data }),
      })
      if (!res.ok) throw new Error(await res.text())
      const created = await res.json()
      setInvoices(prev => [created, ...prev])
      setEditing(created)
    } else {
      const res = await fetch(`/api/invoices/${data.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      setInvoices(prev => prev.map(inv => inv.id === updated.id ? updated : inv))
      setEditing(updated)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('この請求書を削除しますか？')) return
    const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setInvoices(prev => prev.filter(inv => inv.id !== id))
      if (typeof editing === 'object' && editing && (editing as Invoice).id === id) setEditing(null)
    }
  }

  async function handlePrint(id: string) {
    const now = new Date().toISOString()
    const res = await fetch(`/api/invoices/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printed_at: now }),
    })
    if (res.ok) {
      const updated = await res.json()
      setInvoices(prev => prev.map(inv => inv.id === updated.id ? updated : inv))
    }
  }

  return (
    <div style={{ background: C.pageBg, minHeight: '50vh', padding: '20px 16px 40px', fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── ヘッダー ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0 }}>請求書</h2>
          {estimateTotal > 0 && (
            <p style={{ fontSize: 11, color: C.textMuted, margin: '3px 0 0' }}>
              見積合計（税込）: ¥{fmt(estimateTotal)}
            </p>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {editing == null && (
          <button onClick={() => setEditing('new')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#E3EFE7', color: '#2B5E40', border: '1px solid #BDD1C3', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            請求書を新規作成
          </button>
        )}
      </div>

      {/* ── 支払スケジュール参考 ── */}
      {editing == null && estimateTotal > 0 && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.label }}>支払スケジュール参考</span>
          {([
            { label: '契約時', pct: projectInfo.payment_contract_pct },
            { label: '着工時', pct: projectInfo.payment_start_pct },
            { label: '完工時', pct: projectInfo.payment_completion_pct },
          ]).map(({ label, pct }) => pct != null && pct > 0 ? (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 10, color: C.textMuted }}>{label}（{pct}%）</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                ¥{fmt(Math.round(estimateTotal * pct / 100))}
              </span>
            </div>
          ) : null)}
        </div>
      )}

      {/* ── エディタ or 一覧 ── */}
      {editing != null ? (
        <InvoiceEditor
          invoice={editing === 'new' ? null : editing as Partial<Invoice>}
          projectInfo={projectInfo}
          estimateTotal={estimateTotal}
          onSave={handleSave}
          onClose={() => setEditing(null)}
          onPrint={handlePrint}
        />
      ) : loading ? (
        <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 40 }}>読み込み中…</div>
      ) : invoices.length === 0 ? (
        <div style={{ background: C.bg, border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: '40px 24px', textAlign: 'center' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={C.accentTint} strokeWidth="1.5" style={{ marginBottom: 12 }}>
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '0 0 16px', fontFamily: FONT }}>まだ請求書がありません</p>
          <button onClick={() => setEditing('new')} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT }}>
            最初の請求書を作成する
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map(inv => (
            <InvoiceCard key={inv.id} invoice={inv} onEdit={() => setEditing(inv)} onDelete={() => handleDelete(inv.id)} onPrint={handlePrint} />
          ))}
        </div>
      )}
    </div>
  )
}
