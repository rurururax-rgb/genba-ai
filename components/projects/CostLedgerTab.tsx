'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { VendorInvoiceImportTab } from './VendorInvoiceImportTab'
import { Button } from '@/components/ui/button'

// ── 型定義 ────────────────────────────────────────────────

type CostItem = {
  id: string
  name: string
  quantity: number
  unit: string
  estimate_cost:   number | null
  budget_cost:     number | null
  completion_cost: number | null
  actual_cost:     number | null
  note: string | null
  vendor_name: string | null
  sort_order: number
  source: string
  estimate_item_id: string | null
}

type Invoice = {
  id: string
  cost_ledger_item_id: string
  amount: number
  invoice_date:  string | null
  payment_date:  string | null
  note: string | null
  created_at: string
}

type Summary = {
  estimate_revenue:      number
  estimate_cost_total:   number
  contract_amount:       number
  base_contract_amount:  number
  additional_amount_1:   number | null
  additional_amount_2:   number | null
  additional_amount_3:   number | null
  budget_cost_total:     number
  completion_cost_total: number
  actual_cost_total:     number
  has_budget_data:     boolean
  has_completion_data: boolean
  has_actual_data:     boolean
}

type BillingMilestone = {
  id: string
  type: string
  sort_order: number
  invoice_date:   string | null
  invoice_amount: number | null
  payment_date:   string | null
  payment_amount: number | null
  fee:            number | null
}

type EditingCell = {
  id: string
  field: 'name' | 'budget_cost' | 'completion_cost' | 'actual_cost' | 'note' | 'vendor_name'
  value: string
}

// ── デザイントークン（RAGZ Green系） ──────────────────────

const C = {
  pageBg:      '#F3F7F4',
  bg:          '#FFFFFF',
  border:      '#E5E7EB',
  borderLight: '#E8F0EA',
  hover:       '#F0F6F2',
  selected:    '#EAF3DE',
  accent:      '#2B5E40',
  accentLight: '#EAF3DE',
  text:        '#1A2E24',
  textSub:     '#2D4A38',
  textMuted:   '#7A9185',
  groupBg:     '#F0F6F2',
  invBg:       '#F3F7F4',
  invBorder:   '#E5E7EB',
  red:         '#C0392B',
  redBg:       '#FDF2F2',
  green:       '#1E7045',
  greenBg:     '#EBF6F0',
} as const

const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const HDIV  = `1px solid ${C.border}`

// ── ヘルパー ──────────────────────────────────────────────

function fmtYen(n: number | null | undefined): string {
  if (n == null) return '─'
  return '¥' + Math.round(n).toLocaleString('ja-JP')
}

function fmtDiff(diff: number | null): { text: string; color: string; bg: string } {
  if (diff == null || Math.abs(diff) < 1) {
    return { text: '─', color: C.textMuted, bg: 'transparent' }
  }
  const abs    = Math.round(Math.abs(diff))
  const isOver = diff > 0
  return {
    text:  (isOver ? '＋' : '▲') + '¥' + abs.toLocaleString('ja-JP'),
    color: isOver ? C.red   : C.green,
    bg:    isOver ? C.redBg : C.greenBg,
  }
}

function marginColor(rate: number): string {
  if (rate >= 0.30) return '#1D4ED8'
  if (rate >= 0.20) return C.accent
  if (rate >= 0.10) return '#A16207'
  return C.red
}

function marginBg(rate: number): string {
  if (rate >= 0.30) return '#EFF6FF'
  if (rate >= 0.20) return C.accentLight
  if (rate >= 0.10) return '#FEF9C3'
  return '#FEE2E2'
}

function fmt(n: number) { return n.toLocaleString('ja-JP') }

// ── InvoicePanel ─────────────────────────────────────────
// 1行分の分割請求内訳を展開表示するパネル

function InvoicePanel({
  itemId, invoices, onInvoicesChange, onActualCostChange,
}: {
  itemId: string
  invoices: Invoice[]
  onInvoicesChange: (invs: Invoice[]) => void
  onActualCostChange: (newCost: number | null) => void
}) {
  const [adding, setAdding]     = useState(false)
  const [draft,  setDraft]      = useState<{ amount: string; invoice_date: string; payment_date: string; note: string }>({ amount: '', invoice_date: '', payment_date: '', note: '' })
  const [editId,  setEditId]    = useState<string | null>(null)
  const [editAmt, setEditAmt]   = useState('')
  const amountRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) setTimeout(() => amountRef.current?.focus(), 0)
  }, [adding])

  async function handleAdd() {
    const amount = parseFloat(draft.amount.replace(/[,¥]/g, ''))
    if (isNaN(amount) || amount <= 0) return
    const res = await fetch(`/api/cost-ledger/${itemId}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, invoice_date: draft.invoice_date || null, payment_date: draft.payment_date || null, note: draft.note || null }),
    })
    if (!res.ok) return
    const { invoice, newActualCost } = await res.json() as { invoice: Invoice; newActualCost: number }
    onInvoicesChange([...invoices, invoice])
    onActualCostChange(newActualCost)
    setDraft({ amount: '', invoice_date: '', payment_date: '', note: '' })
    setAdding(false)
  }

  async function handleAmountEdit(inv: Invoice) {
    const amount = parseFloat(editAmt.replace(/[,¥]/g, ''))
    if (isNaN(amount) || amount <= 0) { setEditId(null); return }
    if (amount === inv.amount) { setEditId(null); return }
    const res = await fetch(`/api/cost-ledger/invoices/${inv.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    })
    if (!res.ok) return
    const { invoice: updated, newActualCost } = await res.json() as { invoice: Invoice; newActualCost: number }
    onInvoicesChange(invoices.map(i => i.id === inv.id ? updated : i))
    onActualCostChange(newActualCost)
    setEditId(null)
  }

  async function handleDelete(inv: Invoice) {
    const res = await fetch(`/api/cost-ledger/invoices/${inv.id}`, { method: 'DELETE' })
    if (!res.ok) return
    const { newActualCost } = await res.json() as { newActualCost: number | null }
    onInvoicesChange(invoices.filter(i => i.id !== inv.id))
    onActualCostChange(newActualCost)
  }

  const total = invoices.reduce((s, i) => s + i.amount, 0)

  return (
    <div style={ps.panel}>
      <div style={ps.header}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.accent}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: '0.04em', fontFamily: FONT }}>
          分割請求の内訳
        </span>
        {invoices.length > 0 && (
          <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT }}>
            合計: <strong style={{ color: C.text }}>¥{fmt(total)}</strong>
          </span>
        )}
      </div>

      {invoices.length > 0 && (
        <div style={ps.list}>
          <div style={ps.row}>
            <span style={{ ...ps.cell, flex: 1.2, fontWeight: 700, color: C.textMuted, fontSize: 10, letterSpacing: '0.04em' }}>金額</span>
            <span style={{ ...ps.cell, flex: 1.2, fontWeight: 700, color: C.textMuted, fontSize: 10, letterSpacing: '0.04em' }}>請求日</span>
            <span style={{ ...ps.cell, flex: 1.2, fontWeight: 700, color: C.textMuted, fontSize: 10, letterSpacing: '0.04em' }}>支払日</span>
            <span style={{ ...ps.cell, flex: 2, fontWeight: 700, color: C.textMuted, fontSize: 10, letterSpacing: '0.04em' }}>メモ</span>
            <span style={{ width: 28 }} />
          </div>
          {invoices.map((inv, i) => (
            <div key={inv.id} style={{ ...ps.row, background: i % 2 === 0 ? 'transparent' : C.borderLight }}>
              {editId === inv.id ? (
                <input
                  autoFocus
                  className="cl-edit-input"
                  value={editAmt}
                  onChange={e => setEditAmt(e.target.value)}
                  onBlur={() => handleAmountEdit(inv)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAmountEdit(inv); if (e.key === 'Escape') setEditId(null) }}
                  style={{ ...ps.cell, flex: 1.2, border: `1.5px solid ${C.accent}`, borderRadius: 6, padding: '2px 6px', fontSize: 12, outline: 'none', background: '#fff' }}
                />
              ) : (
                <span
                  style={{ ...ps.cell, flex: 1.2, fontWeight: 600, color: C.text, cursor: 'text', fontVariantNumeric: 'tabular-nums' }}
                  onClick={() => { setEditId(inv.id); setEditAmt(String(inv.amount)) }}
                  title="クリックで編集"
                >
                  ¥{fmt(inv.amount)}
                </span>
              )}
              <span style={{ ...ps.cell, flex: 1.2, color: C.textSub, fontSize: 12 }}>
                {inv.invoice_date ? inv.invoice_date.slice(0, 10) : '─'}
              </span>
              <span style={{ ...ps.cell, flex: 1.2, color: C.textSub, fontSize: 12 }}>
                {inv.payment_date ? inv.payment_date.slice(0, 10) : '─'}
              </span>
              <span style={{ ...ps.cell, flex: 2, color: C.textSub, fontSize: 12 }}>
                {inv.note || '─'}
              </span>
              <button onClick={() => handleDelete(inv)} style={ps.delBtn} title="削除">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div style={ps.addForm}>
          <input
            ref={amountRef}
            type="number"
            placeholder="金額"
            value={draft.amount}
            onChange={e => setDraft(v => ({ ...v, amount: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false) }}
            style={{ ...ps.input, flex: 1.2 }}
          />
          <input
            type="date"
            value={draft.invoice_date}
            onChange={e => setDraft(v => ({ ...v, invoice_date: e.target.value }))}
            style={{ ...ps.input, flex: 1.2 }}
          />
          <input
            type="date"
            value={draft.payment_date}
            onChange={e => setDraft(v => ({ ...v, payment_date: e.target.value }))}
            style={{ ...ps.input, flex: 1.2 }}
          />
          <input
            placeholder="メモ（任意）"
            value={draft.note}
            onChange={e => setDraft(v => ({ ...v, note: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false) }}
            style={{ ...ps.input, flex: 2 }}
          />
          <button onClick={handleAdd} style={ps.saveBtn}>追加</button>
          <button onClick={() => setAdding(false)} style={ps.cancelBtn}>キャンセル</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={ps.addRowBtn}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          内訳を追加
        </button>
      )}
    </div>
  )
}

// ── パネルスタイル ─────────────────────────────────────────

const ps: Record<string, React.CSSProperties> = {
  panel: {
    background: C.invBg,
    borderTop: `1px dashed ${C.invBorder}`,
    borderBottom: `1px solid ${C.invBorder}`,
    padding: '10px 16px 10px 40px',
    fontFamily: FONT,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  list: {
    marginBottom: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 28,
    borderRadius: 4,
    padding: '2px 4px',
  },
  cell: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontFamily: FONT,
  } as React.CSSProperties,
  delBtn: {
    width: 24, height: 24,
    border: 'none', background: 'transparent',
    borderRadius: 4, cursor: 'pointer',
    color: C.textMuted, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    padding: 0, flexShrink: 0,
  },
  addForm: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  input: {
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    outline: 'none',
    background: '#fff',
    color: C.text,
    fontFamily: FONT,
    minWidth: 0,
  } as React.CSSProperties,
  saveBtn: {
    padding: '4px 12px',
    borderRadius: 5,
    background: C.accent,
    color: '#fff',
    border: 'none',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: FONT,
  },
  cancelBtn: {
    padding: '4px 10px',
    borderRadius: 5,
    background: 'transparent',
    color: C.textSub,
    border: `1px solid ${C.border}`,
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: FONT,
  },
  addRowBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 10px',
    border: `1px dashed ${C.border}`,
    borderRadius: 5,
    background: 'transparent',
    color: C.textSub,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: FONT,
  },
}

// ── メインコンポーネント ──────────────────────────────────

// ── 業者別集計の型 ─────────────────────────────────────────

type VendorGroup = {
  vendor: string
  items: CostItem[]
  estimateCost: number
  budgetCost: number | null
  actualCost: number | null
  sellingAmount: number
}

export function CostLedgerTab({ projectId }: { projectId: string }) {
  const [items,       setItems]      = useState<CostItem[]>([])
  const [summary,     setSummary]    = useState<Summary | null>(null)
  const [loading,     setLoading]    = useState(true)
  const [loadError,   setLoadError]  = useState<string | null>(null)
  const [initializing, setInit]      = useState(false)
  const [syncing,      setSyncing]   = useState(false)
  const [editing,     setEditing]    = useState<EditingCell | null>(null)
  const [expandedIds, setExpanded]   = useState<Record<string, boolean>>({})
  const [invoicesMap, setInvoices]   = useState<Record<string, Invoice[]>>({})
  const [loadingInv,  setLoadingInv] = useState<Record<string, boolean>>({})
  const [checked,     setChecked]    = useState<Record<string, boolean>>({})
  const [viewMode,    setViewMode]   = useState<'item' | 'vendor'>('vendor')
  const [vendorSelling, setVendorSelling] = useState<Record<string, number>>({})
  const [expandedVendors, setExpandedVendors] = useState<Record<string, boolean>>({})
  const [billingMilestones, setBillingMilestones] = useState<BillingMilestone[]>([])
  const [billingLoading, setBillingLoading] = useState(false)
  const [editingBilling, setEditingBilling] = useState<{ id: string; field: string; value: string } | null>(null)
  const [additionalAmounts, setAdditionalAmounts] = useState<[number|null, number|null, number|null]>([null, null, null])
  const [editingAdditional, setEditingAdditional] = useState<{ idx: number; value: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  // セル金額合計選択（Layer 1 + Layer 2）
  // key: item.id+':ec'（見積原価）/ ':d1'（差額①）/ ':d2'（差額②）/ ':bc'（実行予算）/ ':cc'（完工実績）/ ':ac'（請求実績）
  const [sumSelection, setSumSelection] = useState<Map<string, number>>(new Map)
  const [sumMode, setSumMode] = useState(false)
  const sumTotal = useMemo(() => { let t = 0; sumSelection.forEach(v => { t += v }); return t }, [sumSelection])

  const editRef = useRef<HTMLInputElement>(null)
  const billingEditRef = useRef<HTMLInputElement>(null)

  // ── 業者別集計（フロントエンドのみ、DB変更不要） ──────────
  // Excelの原価台帳: C列=工種名, O列=見積原価, AG列=業者支払合計, AK=O-AG
  // ここでは vendor_name でグループ化し、同じ集計ロジックを再現する
  const vendorGroups = useMemo<VendorGroup[]>(() => {
    const map = new Map<string, VendorGroup>()
    for (const item of items) {
      const key = item.vendor_name?.trim() || '（業者未設定）'
      if (!map.has(key)) {
        map.set(key, { vendor: key, items: [], estimateCost: 0, budgetCost: null, actualCost: null, sellingAmount: 0 })
      }
      const g = map.get(key)!
      g.items.push(item)
      g.estimateCost += item.estimate_cost ?? 0
      if (item.budget_cost != null) g.budgetCost = (g.budgetCost ?? 0) + item.budget_cost
      if (item.actual_cost  != null) g.actualCost  = (g.actualCost  ?? 0) + item.actual_cost
    }
    // estimate_items 由来の業者別売上額をマージ
    for (const [key, amount] of Object.entries(vendorSelling)) {
      if (map.has(key)) {
        map.get(key)!.sellingAmount = amount
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.vendor === '（業者未設定）') return 1
      if (b.vendor === '（業者未設定）') return -1
      return a.vendor.localeCompare(b.vendor, 'ja')
    })
  }, [items, vendorSelling])

  const EMPTY_SUMMARY: Summary = {
    estimate_revenue: 0, estimate_cost_total: 0,
    contract_amount: 0, base_contract_amount: 0,
    additional_amount_1: null, additional_amount_2: null, additional_amount_3: null,
    budget_cost_total: 0, completion_cost_total: 0, actual_cost_total: 0,
    has_budget_data: false, has_completion_data: false, has_actual_data: false,
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cost-ledger?project_id=${projectId}`).catch(() => null as Response | null)
      if (!res) {
        setLoadError('ネットワークエラーが発生しました')
      } else if (res.ok) {
        const d = await res.json()
        setItems(d.items ?? [])
        setVendorSelling(d.vendorSelling ?? {})
        const smry: Summary = d.summary ?? EMPTY_SUMMARY
        setSummary(smry)
        setAdditionalAmounts([
          smry.additional_amount_1 ?? null,
          smry.additional_amount_2 ?? null,
          smry.additional_amount_3 ?? null,
        ])
      } else {
        const err = await res.json().catch(() => ({}))
        setLoadError(err.error ?? `データ取得に失敗しました（HTTP ${res.status}）`)
        setSummary(EMPTY_SUMMARY)
      }
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (editing) editRef.current?.focus() }, [editing])
  // ESC で合計選択クリア（編集中のキーハンドラが stopPropagation するため競合しない）
  useEffect(() => {
    if (sumSelection.size === 0) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setSumSelection(new Map) }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [sumSelection])


  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ target_table: string }>).detail
      if (detail?.target_table === 'cost_ledger_items') load()
    }
    window.addEventListener('genba:data-changed', handler)
    return () => window.removeEventListener('genba:data-changed', handler)
  }, [load])

  // ── 請求・入金情報ロード ──────────────────────────────────
  const loadBilling = useCallback(async () => {
    try {
      const res = await fetch(`/api/project-billing?project_id=${projectId}`)
      if (res.ok) setBillingMilestones(await res.json())
    } finally {
      setBillingLoading(false)
    }
  }, [projectId])

  useEffect(() => { loadBilling() }, [loadBilling])
  useEffect(() => { if (editingBilling) billingEditRef.current?.focus() }, [editingBilling])

  async function saveBillingCell(id: string, field: string, raw: string) {
    const numFields = ['invoice_amount', 'payment_amount', 'fee']
    const val = numFields.includes(field)
      ? (raw === '' ? null : Number(raw.replace(/,/g, '')))
      : (raw === '' ? null : raw)
    const res = await fetch(`/api/project-billing/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: val }),
    })
    if (res.ok) {
      const updated = await res.json() as BillingMilestone
      setBillingMilestones(prev => prev.map(m => m.id === id ? updated : m))
    }
    setEditingBilling(null)
  }

  async function saveAdditionalAmount(idx: number, raw: string) {
    const val = raw === '' ? null : Number(raw.replace(/,/g, ''))
    const key = `additional_amount_${idx + 1}` as 'additional_amount_1'
    const res = await fetch('/api/project-billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, [key]: val }),
    })
    if (res.ok) {
      const updated = await res.json()
      setAdditionalAmounts(prev => {
        const next = [...prev] as [number|null, number|null, number|null]
        next[idx] = updated[key] ?? null
        return next
      })
      load() // サマリー再計算
    }
    setEditingAdditional(null)
  }

  // ── 内訳パネル開閉 ───────────────────────────────────────
  async function toggleInvoices(itemId: string) {
    const wasOpen = expandedIds[itemId]
    setExpanded(p => ({ ...p, [itemId]: !wasOpen }))
    if (!wasOpen && !invoicesMap[itemId]) {
      setLoadingInv(p => ({ ...p, [itemId]: true }))
      try {
        const res = await fetch(`/api/cost-ledger/${itemId}/invoices`)
        if (res.ok) {
          const data = await res.json() as Invoice[]
          setInvoices(p => ({ ...p, [itemId]: data }))
        }
      } finally {
        setLoadingInv(p => ({ ...p, [itemId]: false }))
      }
    }
  }

  // ── 見積と同期 ──────────────────────────────────────────
  async function handleSync() {
    if (!confirm('見積エディタの最新内容を原価台帳に反映します。\n※ 実行予算・実績・注意点の入力済み値は変更されません。')) return
    setSyncing(true)
    try {
      const res = await fetch('/api/cost-ledger/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      const data = await res.json()
      if (res.ok) {
        await load()
        const { added, updated, removed } = data as { added: number; updated: number; removed: number }
        const parts = []
        if (added)   parts.push(`追加 ${added}件`)
        if (updated) parts.push(`更新 ${updated}件`)
        if (removed) parts.push(`削除 ${removed}件`)
        alert(parts.length ? `同期完了：${parts.join('・')}` : '差分なし（変更はありませんでした）')
      } else {
        alert(data.error ?? '同期に失敗しました')
      }
    } finally {
      setSyncing(false)
    }
  }

  // ── 初期化 ───────────────────────────────────────────────
  async function handleInit() {
    if (!confirm('見積エディタの原価データを原価台帳に取り込みます。よろしいですか？')) return
    setInit(true)
    try {
      const res = await fetch('/api/cost-ledger/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      if (res.ok) {
        await load()
      } else {
        const err = await res.json()
        alert(err.error ?? '初期化に失敗しました')
      }
    } finally {
      setInit(false)
    }
  }

  // ── セル編集 ─────────────────────────────────────────────
  function startEdit(item: CostItem, field: EditingCell['field']) {
    const raw =
      field === 'budget_cost'     ? item.budget_cost
      : field === 'completion_cost' ? item.completion_cost
      : field === 'actual_cost'     ? item.actual_cost
      : field === 'note'            ? item.note
      : field === 'vendor_name'     ? item.vendor_name
      : item.name
    setEditing({ id: item.id, field, value: String(raw ?? '') })
  }

  async function commitEdit() {
    if (!editing) return
    const { id, field, value } = editing
    setEditing(null)
    const orig = items.find(i => i.id === id)
    if (!orig) return

    const isNumField = field === 'budget_cost' || field === 'completion_cost' || field === 'actual_cost'
    let parsed: string | number | null = value.trim()
    if (isNumField) {
      const n = parseFloat(value.replace(/[¥,]/g, ''))
      parsed = value.trim() === '' || isNaN(n) ? null : n
    }
    if (parsed === null && field === 'name') return

    setItems(prev => prev.map(i => i.id === id ? { ...i, [field]: parsed } : i))

    if (isNumField) {
      const keyMap: Record<string, keyof Summary> = {
        budget_cost:     'budget_cost_total',
        completion_cost: 'completion_cost_total',
        actual_cost:     'actual_cost_total',
      }
      const hasMap: Record<string, keyof Summary> = {
        budget_cost:     'has_budget_data',
        completion_cost: 'has_completion_data',
        actual_cost:     'has_actual_data',
      }
      const key    = keyMap[field]
      const hasFld = hasMap[field]
      const oldVal = (orig[field as keyof CostItem] as number | null) ?? 0
      const newVal = (parsed as number | null) ?? 0
      setSummary(prev => {
        if (!prev) return prev
        const newHas = items.some(i => i.id === id ? parsed != null : (i[field as keyof CostItem] as number | null) != null)
        return { ...prev, [key]: (prev[key] as number) - oldVal + newVal, [hasFld]: newHas }
      })
    }

    await fetch(`/api/cost-ledger/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: parsed }),
    })
  }

  // ── 行追加・削除 ─────────────────────────────────────────
  async function addRow() {
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order), 0)
    const res = await fetch('/api/cost-ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, sort_order: maxOrder + 1 }),
    })
    if (res.ok) {
      const item = await res.json()
      setItems(prev => [...prev, item])
    }
  }

  async function deleteRow(id: string) {
    const old = items.find(i => i.id === id)
    setItems(prev => prev.filter(i => i.id !== id))
    setChecked(p => { const n = { ...p }; delete n[id]; return n })
    if (old) {
      setSummary(prev => prev ? {
        ...prev,
        budget_cost_total: prev.budget_cost_total - (old.budget_cost ?? 0),
        actual_cost_total: prev.actual_cost_total - (old.actual_cost ?? 0),
      } : prev)
    }
    await fetch(`/api/cost-ledger/${id}`, { method: 'DELETE' })
  }

  // ── チェックボックス ──────────────────────────────────────
  const checkedIds   = Object.keys(checked).filter(id => checked[id])
  const allChecked   = items.length > 0 && checkedIds.length === items.length
  const someChecked  = checkedIds.length > 0 && !allChecked

  function toggleAll() {
    if (allChecked) {
      setChecked({})
    } else {
      setChecked(Object.fromEntries(items.map(i => [i.id, true])))
    }
  }

  function toggleOne(id: string) {
    setChecked(p => ({ ...p, [id]: !p[id] }))
  }

  // 見積から引用（将来 copy_items_from_project ロジックと接続）
  function handleCopyToEstimate() {
    const selected = items.filter(i => checked[i.id])
    window.dispatchEvent(new CustomEvent('genba:copy-to-estimate', { detail: { items: selected } }))
  }

  // ── ロード中 / エラー ────────────────────────────────────
  if (loading || !summary) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80, gap: 10, fontFamily: FONT }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent }} />
        <span style={{ fontSize: 14, color: C.textMuted }}>読み込み中...</span>
      </div>
    )
  }

  if (loadError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 16, fontFamily: FONT }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#C0392B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p style={{ fontSize: 14, fontWeight: 700, color: C.text, margin: 0 }}>データ取得エラー</p>
        <p style={{ fontSize: 13, color: C.textMuted, margin: 0, textAlign: 'center', maxWidth: 420 }}>
          {loadError}
          <br />
          <span style={{ fontSize: 12 }}>
            データベースのマイグレーション（列追加SQL）がまだ実行されていない可能性があります。
          </span>
        </p>
        <button
          onClick={() => { setLoading(true); setLoadError(null); void load() }}
          style={{ padding: '8px 20px', borderRadius: 8, background: C.accent, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          再読み込み
        </button>
      </div>
    )
  }

  const isEmpty = items.length === 0
  const smry    = summary

  const estGross        = smry.estimate_revenue    - smry.estimate_cost_total
  const estRate         = smry.estimate_revenue    > 0 ? estGross        / smry.estimate_revenue    : 0
  const completionGross = smry.contract_amount     - smry.completion_cost_total
  const completionRate  = smry.contract_amount     > 0 ? completionGross / smry.contract_amount     : 0
  const actualGross     = smry.contract_amount     - smry.actual_cost_total
  const actualRate      = smry.contract_amount     > 0 ? actualGross     / smry.contract_amount     : 0

  const COL_COUNT = 12  // checkbox + name + vendor + est_cost + budget + completion + diff + actual + diff2 + note + inv + delete

  return (
    <div style={{ background: C.pageBg, minHeight: 400, paddingBottom: 80, display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
    <style>{`
      .genba-sum-float { position: fixed; right: 24px; bottom: 24px; z-index: 200; }
      @media (max-width: 1023px) {
        .genba-sum-float { right: 16px; bottom: calc(56px + env(safe-area-inset-bottom, 0px) + 8px); }
      }
    `}</style>

      {/* ── サマリーカード ── */}
      {!isEmpty && (
        <SummaryCards
          smry={smry}
          estGross={estGross} estRate={estRate}
          completionGross={completionGross} completionRate={completionRate}
          actualGross={actualGross} actualRate={actualRate}
          additionalAmounts={additionalAmounts}
          onEditAdditional={idx => setEditingAdditional({ idx, value: String(additionalAmounts[idx] ?? '') })}
        />
      )}

      {/* ── 追加金額インライン編集ダイアログ ── */}
      {editingAdditional && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setEditingAdditional(null) }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, minWidth: 280, boxShadow: '0 8px 40px rgba(0,0,0,0.18)', fontFamily: FONT }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>追加金額{editingAdditional.idx + 1}を編集</p>
            <input
              ref={billingEditRef}
              className="cl-edit-input"
              type="number"
              value={editingAdditional.value}
              onChange={e => setEditingAdditional(p => p ? { ...p, value: e.target.value } : p)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveAdditionalAmount(editingAdditional.idx, editingAdditional.value)
                if (e.key === 'Escape') setEditingAdditional(null)
              }}
              placeholder="金額（空欄でクリア）"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.accent}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <Button type="button" variant="secondary" onClick={() => setEditingAdditional(null)}>キャンセル</Button>
              <Button type="button" variant="primary" onClick={() => saveAdditionalAmount(editingAdditional.idx, editingAdditional.value)}>保存</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── 空状態 ── */}
      {isEmpty ? (
        <div style={st.emptyWrap}>
          <div style={st.emptyIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke={C.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9M3 15h6"/>
            </svg>
          </div>
          <p style={st.emptyTitle}>原価台帳が未作成です</p>
          <p style={st.emptyDesc}>
            見積エディタの原価（仕入単価）を元に自動生成できます。<br/>
            生成後、実行予算・実際原価を入力して粗利を管理します。
          </p>
          <button style={st.initBtn} onClick={handleInit} disabled={initializing}>
            {initializing ? '初期化中...' : '見積から初期化'}
          </button>
        </div>
      ) : (

        /* ── テーブルカード ── */
        <div style={st.tableCard}>

          {/* ── ツールバー ── */}
          <div style={st.toolbar}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={st.toolbarTitle}>原価台帳</span>
              <span style={st.badge}>{items.length}件</span>
              {viewMode === 'item' && checkedIds.length > 0 && (
                <span style={{ fontSize: 11, color: C.accent, fontWeight: 600 }}>
                  {checkedIds.length}件選択中
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* ビュー切替トグル */}
              <div style={st.toggleWrap}>
                <button
                  style={{ ...st.toggleBtn, ...(viewMode === 'item' ? st.toggleActive : {}) }}
                  onClick={() => { setViewMode('item'); setSumSelection(new Map) }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                    <line x1="8" y1="18" x2="21" y2="18"/>
                    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
                    <line x1="3" y1="18" x2="3.01" y2="18"/>
                  </svg>
                  明細
                </button>
                <button
                  style={{ ...st.toggleBtn, ...(viewMode === 'vendor' ? st.toggleActive : {}) }}
                  onClick={() => { setViewMode('vendor'); setSumSelection(new Map) }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                  </svg>
                  業者別
                </button>
              </div>
              {viewMode === 'item' && checkedIds.length > 0 && (
                <button style={st.accentBtn} onClick={handleCopyToEstimate}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
                  見積から引用
                </button>
              )}
              {viewMode === 'item' && (
                <button style={st.addBtn} onClick={addRow}>
                  <span style={{ fontSize: 15, lineHeight: 1 }}>＋</span>
                  行を追加
                </button>
              )}
              <button style={st.syncBtn} onClick={handleSync} disabled={syncing}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6"/>
                  <path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                </svg>
                {syncing ? '同期中...' : '見積と同期'}
              </button>
              <button
                style={{
                  ...st.syncBtn,
                  background: showImport ? '#2B5E40' : undefined,
                  color: showImport ? '#fff' : undefined,
                  borderColor: showImport ? '#2B5E40' : undefined,
                }}
                onClick={() => setShowImport(p => !p)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2 3-2V8z"/>
                  <line x1="8" y1="10" x2="16" y2="10"/>
                  <line x1="8" y1="14" x2="16" y2="14"/>
                </svg>
                業者請求書取り込み
              </button>
              <button
                onClick={() => setSumMode(v => !v)}
                style={{
                  fontSize: 11, padding: '2px 9px', height: 30, lineHeight: 1,
                  border: `1px solid ${sumMode ? C.accent : C.border}`, borderRadius: 7,
                  background: sumMode ? C.accent : C.bg,
                  cursor: 'pointer', color: sumMode ? '#fff' : C.textMuted,
                  fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 3,
                  flexShrink: 0, fontWeight: 600, userSelect: 'none', minHeight: 34,
                }}
                title={sumMode ? '合計モードを終了（もう一度押す）' : '合計モード：セルをクリックして金額を合計'}
              >
                ∑ 合計
              </button>
            </div>
          </div>

          {/* ── 業者請求書取り込みパネル（折りたたみ） ── */}
          {showImport && (
            <div style={{
              borderBottom: `1.5px solid #BDD1C3`,
              background: '#F6FAF7',
            }}>
              <VendorInvoiceImportTab projectId={projectId} />
            </div>
          )}

          {/* ── 業者別ビュー ── */}
          {viewMode === 'vendor' && (
            <VendorView
              groups={vendorGroups}
              expanded={expandedVendors}
              onToggle={(v) => setExpandedVendors(p => ({ ...p, [v]: !p[v] }))}
            />
          )}

          {/* ── 明細テーブル ── */}
          {viewMode === 'item' && <div style={{ overflowX: 'auto' }}>
            <table style={st.table}>
              <thead>
                {/* 段1：グループラベル行 */}
                <tr>
                  <th style={{ ...st.thGrp, width: 32, borderRight: HDIV }} rowSpan={2}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked }}
                      onChange={toggleAll}
                      style={{ cursor: 'pointer', accentColor: C.accent }}
                    />
                  </th>
                  <th style={{ ...st.thGrp, textAlign: 'left', minWidth: 180, borderRight: HDIV }} rowSpan={2}>名称</th>
                  <th style={{ ...st.thGrp, textAlign: 'left', minWidth: 100, borderRight: HDIV }} rowSpan={2}>業者名</th>
                  <th style={{ ...st.thGrp, textAlign: 'center', borderRight: HDIV }}>見積原価</th>
                  <th style={{ ...st.thGrp, textAlign: 'center', borderRight: HDIV }} colSpan={2}>実行予算</th>
                  <th style={{ ...st.thGrp, textAlign: 'center', borderRight: HDIV }}>完工実績</th>
                  <th style={{ ...st.thGrp, textAlign: 'center', borderRight: HDIV }} colSpan={2}>請求実績</th>
                  <th style={{ ...st.thGrp, textAlign: 'left', minWidth: 110, borderRight: HDIV }} rowSpan={2}>備考</th>
                  <th style={{ ...st.thGrp, width: 34, borderRight: HDIV }} rowSpan={2} title="分割請求の内訳">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2"/>
                      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                      <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                  </th>
                  <th style={{ ...st.thGrp, width: 36 }} rowSpan={2}></th>
                </tr>
                {/* 段2：リーフ列ヘッダー */}
                <tr>
                  <th style={{ ...st.th, ...st.thMuted, width: 110, borderRight: HDIV }}>金額</th>
                  <th style={{ ...st.th, width: 120, borderRight: `1px solid ${C.borderLight}` }}>予算</th>
                  <th style={{ ...st.th, width: 80, borderRight: HDIV }}>差額①</th>
                  <th style={{ ...st.th, width: 120, borderRight: HDIV }}>完工</th>
                  <th style={{ ...st.th, width: 130, borderRight: `1px solid ${C.borderLight}` }}>請求額</th>
                  <th style={{ ...st.th, width: 80, borderRight: HDIV }}>差額②</th>
                </tr>
              </thead>

              <tbody>
                {items.map((item, idx) => {
                  const rawDiff1 = item.budget_cost != null && item.estimate_cost != null
                    ? item.budget_cost - item.estimate_cost : null
                  const rawDiff2 = item.actual_cost != null && item.budget_cost != null
                    ? item.actual_cost - item.budget_cost : null
                  const bd = fmtDiff(rawDiff1)
                  const ad = fmtDiff(rawDiff2)
                  const isRow    = checked[item.id]
                  const rowBg    = isRow
                    ? C.selected
                    : idx % 2 === 0 ? C.bg : '#FAFCFA'
                  const isOpen   = expandedIds[item.id]
                  const invs     = invoicesMap[item.id] ?? []
                  const hasInvoices = invs.length > 0

                  return (
                    <React.Fragment key={item.id}>
                      <tr style={{ background: rowBg, transition: 'background 0.08s' }}
                        onMouseEnter={e => { if (!isRow) (e.currentTarget as HTMLElement).style.background = C.hover }}
                        onMouseLeave={e => { if (!isRow) (e.currentTarget as HTMLElement).style.background = rowBg }}>

                        {/* チェックボックス */}
                        <td style={{ ...st.td, textAlign: 'center', borderRight: HDIV }}>
                          <input
                            type="checkbox"
                            checked={!!checked[item.id]}
                            onChange={() => toggleOne(item.id)}
                            style={{ cursor: 'pointer', accentColor: C.accent }}
                          />
                        </td>

                        {/* 名称 */}
                        <td style={{ ...st.td, borderRight: HDIV }}>
                          {editing?.id === item.id && editing.field === 'name' ? (
                            <input ref={editRef} className="cl-edit-input" style={st.input}
                              value={editing.value}
                              onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                              onBlur={commitEdit}
                              onKeyDown={e => e.key === 'Enter' && commitEdit()}
                            />
                          ) : (
                            <div style={st.nameCell} onClick={() => startEdit(item, 'name')}>
                              <span style={{
                                ...st.dot,
                                background: item.source === 'from_estimate' ? C.accent : C.textMuted,
                              }} />
                              <span style={{ color: C.text, fontWeight: 500 }}>{item.name}</span>
                            </div>
                          )}
                        </td>

                        {/* 業者名 */}
                        <td style={{ ...st.td, borderRight: HDIV }}>
                          {editing?.id === item.id && editing.field === 'vendor_name' ? (
                            <input ref={editRef} className="cl-edit-input" style={st.input}
                              placeholder="業者名を入力"
                              value={editing.value}
                              onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                              onBlur={commitEdit}
                              onKeyDown={e => e.key === 'Enter' && commitEdit()}
                            />
                          ) : (
                            <div
                              style={{ ...st.editCell, justifyContent: 'flex-start' }}
                              onClick={() => startEdit(item, 'vendor_name')}
                            >
                              <span style={{ color: item.vendor_name ? C.textSub : C.textMuted, fontSize: 12 }}>
                                {item.vendor_name || '─'}
                              </span>
                            </div>
                          )}
                        </td>

                        {/* 見積原価（読み取り専用・クリックで合計選択） */}
                        {(() => {
                          const key = `${item.id}:ec`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{ ...st.td, ...st.tdNum,
                              color: isSel ? C.green : C.textMuted,
                              background: isSel ? C.accentLight : isRow ? 'transparent' : idx % 2 === 0 ? '#F3F7F4' : '#F0F6F2',
                              outline: isSel ? `2px solid ${C.accent}` : undefined,
                              outlineOffset: '-2px',
                              cursor: item.estimate_cost != null ? 'pointer' : undefined,
                              userSelect: 'none',
                              borderRight: HDIV }}
                              onClick={() => {
                                if (item.estimate_cost == null) return
                                setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, item.estimate_cost!); return n })
                              }}>
                              {fmtYen(item.estimate_cost)}
                            </td>
                          )
                        })()}

                        {/* 実行予算 */}
                        {(() => {
                          const key = `${item.id}:bc`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{ ...st.td, ...st.tdNum, borderRight: `1px solid ${C.borderLight}`,
                              outline: isSel ? `2px solid ${C.accent}` : undefined, outlineOffset: '-2px',
                              background: isSel ? C.accentLight : undefined,
                            }}>
                              {editing?.id === item.id && editing.field === 'budget_cost' ? (
                                <input ref={editRef} className="cl-edit-input" style={{ ...st.input, textAlign: 'right' }}
                                  value={editing.value}
                                  onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                                  onBlur={commitEdit}
                                  onKeyDown={e => e.key === 'Enter' && commitEdit()}
                                />
                              ) : (
                                <div style={{ ...st.editCell, cursor: (sumMode || undefined) && item.budget_cost != null ? 'pointer' : st.editCell.cursor }}
                                  onClick={() => {
                                    if ((sumMode) && item.budget_cost != null) {
                                      setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, item.budget_cost!); return n })
                                      return
                                    }
                                    startEdit(item, 'budget_cost')
                                  }}>
                                  <span style={{ color: item.budget_cost != null ? (isSel ? C.green : C.text) : C.textMuted }}>
                                    {fmtYen(item.budget_cost)}
                                  </span>
                                  {!sumMode && <span style={st.pen}>✎</span>}
                                </div>
                              )}
                            </td>
                          )
                        })()}

                        {/* 差額①（読み取り専用・クリックで合計選択） */}
                        {(() => {
                          const key = `${item.id}:d1`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{
                              ...st.td, ...st.tdNum,
                              color: bd.color, background: bd.bg,
                              fontSize: 12, fontWeight: 600,
                              outline: isSel ? `2px solid ${C.accent}` : undefined,
                              outlineOffset: '-2px',
                              cursor: rawDiff1 != null ? 'pointer' : undefined,
                              userSelect: 'none',
                              borderRight: HDIV,
                            }}
                              onClick={() => {
                                if (rawDiff1 == null) return
                                setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, rawDiff1); return n })
                              }}>
                              {bd.text}
                            </td>
                          )
                        })()}

                        {/* 完工実績 */}
                        {(() => {
                          const key = `${item.id}:cc`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV,
                              outline: isSel ? `2px solid ${C.accent}` : undefined, outlineOffset: '-2px',
                              background: isSel ? C.accentLight : undefined,
                            }}>
                              {editing?.id === item.id && editing.field === 'completion_cost' ? (
                                <input ref={editRef} className="cl-edit-input" style={{ ...st.input, textAlign: 'right' }}
                                  value={editing.value}
                                  onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                                  onBlur={commitEdit}
                                  onKeyDown={e => e.key === 'Enter' && commitEdit()}
                                />
                              ) : (
                                <div style={st.editCell}
                                  onClick={() => {
                                    if (sumMode && item.completion_cost != null) {
                                      setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, item.completion_cost!); return n })
                                      return
                                    }
                                    startEdit(item, 'completion_cost')
                                  }}>
                                  <span style={{ color: item.completion_cost != null ? (isSel ? C.green : C.text) : C.textMuted }}>
                                    {fmtYen(item.completion_cost)}
                                  </span>
                                  {!sumMode && <span style={st.pen}>✎</span>}
                                </div>
                              )}
                            </td>
                          )
                        })()}

                        {/* 請求実績 */}
                        {(() => {
                          const key = `${item.id}:ac`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{ ...st.td, ...st.tdNum, borderRight: `1px solid ${C.borderLight}`,
                              outline: isSel ? `2px solid ${C.accent}` : undefined, outlineOffset: '-2px',
                              background: isSel ? C.accentLight : undefined,
                            }}>
                              {hasInvoices ? (
                                <div style={{ ...st.editCell, gap: 6 }}>
                                  <span style={{ color: C.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                    {fmtYen(item.actual_cost)}
                                  </span>
                                  <span style={st.invBadge}>{invs.length}件</span>
                                </div>
                              ) : editing?.id === item.id && editing.field === 'actual_cost' ? (
                                <input ref={editRef} className="cl-edit-input" style={{ ...st.input, textAlign: 'right' }}
                                  value={editing.value}
                                  onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                                  onBlur={commitEdit}
                                  onKeyDown={e => e.key === 'Enter' && commitEdit()}
                                />
                              ) : (
                                <div style={st.editCell}
                                  onClick={() => {
                                    if (sumMode && item.actual_cost != null) {
                                      setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, item.actual_cost!); return n })
                                      return
                                    }
                                    startEdit(item, 'actual_cost')
                                  }}>
                                  <span style={{ color: item.actual_cost != null ? (isSel ? C.green : C.text) : C.textMuted }}>
                                    {fmtYen(item.actual_cost)}
                                  </span>
                                  {!sumMode && <span style={st.pen}>✎</span>}
                                </div>
                              )}
                            </td>
                          )
                        })()}

                        {/* 差額②（読み取り専用・クリックで合計選択） */}
                        {(() => {
                          const key = `${item.id}:d2`
                          const isSel = sumSelection.has(key)
                          return (
                            <td style={{
                              ...st.td, ...st.tdNum,
                              color: ad.color, background: ad.bg,
                              fontSize: 12, fontWeight: 600,
                              outline: isSel ? `2px solid ${C.accent}` : undefined,
                              outlineOffset: '-2px',
                              cursor: rawDiff2 != null ? 'pointer' : undefined,
                              userSelect: 'none',
                              borderRight: HDIV,
                            }}
                              onClick={() => {
                                if (rawDiff2 == null) return
                                setSumSelection(p => { const n = new Map(p); n.has(key) ? n.delete(key) : n.set(key, rawDiff2); return n })
                              }}>
                              {ad.text}
                            </td>
                          )
                        })()}

                        {/* 備考 */}
                        <td style={{ ...st.td, borderRight: HDIV }}>
                          {editing?.id === item.id && editing.field === 'note' ? (
                            <input ref={editRef} className="cl-edit-input" style={st.input}
                              value={editing.value}
                              onChange={e => setEditing(v => v ? { ...v, value: e.target.value } : v)}
                              onBlur={commitEdit}
                              onKeyDown={e => e.key === 'Enter' && commitEdit()}
                            />
                          ) : (
                            <div
                              style={{ ...st.editCell, justifyContent: 'flex-start', color: item.note ? C.textSub : C.textMuted, fontSize: 12 }}
                              onClick={() => startEdit(item, 'note')}
                            >
                              {item.note || '─'}
                            </div>
                          )}
                        </td>

                        {/* 内訳トグルボタン */}
                        <td style={{ ...st.td, textAlign: 'center', padding: 4, borderRight: HDIV }}>
                          <button
                            onClick={() => toggleInvoices(item.id)}
                            title={isOpen ? '内訳を閉じる' : '分割請求の内訳を開く'}
                            style={{
                              ...st.iconBtn,
                              background: isOpen ? C.accent : hasInvoices ? C.accentLight : 'transparent',
                              color:      isOpen ? '#fff'   : hasInvoices ? C.accent      : C.textMuted,
                              border:     `1px solid ${isOpen ? C.accent : hasInvoices ? C.border : 'transparent'}`,
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="4" width="18" height="18" rx="2"/>
                              <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                              <line x1="3" y1="10" x2="21" y2="10"/>
                            </svg>
                          </button>
                        </td>

                        {/* 削除 */}
                        <td style={{ ...st.td, textAlign: 'center', padding: 4 }}>
                          <button style={st.delBtn} onClick={() => deleteRow(item.id)} title="削除">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                              <path d="M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                            </svg>
                          </button>
                        </td>
                      </tr>

                      {/* ── 内訳展開パネル ── */}
                      {isOpen && (
                        <tr>
                          <td colSpan={COL_COUNT} style={{ padding: 0 }}>
                            {loadingInv[item.id] ? (
                              <div style={{ padding: '10px 40px', color: C.textMuted, fontSize: 12, fontFamily: FONT }}>
                                読み込み中...
                              </div>
                            ) : (
                              <InvoicePanel
                                itemId={item.id}
                                invoices={invs}
                                onInvoicesChange={newInvs =>
                                  setInvoices(p => ({ ...p, [item.id]: newInvs }))
                                }
                                onActualCostChange={newCost => {
                                  setItems(prev => prev.map(i =>
                                    i.id === item.id ? { ...i, actual_cost: newCost } : i
                                  ))
                                  setSummary(prev => {
                                    if (!prev) return prev
                                    const old  = items.find(i => i.id === item.id)?.actual_cost ?? 0
                                    const next = newCost ?? 0
                                    return {
                                      ...prev,
                                      actual_cost_total: prev.actual_cost_total - old + next,
                                      has_actual_data: true,
                                    }
                                  })
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>

              {/* 合計フッター */}
              <tfoot>
                <tr style={{ background: C.groupBg, borderTop: `2px solid ${C.border}` }}>
                  <td style={{ ...st.td, borderRight: HDIV }} />
                  <td style={{ ...st.td, fontWeight: 700, color: C.text, borderRight: HDIV }}>合計</td>
                  <td style={{ ...st.td, borderRight: HDIV }} />
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 600, color: C.textMuted,
                    background: '#ECF3EE', borderRight: HDIV }}>
                    {smry.estimate_cost_total > 0 ? fmtYen(smry.estimate_cost_total) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, color: C.text,
                    borderRight: `1px solid ${C.borderLight}` }}>
                    {smry.has_budget_data ? fmtYen(smry.budget_cost_total) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV }}>
                    {smry.has_budget_data && smry.estimate_cost_total > 0 ? (() => {
                      const d = fmtDiff(smry.budget_cost_total - smry.estimate_cost_total)
                      return <span style={{ color: d.color, fontWeight: 700 }}>{d.text}</span>
                    })() : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, color: C.text, borderRight: HDIV }}>
                    {smry.has_completion_data ? fmtYen(smry.completion_cost_total) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, color: C.text,
                    borderRight: `1px solid ${C.borderLight}` }}>
                    {smry.has_actual_data ? fmtYen(smry.actual_cost_total) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV }}>
                    {smry.has_actual_data && smry.budget_cost_total > 0 ? (() => {
                      const d = fmtDiff(smry.actual_cost_total - smry.budget_cost_total)
                      return <span style={{ color: d.color, fontWeight: 700 }}>{d.text}</span>
                    })() : '─'}
                  </td>
                  <td style={{ ...st.td, borderRight: HDIV }} colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>}
        </div>
      )}

      {/* ── 請求・入金情報（顧客向け）── */}
      {!isEmpty && (
        <div style={{ margin: '16px 16px 0', background: C.bg, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden', fontFamily: FONT }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>請求・入金情報（顧客・税込）</span>
            {billingLoading && <span style={{ fontSize: 11, color: C.textMuted }}>読み込み中...</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: C.groupBg }}>
                  {['項目', '請求日', '請求金額', '入金日', '入金金額', '手数料'].map(h => (
                    <th key={h} style={{ ...st.th, padding: '8px 12px', textAlign: h === '項目' ? 'left' : 'right', borderRight: HDIV, color: C.textMuted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {billingMilestones.map((m, i) => {
                  const editingThis = (field: string) => editingBilling?.id === m.id && editingBilling.field === field
                  const cellStyle: React.CSSProperties = { ...st.td, textAlign: 'right', borderRight: HDIV, fontVariantNumeric: 'tabular-nums', cursor: 'text' }
                  const cellInput: React.CSSProperties = { ...st.input, textAlign: 'right', width: '100%' }

                  function BillingCell({ field, isDate, isNum }: { field: string; isDate?: boolean; isNum?: boolean }) {
                    const val = m[field as keyof BillingMilestone]
                    const display = isNum
                      ? (val != null ? fmtYen(val as number) : '─')
                      : (val ? String(val).slice(0, 10) : '─')
                    if (editingThis(field)) {
                      return (
                        <td style={cellStyle}>
                          <input
                            ref={billingEditRef}
                            className="cl-edit-input"
                            type={isDate ? 'date' : 'number'}
                            defaultValue={val != null ? String(val).slice(0, 10) : ''}
                            style={cellInput}
                            onBlur={e => saveBillingCell(m.id, field, e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingBilling(null) }}
                          />
                        </td>
                      )
                    }
                    return (
                      <td style={cellStyle} onClick={() => setEditingBilling({ id: m.id, field, value: val != null ? String(val) : '' })}>
                        <span style={{ color: val != null ? C.text : C.textMuted }}>{display}</span>
                        <span style={{ ...st.pen, marginLeft: 4, opacity: 0.4 }}>✎</span>
                      </td>
                    )
                  }

                  return (
                    <tr key={m.id} style={{ background: i % 2 === 0 ? C.bg : '#FAFCFA', borderBottom: `1px solid ${C.borderLight}` }}>
                      <td style={{ ...st.td, fontWeight: 600, borderRight: HDIV }}>{m.type}</td>
                      <BillingCell field="invoice_date" isDate />
                      <BillingCell field="invoice_amount" isNum />
                      <BillingCell field="payment_date" isDate />
                      <BillingCell field="payment_amount" isNum />
                      <BillingCell field="fee" isNum />
                    </tr>
                  )
                })}
                {/* 合計行 */}
                {billingMilestones.length > 0 && (() => {
                  const totInv = billingMilestones.reduce((s, m) => s + (m.invoice_amount ?? 0), 0)
                  const totPay = billingMilestones.reduce((s, m) => s + (m.payment_amount ?? 0), 0)
                  const totFee = billingMilestones.reduce((s, m) => s + (m.fee ?? 0), 0)
                  return (
                    <tr style={{ background: C.groupBg, fontWeight: 700 }}>
                      <td style={{ ...st.td, borderRight: HDIV }}>合計</td>
                      <td style={{ ...st.td, borderRight: HDIV }}></td>
                      <td style={{ ...st.td, textAlign: 'right', borderRight: HDIV, fontVariantNumeric: 'tabular-nums' }}>{fmtYen(totInv)}</td>
                      <td style={{ ...st.td, borderRight: HDIV }}></td>
                      <td style={{ ...st.td, textAlign: 'right', borderRight: HDIV, fontVariantNumeric: 'tabular-nums' }}>{fmtYen(totPay)}</td>
                      <td style={{ ...st.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{totFee > 0 ? fmtYen(totFee) : '─'}</td>
                    </tr>
                  )
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 固定フッターサマリー ── */}
      {!isEmpty && (
        <div style={st.summaryBar}>
          <SummaryCell label="請負金額" value={fmtYen(smry.contract_amount)} />
          <div style={{ width: 1, height: 36, background: C.border }} />
          <SummaryCell
            label="完工粗利"
            value={smry.has_completion_data ? fmtYen(completionGross) : '─'}
            rate={smry.has_completion_data ? completionRate : null}
            positive={completionGross >= 0}
          />
          <div style={{ width: 1, height: 36, background: C.border }} />
          <SummaryCell label="見積金額" value={fmtYen(smry.estimate_revenue)} />
          <div style={{ width: 1, height: 36, background: C.border }} />
          <SummaryCell
            label="見積粗利"
            value={fmtYen(estGross)}
            rate={estRate}
            positive={estGross >= 0}
          />
        </div>
      )}

      {/* ── 合計フロートバー（position: fixed・右下） ── */}
      {createPortal(
        sumSelection.size > 0 ? (
          <div className="genba-sum-float" style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 14px',
            background: '#fff',
            border: `1.5px solid ${C.border}`,
            borderRadius: 10,
            boxShadow: '0 4px 20px rgba(43,94,64,0.18)',
            fontSize: 13, fontFamily: FONT,
            userSelect: 'none',
          }}>
            {sumMode && (
              <span style={{ fontSize: 10, color: C.accent, background: C.accentLight, borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>∑ ON</span>
            )}
            <span style={{ color: C.textMuted, fontSize: 12 }}>{sumSelection.size}セル選択</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums' }}>
              合計 {fmtYen(sumTotal)}
            </span>
            <button
              onClick={() => setSumSelection(new Map)}
              style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: '2px 6px', borderRadius: 4, fontSize: 13, lineHeight: '1' }}
              title="選択解除（Esc）"
            >✕</button>
          </div>
        ) : null,
        document.body
      )}
    </div>
  )
}

// ── 業者別ビュー ──────────────────────────────────────────
// Excelの原価台帳と同じロジック：
//   見積原価 = O列（見積内訳書から引いた原価合計）
//   実際原価 = AG列（業者へ実際に支払った合計）
//   差額     = AK列（O - AG）。プラス=赤字超過、マイナス=節約

function VendorView({
  groups, expanded, onToggle,
}: {
  groups: VendorGroup[]
  expanded: Record<string, boolean>
  onToggle: (vendor: string) => void
}) {
  const hasAny = groups.length > 0
  if (!hasAny) return null

  const totalEstimate = groups.reduce((s, g) => s + g.estimateCost, 0)
  const totalActual   = groups.reduce((s, g) => s + (g.actualCost ?? 0), 0)
  const hasActual     = groups.some(g => g.actualCost != null)
  const hasBudget     = groups.some(g => g.budgetCost != null)

  return (
    <div style={{ padding: '0 0 8px' }}>
      {/* 業者別照合の説明バナー */}
      <div style={vs.banner}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style={{ fontSize: 11, color: C.textSub, fontFamily: FONT }}>
          業者ごとに見積原価と実際の請求額を照合します。
          <strong style={{ color: C.red }}>＋（超過）</strong>は赤字リスク、
          <strong style={{ color: C.green }}>▲（節約）</strong>は予算内です。
        </span>
      </div>

      <table style={{ ...st.table, margin: 0 }}>
        <thead>
          <tr>
            <th style={{ ...st.thGrp, textAlign: 'left', minWidth: 160, width: 200, borderRight: HDIV }}>業者名</th>
            <th style={{ ...st.thGrp, textAlign: 'left', minWidth: 160, borderRight: HDIV }}>担当工種</th>
            <th style={{ ...st.thGrp, textAlign: 'right', width: 120, borderRight: HDIV }}>業者見積額</th>
            {hasBudget && (
              <th style={{ ...st.thGrp, textAlign: 'right', width: 120, borderRight: HDIV }}>実行予算</th>
            )}
            <th style={{ ...st.thGrp, textAlign: 'right', width: 120, borderRight: HDIV }}>業者請求額</th>
            <th style={{ ...st.thGrp, textAlign: 'right', width: 110, borderRight: HDIV }}>差額</th>
            <th style={{ ...st.thGrp, textAlign: 'right', width: 120, borderRight: HDIV, background: '#EAF3DE' }}>売上額</th>
            <th style={{ ...st.thGrp, textAlign: 'right', width: 110, borderRight: HDIV, background: '#EAF3DE' }}>粗利</th>
            <th style={{ ...st.thGrp, textAlign: 'right', width: 72, borderRight: HDIV, background: '#EAF3DE' }}>粗利率</th>
            <th style={{ ...st.thGrp, width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, idx) => {
            const isOpen  = expanded[g.vendor]
            const diff    = g.actualCost != null ? g.actualCost - g.estimateCost : null
            const isOver  = diff != null && diff > 0
            const isUnder = diff != null && diff < 0
            const diffStr = diff == null
              ? '─'
              : isOver
                ? '＋¥' + Math.abs(Math.round(diff)).toLocaleString('ja-JP')
                : '▲¥' + Math.abs(Math.round(diff)).toLocaleString('ja-JP')
            const diffColor = diff == null ? C.textMuted : isOver ? C.red : C.green
            const diffBg    = diff == null ? 'transparent' : isOver ? C.redBg : C.greenBg
            const rowBg     = idx % 2 === 0 ? C.bg : '#FAFCFA'
            const workTypes = g.items.map(i => i.name).filter(Boolean).slice(0, 5).join('・')
            const moreCount = g.items.length > 5 ? g.items.length - 5 : 0

            return (
              <React.Fragment key={g.vendor}>
                <tr
                  style={{ background: isOpen ? C.accentLight : rowBg, cursor: 'pointer', transition: 'background 0.08s' }}
                  onClick={() => onToggle(g.vendor)}
                  onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = C.hover }}
                  onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = rowBg }}
                >
                  {/* 業者名 */}
                  <td style={{ ...st.td, borderRight: HDIV }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        ...vs.vendorDot,
                        background: g.vendor === '（業者未設定）' ? C.textMuted : C.accent,
                      }} />
                      <span style={{ fontWeight: 600, color: g.vendor === '（業者未設定）' ? C.textMuted : C.text }}>
                        {g.vendor}
                      </span>
                      <span style={vs.countBadge}>{g.items.length}件</span>
                    </div>
                  </td>

                  {/* 担当工種 */}
                  <td style={{ ...st.td, borderRight: HDIV }}>
                    <span style={{ fontSize: 12, color: C.textSub }}>
                      {workTypes}
                      {moreCount > 0 && <span style={{ color: C.textMuted }}>…他{moreCount}件</span>}
                    </span>
                  </td>

                  {/* 見積原価 */}
                  <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV, background: '#F3F7F4' }}>
                    <span style={{ color: C.textSub }}>{fmtYen(g.estimateCost)}</span>
                  </td>

                  {/* 実行予算 */}
                  {hasBudget && (
                    <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV }}>
                      <span style={{ color: g.budgetCost != null ? C.text : C.textMuted }}>
                        {g.budgetCost != null ? fmtYen(g.budgetCost) : '─'}
                      </span>
                    </td>
                  )}

                  {/* 実際請求額 */}
                  <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV }}>
                    {g.actualCost != null ? (
                      <span style={{ fontWeight: 700, color: C.text }}>{fmtYen(g.actualCost)}</span>
                    ) : (
                      <span style={{ color: C.textMuted, fontSize: 11 }}>未入力</span>
                    )}
                  </td>

                  {/* 差額 = 実際 - 見積 */}
                  <td style={{ ...st.td, ...st.tdNum, background: diffBg, borderRight: HDIV }}>
                    <span style={{ fontWeight: 700, color: diffColor }}>{diffStr}</span>
                    {isOver && (
                      <span style={vs.alertLabel}>超過</span>
                    )}
                  </td>

                  {/* 売上額 */}
                  {(() => {
                    const selling = g.sellingAmount
                    const cost    = g.actualCost ?? g.estimateCost
                    const profit  = selling > 0 ? selling - cost : null
                    const rate    = selling > 0 ? (selling - cost) / selling : null
                    return (
                      <>
                        <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV, background: '#F0F6F2' }}>
                          <span style={{ color: selling > 0 ? C.textSub : C.textMuted }}>
                            {selling > 0 ? fmtYen(selling) : '─'}
                          </span>
                        </td>
                        <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV, background: '#F0F6F2' }}>
                          {profit != null ? (
                            <span style={{ fontWeight: 700, color: profit >= 0 ? C.green : C.red }}>
                              {fmtYen(profit)}
                            </span>
                          ) : <span style={{ color: C.textMuted }}>─</span>}
                        </td>
                        <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV, background: '#F0F6F2' }}>
                          {rate != null ? (
                            <span style={{
                              fontWeight: 700,
                              color: marginColor(rate),
                              background: marginBg(rate),
                              padding: '1px 6px', borderRadius: 4, fontSize: 12,
                            }}>
                              {(rate * 100).toFixed(1)}%
                            </span>
                          ) : <span style={{ color: C.textMuted }}>─</span>}
                        </td>
                      </>
                    )
                  })()}

                  {/* 展開矢印 */}
                  <td style={{ ...st.td, textAlign: 'center', padding: 4 }}>
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke={C.textMuted} strokeWidth="2" strokeLinecap="round"
                      style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                    >
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </td>
                </tr>

                {/* 展開行: この業者の明細一覧 */}
                {isOpen && (
                  <tr>
                    <td colSpan={hasBudget ? 10 : 9} style={{ padding: 0, background: C.accentLight }}>
                      <div style={vs.detailPanel}>
                        <div style={vs.detailHeader}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: '0.04em', fontFamily: FONT }}>
                            {g.vendor} の工種内訳
                          </span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: FONT }}>
                          <thead>
                            <tr style={{ background: '#E8F3EE' }}>
                              <th style={vs.dth}>工種名</th>
                              <th style={{ ...vs.dth, textAlign: 'right' }}>見積原価</th>
                              {hasBudget && <th style={{ ...vs.dth, textAlign: 'right' }}>実行予算</th>}
                              <th style={{ ...vs.dth, textAlign: 'right' }}>実際請求</th>
                              <th style={{ ...vs.dth, textAlign: 'right' }}>差額</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.items.map((item, ii) => {
                              const d = item.actual_cost != null && item.estimate_cost != null
                                ? item.actual_cost - item.estimate_cost
                                : null
                              const dStr = d == null ? '─'
                                : d > 0 ? '＋¥' + Math.abs(Math.round(d)).toLocaleString('ja-JP')
                                : '▲¥' + Math.abs(Math.round(d)).toLocaleString('ja-JP')
                              const dColor = d == null ? C.textMuted : d > 0 ? C.red : C.green
                              return (
                                <tr key={item.id} style={{ background: ii % 2 === 0 ? 'transparent' : '#EAF3DE' }}>
                                  <td style={vs.dtd}>{item.name}</td>
                                  <td style={{ ...vs.dtd, textAlign: 'right', color: C.textSub }}>{fmtYen(item.estimate_cost)}</td>
                                  {hasBudget && <td style={{ ...vs.dtd, textAlign: 'right' }}>{item.budget_cost != null ? fmtYen(item.budget_cost) : '─'}</td>}
                                  <td style={{ ...vs.dtd, textAlign: 'right', fontWeight: 600 }}>
                                    {item.actual_cost != null ? fmtYen(item.actual_cost) : <span style={{ color: C.textMuted }}>─</span>}
                                  </td>
                                  <td style={{ ...vs.dtd, textAlign: 'right', color: dColor, fontWeight: 600 }}>{dStr}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                          <tfoot>
                            <tr style={{ background: '#D5E8DC', borderTop: `1.5px solid ${C.accent}` }}>
                              <td style={{ ...vs.dtd, fontWeight: 700 }}>合計</td>
                              <td style={{ ...vs.dtd, textAlign: 'right', fontWeight: 700, color: C.textSub }}>{fmtYen(g.estimateCost)}</td>
                              {hasBudget && <td style={{ ...vs.dtd, textAlign: 'right', fontWeight: 700 }}>{g.budgetCost != null ? fmtYen(g.budgetCost) : '─'}</td>}
                              <td style={{ ...vs.dtd, textAlign: 'right', fontWeight: 700 }}>{g.actualCost != null ? fmtYen(g.actualCost) : '─'}</td>
                              <td style={{ ...vs.dtd, textAlign: 'right', fontWeight: 700, color: diffColor }}>{diffStr}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>

        {/* 全業者合計フッター */}
        <tfoot>
          <tr style={{ background: C.groupBg, borderTop: `2px solid ${C.border}` }}>
            <td style={{ ...st.td, fontWeight: 700, color: C.text, borderRight: HDIV }} colSpan={2}>
              全業者合計
            </td>
            <td style={{ ...st.td, ...st.tdNum, fontWeight: 600, color: C.textMuted, background: '#F0F2F5', borderRight: HDIV }}>
              {fmtYen(totalEstimate)}
            </td>
            {hasBudget && <td style={{ ...st.td, borderRight: HDIV }} />}
            <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, color: C.text, borderRight: HDIV }}>
              {hasActual ? fmtYen(totalActual) : '─'}
            </td>
            <td style={{ ...st.td, ...st.tdNum, borderRight: HDIV }}>
              {hasActual ? (() => {
                const d = fmtDiff(totalActual - totalEstimate)
                return <span style={{ color: d.color, fontWeight: 700 }}>{d.text}</span>
              })() : '─'}
            </td>
            {/* 売上合計・粗利合計・粗利率 */}
            {(() => {
              const totalSelling = groups.reduce((s, g) => s + g.sellingAmount, 0)
              const costForProfit = hasActual ? totalActual : totalEstimate
              const totalProfit  = totalSelling > 0 ? totalSelling - costForProfit : null
              const totalRate    = totalSelling > 0 ? (totalSelling - costForProfit) / totalSelling : null
              return (
                <>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 600, background: '#EAF3DE', borderRight: HDIV }}>
                    {totalSelling > 0 ? fmtYen(totalSelling) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, background: '#EAF3DE', borderRight: HDIV }}>
                    {totalProfit != null ? (
                      <span style={{ color: totalProfit >= 0 ? C.green : C.red }}>{fmtYen(totalProfit)}</span>
                    ) : '─'}
                  </td>
                  <td style={{ ...st.td, ...st.tdNum, fontWeight: 700, background: '#EAF3DE', borderRight: HDIV }}>
                    {totalRate != null ? (
                      <span style={{ color: marginColor(totalRate) }}>{(totalRate * 100).toFixed(1)}%</span>
                    ) : '─'}
                  </td>
                </>
              )
            })()}
            <td style={{ ...st.td }} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── 業者ビュースタイル ─────────────────────────────────────

const vs: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '8px 16px', background: C.accentLight,
    borderBottom: `1px solid ${C.border}`,
  },
  vendorDot: {
    display: 'inline-block', width: 8, height: 8,
    borderRadius: '50%', flexShrink: 0,
  },
  countBadge: {
    fontSize: 10, fontWeight: 600, color: C.accent,
    background: C.bg, padding: '1px 6px',
    borderRadius: 10, border: `1px solid ${C.border}`,
    fontFamily: FONT,
  },
  alertLabel: {
    display: 'inline-block', fontSize: 9, fontWeight: 700,
    color: '#fff', background: C.red,
    borderRadius: 3, padding: '1px 4px', marginLeft: 5,
    fontFamily: FONT,
  },
  detailPanel: {
    padding: '0 0 8px 32px',
    borderTop: `1px dashed ${C.accent}`,
  },
  detailHeader: {
    padding: '6px 10px 5px',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  dth: {
    padding: '4px 10px',
    fontWeight: 600, fontSize: 11,
    color: C.textMuted, borderBottom: `1px solid ${C.border}`,
    letterSpacing: '0.04em', fontFamily: FONT,
    textAlign: 'left' as const,
  },
  dtd: {
    padding: '4px 10px',
    fontSize: 12, color: C.text,
    borderBottom: `1px solid ${C.borderLight}`,
    fontFamily: FONT,
    verticalAlign: 'middle' as const,
  },
}

// ── フッターサマリーセル ──────────────────────────────────

function SummaryCell({ label, value, rate, positive }: {
  label: string; value: string
  rate?: number | null; positive?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontFamily: FONT }}>
      <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
        {label}
      </span>
      <span style={{
        fontSize: 15, fontWeight: 700,
        color: rate != null ? (positive ? C.green : C.red) : C.text,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
        {rate != null && (
          <span style={{ fontSize: 11, fontWeight: 600, marginLeft: 5, opacity: 0.85 }}>
            {(rate * 100).toFixed(1)}%
          </span>
        )}
      </span>
    </div>
  )
}

// ── サマリーカード（SnowUI スタイル）────────────────────────

function SummaryCards({
  smry, estGross, estRate,
  completionGross, completionRate,
  actualGross, actualRate,
  additionalAmounts, onEditAdditional,
}: {
  smry: Summary
  estGross: number; estRate: number
  completionGross: number; completionRate: number
  actualGross: number; actualRate: number
  additionalAmounts: [number|null, number|null, number|null]
  onEditAdditional: (idx: number) => void
}) {
  const totalAdditional = additionalAmounts.reduce<number>((s, v) => s + (v ?? 0), 0)

  return (
    <div style={{ padding: '16px 16px 0', fontFamily: FONT }}>

      {/* ── 受注金額ヘッダー ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: 12, padding: '10px 16px',
        background: C.bg, borderRadius: 12,
        border: `1px solid ${C.border}`,
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 120 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em' }}>受注金額（税抜）</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
            {fmtYen(smry.base_contract_amount)}
          </span>
        </div>
        <span style={{ color: C.textMuted, fontSize: 16, fontWeight: 300 }}>＋</span>
        {([0, 1, 2] as const).map(idx => (
          <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em' }}>追加金額{idx + 1}</span>
            <span
              style={{ fontSize: 14, fontWeight: 600, color: additionalAmounts[idx] != null ? C.text : C.textMuted,
                fontVariantNumeric: 'tabular-nums', cursor: 'pointer', borderBottom: `1px dashed ${C.border}` }}
              onClick={() => onEditAdditional(idx)}
              title="クリックで編集"
            >
              {additionalAmounts[idx] != null ? fmtYen(additionalAmounts[idx]) : '─'}
            </span>
          </div>
        ))}
        {totalAdditional > 0 && (
          <>
            <span style={{ color: C.textMuted, fontSize: 16, fontWeight: 300 }}>=</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em' }}>合計金額</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
                {fmtYen(smry.contract_amount)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── 粗利カード 3枚 ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>

        {/* カード①：予算粗利（青） */}
        <GrossCard
          label="予算粗利率"
          rate={estRate}
          gross={estGross}
          revenue={smry.estimate_revenue}
          costLabel="見積原価"
          costValue={smry.estimate_cost_total}
          variant="blue"
          noDataMsg={null}
        />

        {/* カード②：完工粗利（緑） */}
        <GrossCard
          label="完工粗利率"
          rate={completionRate}
          gross={completionGross}
          revenue={smry.contract_amount}
          costLabel="完工原価"
          costValue={smry.completion_cost_total}
          variant="green"
          noDataMsg="完工実績列を入力すると表示"
          hasData={smry.has_completion_data}
        />

        {/* カード③：請求粗利（白） */}
        <GrossCard
          label="請求粗利率"
          rate={actualRate}
          gross={actualGross}
          revenue={smry.contract_amount}
          costLabel="業者請求"
          costValue={smry.actual_cost_total}
          variant="light"
          noDataMsg="業者請求額を入力すると表示"
          hasData={smry.has_actual_data}
        />
      </div>
    </div>
  )
}

function GrossCard({ label, rate, gross, revenue, costLabel, costValue, variant, noDataMsg, hasData }: {
  label: string; rate: number; gross: number; revenue: number
  costLabel: string; costValue: number
  variant: 'blue' | 'green' | 'light'
  noDataMsg: string | null
  hasData?: boolean
}) {
  const show = noDataMsg === null || hasData
  const bg =
    variant === 'blue'  ? 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.4) 100%), #0A84FF' :
    variant === 'green' ? 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.4) 100%), #1E7045' :
    'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.4) 100%), linear-gradient(0deg, rgba(255,255,255,0.2), rgba(255,255,255,0.2)), #FFFFFF'
  const shadow =
    variant === 'blue'  ? '0 4px 20px rgba(10,132,255,0.22)' :
    variant === 'green' ? '0 4px 20px rgba(30,112,69,0.22)' :
    '0 2px 12px rgba(0,0,0,0.08)'
  const isDark = variant !== 'light'
  const rateColor = isDark ? '#fff' : (gross >= 0 ? C.green : C.red)
  const labelColor = isDark ? 'rgba(255,255,255,0.75)' : C.textMuted

  return (
    <div style={{
      flex: '1 1 220px', minWidth: 200,
      borderRadius: 20, background: bg,
      backgroundBlendMode: variant === 'light' ? 'normal, overlay, multiply' : undefined,
      border: variant === 'light' ? '1px solid rgba(0,0,0,0.06)' : undefined,
      padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8,
      boxShadow: shadow, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: labelColor, letterSpacing: '0.06em' }}>{label}</span>
        {show ? (
          <span style={{ fontSize: 20, fontWeight: 900, color: rateColor, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums' }}>
            {(rate * 100).toFixed(1)}%
          </span>
        ) : (
          <span style={{ fontSize: 11, color: isDark ? 'rgba(255,255,255,0.6)' : C.textMuted }}>{noDataMsg}</span>
        )}
      </div>
      {show && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <MetaItem label="売上" value={fmtYen(revenue)} light={isDark} />
          <MetaItem label={costLabel} value={fmtYen(costValue)} light={isDark} />
          <MetaItem label="粗利" value={fmtYen(gross)} light={isDark} bold />
        </div>
      )}
    </div>
  )
}

function MetaItem({ label, value, light, bold }: {
  label: string; value: string; light?: boolean; bold?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: light ? 'rgba(255,255,255,0.65)' : C.textMuted, fontWeight: 600 }}>
        {label}
      </span>
      <span style={{
        fontSize: 13, fontWeight: bold ? 800 : 500,
        color: light ? '#fff' : C.text,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  card: {
    background: C.bg, borderRadius: 10,
    border: `1px solid ${C.border}`, borderLeftWidth: 4,
    padding: '16px 16px 14px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  emptyWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 24px', gap: 12 },
  emptyIcon: {
    width: 72, height: 72, borderRadius: '50%',
    background: C.accentLight,
    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 16, fontWeight: 700, color: C.text, margin: 0, fontFamily: FONT },
  emptyDesc:  { fontSize: 13, color: C.textSub, textAlign: 'center', margin: 0, lineHeight: 1.8, fontFamily: FONT },
  initBtn: {
    marginTop: 8, padding: '12px 32px', borderRadius: 8,
    background: C.accent, color: '#FFFFFF',
    fontSize: 14, fontWeight: 700, border: 'none',
    cursor: 'pointer', minHeight: 44, fontFamily: FONT,
  },
  tableCard: {
    margin: '16px 16px 0', background: C.bg, borderRadius: 10,
    border: `1px solid ${C.border}`,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden',
  },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 16px', borderBottom: HDIV, background: C.bg,
  },
  toolbarTitle: { fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT },
  badge: {
    fontSize: 11, color: C.accent, background: C.accentLight,
    padding: '2px 8px', borderRadius: 20, fontFamily: FONT, fontWeight: 600,
  },
  toggleWrap: {
    display: 'flex', border: `1px solid ${C.border}`,
    borderRadius: 7, overflow: 'hidden',
  },
  toggleBtn: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '5px 12px',
    background: C.bg, color: C.textMuted,
    fontSize: 12, fontWeight: 600,
    border: 'none', cursor: 'pointer',
    fontFamily: FONT,
  },
  toggleActive: {
    background: C.accent, color: '#fff',
  },
  addBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 14px', borderRadius: 7,
    background: C.bg, color: C.textSub,
    fontSize: 13, fontWeight: 600,
    border: `1px solid ${C.border}`, cursor: 'pointer', minHeight: 34,
    fontFamily: FONT,
  },
  accentBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 14px', borderRadius: 7,
    background: C.accent, color: '#fff',
    fontSize: 13, fontWeight: 600,
    border: `1px solid ${C.accent}`, cursor: 'pointer', minHeight: 34,
    fontFamily: FONT,
  },
  syncBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 14px', borderRadius: 7,
    background: C.accentLight, color: C.accent,
    fontSize: 13, fontWeight: 600,
    border: '1px solid #A8D4B5', cursor: 'pointer', minHeight: 34,
    fontFamily: FONT,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  thGrp: {
    padding: '7px 10px', background: C.groupBg,
    color: C.textMuted, fontSize: 10, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    borderBottom: HDIV, textAlign: 'right', whiteSpace: 'nowrap',
    fontFamily: FONT,
  } as React.CSSProperties,
  th: {
    padding: '6px 10px', background: C.bg,
    color: C.textMuted, fontSize: 10, fontWeight: 600,
    letterSpacing: '0.04em',
    borderBottom: `2px solid ${C.border}`,
    textAlign: 'right', whiteSpace: 'nowrap',
    fontFamily: FONT,
  } as React.CSSProperties,
  thMuted: { color: C.textMuted, fontStyle: 'italic' } as React.CSSProperties,
  td: {
    padding: '7px 10px', borderBottom: HDIV,
    fontSize: 13, color: C.text, verticalAlign: 'middle',
    fontFamily: FONT,
  },
  tdNum: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as React.CSSProperties,
  nameCell: { display: 'flex', alignItems: 'center', gap: 7, cursor: 'text', minHeight: 26 },
  dot: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  editCell: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, cursor: 'text', minHeight: 26, borderRadius: 4 },
  pen: { fontSize: 10, color: C.border, flexShrink: 0 },
  input: {
    width: '100%', border: `1.5px solid ${C.accent}`, borderRadius: 6,
    padding: '3px 6px', fontSize: 13, outline: 'none',
    background: C.accentLight, color: C.text, minHeight: 28,
    boxSizing: 'border-box', fontFamily: FONT,
  } as React.CSSProperties,
  delBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: 6,
    border: 'none', background: 'transparent', color: C.border,
    cursor: 'pointer', padding: 0,
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 26, borderRadius: 5,
    cursor: 'pointer', padding: 0, transition: 'all 0.12s',
  },
  invBadge: {
    display: 'inline-block', padding: '1px 6px', borderRadius: 10,
    fontSize: 10, fontWeight: 700, background: C.accentLight, color: C.accent,
    fontFamily: FONT,
  },
  summaryBar: {
    position: 'sticky', bottom: 0,
    display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 24,
    padding: '10px 24px',
    background: C.bg, borderTop: `1px solid ${C.border}`,
    boxShadow: '0 -2px 8px rgba(0,0,0,0.04)',
    flexWrap: 'wrap', zIndex: 10,
  },
}
