'use client'

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import {
  DragDropContext, Droppable, Draggable,
  type DropResult, type DraggableProvidedDragHandleProps, type DragStart,
} from '@hello-pangea/dnd'
import { getClient } from '@/lib/supabase/client'
import { EstimateImportTab } from './EstimateImportTab'

// ── 型定義 ────────────────────────────────────────────────

type EstimateGroup = {
  id: string
  label: string
  display_mode: 'detailed' | 'lump_sum'
  sort_order: number
}

type RowType = 'item' | 'header' | 'note'

type EstimateItem = {
  id: string
  name: string
  category: string | null
  quantity: number
  unit: string
  selling_price: number | null
  amount: number | null
  retail_price: number | null
  cost_price: number | null
  vendor_name: string | null
  group_id: string | null
  sort_order: number
  source: string
  line_event_id: string | null
  memo: string | null
  row_type: RowType
}

type ItemPatch = {
  name?: string
  category?: string | null
  quantity?: number
  unit?: string
  selling_price?: number | null
  retail_price?: number | null
  cost_price?: number | null
  vendor_name?: string | null
  memo?: string | null
  row_type?: RowType
}

type RevisionHeader = {
  id: string
  rev_number: number
  label: string | null
  subtotal: number | null
  misc_expense: number | null
  rounding_discount: number | null
  tax_amount: number | null
  total: number | null
  created_at: string
}

type RevisionItemSnap = {
  id: string
  name: string
  category: string | null
  quantity: number
  unit: string
  selling_price: number | null
  cost_price: number | null
  group_id: string | null
  sort_order: number
  row_type: RowType
  memo: string | null
}

type RevisionFull = RevisionHeader & {
  snapshot: { items: RevisionItemSnap[]; groups: Array<{ id: string; label: string }> }
}

// ── デザイントークン ──────────────────────────────────────

const C = {
  pageBg:      '#F3F7F4',
  bg:          '#FFFFFF',
  groupBg:     '#F0F6F2',
  hover:       '#EDF5EF',
  divider:     '#DDE8E2',
  accent:      '#3D7A55',
  accentMid:   '#6CB382',
  accentTint:  '#A8D4B5',
  accentLight: '#EAF3DE',
  text:        '#1A2E24',
  textSub:     '#2D4A38',
  textMuted:   '#7A9185',
  green:       '#2B5E40',
  orange:      '#C4790A',
  red:         '#D12953',
  redBg:       '#FFF0F4',
  internalBg:  '#F8FAF9',
} as const

const _cmixOk =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('background', 'color-mix(in srgb, red, blue)')
const SUBTOTAL_CELL_BG      = _cmixOk ? `color-mix(in srgb, ${C.divider} 60%, ${C.groupBg})` : '#ECF0F5'
const SUBTOTAL_BORDER_COLOR = _cmixOk ? `color-mix(in srgb, ${C.divider} 80%, ${C.textMuted})` : '#D0D8E4'

const FONT      = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const ROW_H     = 52
const CELL_H    = 40
const HEAD_H    = 28
const GRP_H     = 34
const HDIV      = `1px solid ${C.divider}`
const MARGIN_WARN    = 0.15
const ROWS_PER_PAGE  = 19  // Excelテンプレートの ITEMS_PER_BLOCK に合わせた1ページあたり行数
const SUMMARY_TOP_H     = 52
const SUMMARY_DIVIDER_H = 1
const SUMMARY_ROW1_H    = 64   // 見積金額フロー行（小計〜消費税）
const SUMMARY_ROW2_H    = 60   // 原価・粗利行
const SUMMARY_BOTTOM_H  = SUMMARY_ROW1_H + 1 + SUMMARY_ROW2_H  // 合計高さ（区切り線含む）

// selling_price 変更の楽観的更新に対応するため、クライアント側で amount を再計算するヘルパー
function liveAmount(item: { quantity: number; selling_price: number | null; amount: number | null }): number {
  return item.selling_price != null ? Math.round(item.quantity * item.selling_price) : (item.amount ?? 0)
}

// ── カラム定義（react-table + CSS grid の共通ソース）────────

type ColMeta = { group: 'estimate' | 'internal' | null; align: 'left' | 'center' | 'right'; gridSize?: string }

const COL_DEFS: Array<{ id: string; label: string; size: number; meta: ColMeta }> = [
  { id: 'drag',          label: '',       size: 52,  meta: { group: null,       align: 'left'   } },
  { id: 'category',      label: '種別',   size: 100, meta: { group: null,       align: 'left'   } },
  { id: 'name',          label: '名称',   size: 180, meta: { group: null,       align: 'left',   gridSize: '180px' } },
  { id: 'quantity',      label: '数量',   size: 60,  meta: { group: null,       align: 'right'  } },
  { id: 'unit',          label: '単位',   size: 52,  meta: { group: null,       align: 'center' } },
  { id: 'selling_price', label: '単価',   size: 124, meta: { group: 'estimate', align: 'right'  } },
  { id: 'amount',        label: '金額',   size: 136, meta: { group: 'estimate', align: 'right'  } },
  { id: 'retail_price',  label: '定価',   size: 116, meta: { group: 'estimate', align: 'right'  } },
  { id: 'memo',          label: '備考',   size: 120, meta: { group: 'estimate', align: 'left',   gridSize: '120px' } },
  { id: 'vendor_name',   label: '業者名', size: 120, meta: { group: 'internal', align: 'left'  } },
  { id: 'cost_price',    label: '原価',   size: 116, meta: { group: 'internal', align: 'right'  } },
  { id: 'margin',        label: '粗利率', size: 64,  meta: { group: 'internal', align: 'right'  } },
  { id: 'actions',       label: '',       size: 68,  meta: { group: null,       align: 'center' } },
]

const GRID_COLS    = COL_DEFS.map(c => c.meta.gridSize ?? `${c.size}px`).join(' ')
const ESTIMATE_CNT = COL_DEFS.filter(c => c.meta.group === 'estimate').length  // 3
const INTERNAL_CNT = COL_DEFS.filter(c => c.meta.group === 'internal').length  // 3
// before estimate group: drag + name + quantity + unit = 4 cols
const PRE_EST_CNT  = COL_DEFS.findIndex(c => c.meta.group === 'estimate')      // 4

// 列幅リサイズ用コンテキスト（EstimateTab → 子コンポーネントへ動的 gridTemplateColumns を配信）
const GridColsCtx = createContext(GRID_COLS)

// ── ユーティリティ ────────────────────────────────────────

const fmt = (v: number) => v.toLocaleString('ja-JP')

function reorder<T>(list: T[], from: number, to: number): T[] {
  const r = [...list]
  const [x] = r.splice(from, 1)
  r.splice(to, 0, x)
  return r
}

// ── 小部品 ───────────────────────────────────────────────

function GripIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
      <circle cx="2.5" cy="3"  r="1.5" fill="#C8D1DC" />
      <circle cx="2.5" cy="7"  r="1.5" fill="#C8D1DC" />
      <circle cx="2.5" cy="11" r="1.5" fill="#C8D1DC" />
      <circle cx="7.5" cy="3"  r="1.5" fill="#C8D1DC" />
      <circle cx="7.5" cy="7"  r="1.5" fill="#C8D1DC" />
      <circle cx="7.5" cy="11" r="1.5" fill="#C8D1DC" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
      style={{ transition: 'transform 0.18s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>
      <path d="M4 2.5l4 3.5-4 3.5" stroke={C.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function DeleteBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      title="削除"
      style={{
        width: 28, height: 28, borderRadius: 6, border: 'none',
        background: hov ? C.redBg : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        color: hov ? C.red : C.textMuted,
        transition: 'all 0.12s', padding: 0, flexShrink: 0,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
      </svg>
    </button>
  )
}

// ── NumInput ──────────────────────────────────────────────

function NumInput({
  value, onChange, placeholder = '─', align = 'right', muted = false, fromPast = false,
}: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  align?: 'left' | 'right'
  muted?: boolean
  fromPast?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const ref = useRef<HTMLInputElement>(null)

  function start() {
    setDraft(value != null ? String(value) : '')
    setEditing(true)
    setTimeout(() => ref.current?.select(), 0)
  }
  function commit() {
    setEditing(false)
    const n = draft === '' ? null : parseFloat(draft)
    onChange(n != null && !isNaN(n) ? n : null)
  }

  if (editing) {
    return (
      <input
        ref={ref} autoFocus type="text" inputMode="numeric" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit() }
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        style={{
          width: '100%', height: CELL_H,
          border: `1.5px solid ${C.accent}`, borderRadius: 6,
          padding: '0 8px', fontSize: 13, textAlign: align,
          fontFamily: FONT, outline: 'none', background: '#FFF',
          color: C.text, fontVariantNumeric: 'tabular-nums',
          boxShadow: `0 0 0 3px ${C.accent}20`,
        }}
      />
    )
  }

  const isPast = fromPast && value != null
  return (
    <div onClick={start} style={{
      width: '100%', height: CELL_H,
      border: `1px solid ${isPast ? '#BFDBFE' : C.divider}`, borderRadius: 6,
      padding: '0 8px',
      display: 'flex', alignItems: 'center',
      justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      background: isPast ? '#EFF6FF' : '#FFF',
      fontSize: 13,
      color: value != null ? C.text : C.textMuted,
      fontWeight: value != null && !muted ? 500 : undefined,
      fontStyle: value == null ? 'italic' : undefined,
      opacity: value == null ? 0.55 : 1,
      cursor: 'text', fontVariantNumeric: 'tabular-nums',
      fontFamily: FONT,
      gap: 4,
    }}>
      {isPast && (
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.02em',
          color: '#3B82F6', opacity: 0.8,
          flexShrink: 0,
        }}>実績</span>
      )}
      {value != null ? fmt(value) : placeholder}
    </div>
  )
}

// ── UnitSelect ────────────────────────────────────────────

const UNIT_OPTIONS = ['式', '坪', '㎡', 'm', '本', '個', '枚', '台', '箇所', '回', '日', 'set']

function UnitSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} onClick={e => e.stopPropagation()}
      style={{
        width: '100%', height: CELL_H,
        border: `1px solid ${C.divider}`, borderRadius: 6,
        background: '#FFF',
        fontSize: 13, color: C.text, fontFamily: FONT,
        cursor: 'pointer', appearance: 'none', textAlign: 'center',
        outline: 'none', padding: '0 4px',
      }}>
      {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
      {!UNIT_OPTIONS.includes(value) && <option value={value}>{value}</option>}
    </select>
  )
}

// ── TextInput ─────────────────────────────────────────────

function TextInput({ value, onChange, placeholder = '─' }: {
  value: string | null; onChange: (v: string | null) => void; placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const ref = useRef<HTMLInputElement>(null)

  function start() { setDraft(value ?? ''); setEditing(true); setTimeout(() => ref.current?.select(), 0) }
  function commit() { setEditing(false); onChange(draft.trim() || null) }

  if (editing) {
    return (
      <input ref={ref} autoFocus type="text" value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit() }
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        style={{
          width: '100%', height: CELL_H,
          border: `1.5px solid ${C.accent}`, borderRadius: 6,
          padding: '0 8px', fontSize: 12, fontFamily: FONT,
          outline: 'none', background: '#FFF', color: C.text,
          boxShadow: `0 0 0 3px ${C.accent}20`,
        }}
      />
    )
  }

  return (
    <div onClick={start} style={{
      width: '100%', height: CELL_H,
      border: `1px solid ${C.divider}`, borderRadius: 6,
      padding: '0 8px',
      display: 'flex', alignItems: 'center',
      background: '#FFF',
      fontSize: 12, color: value != null ? C.text : C.textMuted,
      fontStyle: value == null ? 'italic' : undefined,
      opacity: value == null ? 0.55 : 1,
      cursor: 'text', fontFamily: FONT, overflow: 'hidden',
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value ?? placeholder}
      </span>
    </div>
  )
}

// ── PillAddBtn ────────────────────────────────────────────

function PillAddBtn({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 28, padding: '0 16px', borderRadius: 10,
        border: `1px solid ${hov ? C.accent : C.divider}`,
        background: hov ? C.accentLight : 'transparent',
        color: hov ? C.accent : C.textMuted,
        fontSize: 12, fontWeight: 600, fontFamily: FONT,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.12s',
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      {label}
    </button>
  )
}

// ── TopFormulaCell ────────────────────────────────────────
// サマリー上段の大きい数値（クリックで計算根拠表示）

function TopFormulaCell({
  label, value, valueColor, formula,
}: {
  label: string; value: string; valueColor: string; formula?: string[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref}
      style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: formula ? 'pointer' : 'default' }}
      onClick={() => formula && setOpen(p => !p)}
      title={formula ? 'クリックで計算根拠を表示' : undefined}
    >
      <span style={{ fontSize: 11, color: open ? C.accent : C.textMuted, fontFamily: FONT, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
        {label}
        {formula && (
          <span style={{
            marginLeft: 4, fontSize: 8, fontWeight: 700,
            color: open ? C.accent : '#AAAFB8',
            background: open ? C.accentLight : '#EEEEF2',
            padding: '0 3px', borderRadius: 3, verticalAlign: 'middle',
          }}>
            ＝
          </span>
        )}
      </span>
      <span style={{ fontSize: 26, fontWeight: 700, color: valueColor, fontFamily: FONT, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>
        {value}
      </span>
      {open && formula && <FormulaTooltip lines={formula} anchor={ref.current} />}
    </div>
  )
}

// ── FormulaTooltip ────────────────────────────────────────
// 計算根拠をポータルでレンダリング（overflow:clip 制約を回避）

function FormulaTooltip({
  lines, anchor,
}: { lines: string[]; anchor: HTMLElement | null }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const r = anchor.getBoundingClientRect()
      setPos({ top: r.bottom + 8, right: window.innerWidth - r.right })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchor])

  if (!anchor || !pos) return null

  return createPortal(
    <div style={{
      position: 'fixed', top: pos.top, right: pos.right,
      background: '#1A2B1F', color: '#ECF5EF',
      borderRadius: 8, padding: '10px 14px',
      fontSize: 11.5, fontFamily: FONT, lineHeight: 1.85,
      whiteSpace: 'nowrap', zIndex: 9999,
      boxShadow: '0 6px 24px rgba(0,0,0,0.28)',
      pointerEvents: 'none', minWidth: 180,
    }}>
      {lines.map((line, i) => (
        <div key={i} style={{
          fontWeight: line.startsWith('=') ? 700 : 400,
          fontSize: line.startsWith('─') ? 10 : 11.5,
          color: line.startsWith('─') ? '#6B8F7A' : line.startsWith('=') ? '#A8D4B5' : '#ECF5EF',
        }}>
          {line}
        </div>
      ))}
    </div>,
    document.body,
  )
}

// ── DetailCell ────────────────────────────────────────────
// サマリーバー下段の読み取り専用セル（formula を渡すとクリックで計算根拠表示）

function DetailCell({
  label, value, color, formula, small,
}: {
  label: string; value: string; color?: string
  formula?: string[]   // 渡すとクリックで計算根拠ポップオーバーを表示
  small?: boolean      // 参考値など補助的な情報に使う小さい表示
}) {
  const [open, setOpen] = useState(false)
  const cellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!cellRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const clickable = !!formula

  return (
    <div ref={cellRef}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        flex: 1, minWidth: small ? 90 : 110, padding: small ? '6px 12px' : '8px 16px', gap: 2,
        background: open ? '#EEF5F1' : C.bg,
        border: `1px solid ${open ? C.accent : C.divider}`,
        borderRadius: 8,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 0.12s, border-color 0.12s',
        userSelect: 'none',
        position: 'relative',
      }}
      onClick={() => clickable && setOpen(p => !p)}
      title={clickable ? 'クリックで計算根拠を表示' : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          fontSize: small ? 9 : 10, color: open ? C.accent : C.textMuted,
          fontFamily: FONT, whiteSpace: 'nowrap',
          letterSpacing: '0.04em', textTransform: 'uppercase' as const,
        }}>
          {label}
        </span>
        {clickable && (
          <span style={{
            fontSize: 8, fontWeight: 700,
            color: open ? C.accent : '#AAAFB8',
            background: open ? C.accentLight : '#EEEEF2',
            padding: '0 3px', borderRadius: 3, fontFamily: FONT, lineHeight: '14px',
          }}>
            ＝
          </span>
        )}
      </div>
      <span style={{
        fontSize: small ? 13 : 14, fontWeight: small ? 500 : 600,
        color: color ?? C.textSub, fontFamily: FONT,
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
      {open && formula && <FormulaTooltip lines={formula} anchor={cellRef.current} />}
    </div>
  )
}

// ── SummaryEditCell ───────────────────────────────────────
// サマリーバー下段の編集可能セル（諸経費・端数値引）。
// negative=true の場合は「▲¥xxx」表示で差し引きを明示する。

function SummaryEditCell({
  label, value, negative = false, highlight = false,
  onCommit, onReset, showReset = false,
}: {
  label: string
  value: number
  negative?: boolean
  highlight?: boolean
  onCommit: (v: number | null) => void
  onReset?: () => void
  showReset?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const ref = useRef<HTMLInputElement>(null)

  function start() {
    setDraft(String(value))
    setEditing(true)
    setTimeout(() => ref.current?.select(), 0)
  }
  function commit() {
    setEditing(false)
    const n = draft === '' ? 0 : parseFloat(draft)
    onCommit(isNaN(n) ? 0 : Math.round(Math.abs(n)))
  }

  const displayColor = negative && value > 0 ? C.red : highlight ? C.accent : C.textSub

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 1, minWidth: 120, padding: '8px 16px', gap: 2, background: C.bg, border: `1px solid ${C.divider}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 12, color: highlight ? C.accent : C.textMuted, fontFamily: FONT, whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {showReset && (
          <button onClick={e => { e.stopPropagation(); onReset?.() }}
            title="自動計算に戻す"
            style={{
              fontSize: 9, padding: '0 4px', borderRadius: 3,
              border: `1px solid ${C.accent}`, background: 'transparent',
              color: C.accent, cursor: 'pointer', lineHeight: '14px', fontFamily: FONT,
            }}>
            自動
          </button>
        )}
      </div>
      {editing ? (
        <input
          ref={ref} autoFocus type="text" inputMode="numeric" value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit() }
            if (e.key === 'Escape') setEditing(false)
          }}
          style={{
            width: 96, height: 22, textAlign: 'right',
            border: `1.5px solid ${C.accent}`, borderRadius: 4,
            padding: '0 6px', fontSize: 13,
            fontFamily: FONT, outline: 'none', background: C.bg,
            color: C.text, fontVariantNumeric: 'tabular-nums',
            boxShadow: `0 0 0 2px ${C.accent}20`,
          }}
        />
      ) : (
        <span
          onClick={start}
          title="クリックして編集"
          style={{
            fontSize: 15, fontWeight: 500, fontFamily: FONT, fontVariantNumeric: 'tabular-nums',
            color: displayColor, cursor: 'text', whiteSpace: 'nowrap',
            borderBottom: `1px dashed ${C.divider}`,
          }}
        >
          {negative && value > 0 ? `▲¥${fmt(value)}` : `¥${fmt(value)}`}
        </span>
      )}
    </div>
  )
}

// ── Badge ─────────────────────────────────────────────────

function Badge({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 7px', borderRadius: 10,
      fontSize: 10, fontWeight: 700, fontFamily: FONT,
      background: bg, color, letterSpacing: '0.03em',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {children}
    </span>
  )
}

// ── GroupHeader ───────────────────────────────────────────

function GroupHeader({
  group, groupIndex, expanded, onToggle, onLabelChange,
  onDisplayModeToggle, onDelete, onDeleteEmpty, dragHandleProps, hovered, subtotal, isNew,
  groupCheckState, onGroupSelect,
}: {
  group: EstimateGroup; groupIndex: number; expanded: boolean
  onToggle: () => void; onLabelChange: (l: string) => void
  onDisplayModeToggle: () => void; onDelete: () => void; onDeleteEmpty: () => void
  dragHandleProps: DraggableProvidedDragHandleProps | null
  hovered: boolean; subtotal: number; isNew?: boolean
  groupCheckState?: 'none' | 'partial' | 'all'
  onGroupSelect?: () => void
}) {
  const gridCols = useContext(GridColsCtx)
  const [editingLabel, setEditingLabel] = useState(isNew ?? false)
  const [labelDraft,   setLabelDraft]   = useState(group.label)
  const checkboxRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = groupCheckState === 'partial'
  }, [groupCheckState])

  function commitLabel() {
    setEditingLabel(false)
    const trimmed = labelDraft.trim()
    if (!trimmed && isNew) { onDeleteEmpty(); return }
    if (trimmed !== group.label) onLabelChange(trimmed)
  }

  const showCheck = hovered || groupCheckState === 'partial' || groupCheckState === 'all'

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: gridCols,
      alignItems: 'center', height: GRP_H,
      borderTop: '2px solid #D0D5DE',
      borderBottom: `1px solid ${C.divider}`,
      background: 'transparent',
    }}>
      {/* ドラッグ＋チェックボックス */}
      <div style={st.dragCell}>
        <div style={{
          width: 24, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, opacity: showCheck ? 1 : 0, transition: 'opacity 0.15s',
        }}>
          {onGroupSelect && (
            <input
              ref={checkboxRef}
              type="checkbox"
              checked={groupCheckState === 'all'}
              onChange={onGroupSelect}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              style={{ width: 12, height: 12, cursor: 'pointer', accentColor: C.accent }}
            />
          )}
        </div>
        <div {...(dragHandleProps ?? {})} style={{
          width: 28, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'grab', flexShrink: 0, opacity: hovered ? 0.5 : 0, transition: 'opacity 0.15s',
        }}>
          <GripIcon />
        </div>
      </div>

      {/* 展開ボタン + 番号 + グループ名（category列から直接開始） */}
      <div style={{ gridColumn: '2 / 7', display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 4, paddingRight: 8, overflow: 'hidden' }}>
        <button onClick={onToggle} style={{ ...st.expandBtn, width: 18, height: 18 }}>
          <ChevronIcon open={expanded} />
        </button>
        <span style={{
          fontSize: 10, fontWeight: 600, color: '#ABABAB',
          letterSpacing: '0.06em', flexShrink: 0,
          fontVariantNumeric: 'tabular-nums', fontFamily: FONT,
        }}>
          {String(groupIndex + 1).padStart(2, '0')}
        </span>
        {editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={e => {
              if (e.key === 'Enter') commitLabel()
              if (e.key === 'Escape') { setLabelDraft(group.label); setEditingLabel(false) }
              e.stopPropagation()
            }}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              flex: 1, border: `1.5px solid ${C.accent}`, borderRadius: 4,
              padding: '1px 6px', fontSize: 12, fontWeight: 600,
              fontFamily: FONT, outline: 'none', background: C.bg, color: C.text,
              boxShadow: `0 0 0 3px ${C.accent}20`,
            }}
          />
        ) : (
          <span
            onClick={() => { setLabelDraft(group.label); setEditingLabel(true) }}
            title="クリックして編集"
            style={{
              flex: 1, fontSize: 12, fontWeight: 600, color: '#555',
              fontFamily: FONT, cursor: 'text',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {group.label || '（工種名を入力）'}
          </span>
        )}
      </div>

      {/* amount: 折りたたみ時に小計表示（col 7 に固定） */}
      <div style={{ gridColumn: '7', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8 }}>
        {!expanded && subtotal > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
            ¥{fmt(subtotal)}
          </span>
        )}
      </div>

      {/* 操作（col 13・ホバー時のみ） */}
      <div style={{ gridColumn: '13', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4, gap: 3, flexShrink: 0, flexWrap: 'nowrap', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
        <button onClick={onDisplayModeToggle}
          title={group.display_mode === 'detailed' ? '一括表示に切替' : '明細表示に切替'}
          style={{
            height: 18, padding: '0 5px', borderRadius: 3, border: 'none',
            fontSize: 9, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            background: group.display_mode === 'lump_sum' ? C.accent : `${C.accent}15`,
            color: group.display_mode === 'lump_sum' ? '#fff' : C.accent,
          }}>
          {group.display_mode === 'lump_sum' ? '一括' : '明細'}
        </button>
        <DeleteBtn onClick={onDelete} />
      </div>
    </div>
  )
}

// ── GroupSubtotal ─────────────────────────────────────────

function GroupSubtotal({ total, itemCount, costTotal }: { total: number; itemCount: number; costTotal: number }) {
  const gridCols = useContext(GridColsCtx)
  const margin = total > 0 && costTotal > 0 ? 1 - costTotal / total : null
  return (
    // suppressHydrationWarning: SUBTOTAL_CELL_BG / SUBTOTAL_BORDER_COLOR は
    // SSR（CSS未定義）とクライアント（color-mix対応ブラウザ）で値が異なる場合があるため抑制
    <div suppressHydrationWarning style={{
      display: 'grid', gridTemplateColumns: gridCols,
      alignItems: 'center', height: 30,
      background: '#F0F1F3',
      borderTop: `1px solid ${C.divider}`,
    }}>
      <div />
      {/* category 列：空白 */}
      <div />
      <div style={{ paddingLeft: 52, fontSize: 10, fontWeight: 700, color: '#999', fontFamily: FONT, letterSpacing: '0.08em' }}>
        小　計
      </div>
      <div /><div /><div />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 16, fontWeight: 700, fontSize: 14, color: C.text, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
        ¥{fmt(total)}
      </div>
      <div />
      {/* memo */}
      <div />
      {/* vendor_name */}
      <div />
      {/* 原価合計 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8,
        fontSize: 12, fontWeight: 600, color: C.textSub, fontVariantNumeric: 'tabular-nums', fontFamily: FONT,
      }}>
        {costTotal > 0 ? `¥${fmt(costTotal)}` : ''}
      </div>
      {/* 粗利率 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10,
      }}>
        {margin != null && (
          <span style={{
            padding: '2px 8px', borderRadius: 12,
            fontSize: 11, fontWeight: 700, fontFamily: FONT,
            background: margin < 0.15 ? '#FEF2F2' : '#EBEBEC',
            color: margin < 0.15 ? C.red : '#555',
          }}>
            {(margin * 100).toFixed(1)}%
          </span>
        )}
      </div>
      <div />
    </div>
  )
}

// ── PageBreakRow ──────────────────────────────────────────

function PageBreakRow({ pageNum, pageTotal, pageCostTotal }: { pageNum: number; pageTotal: number; pageCostTotal: number }) {
  const gridCols = useContext(GridColsCtx)
  const margin = pageTotal > 0 && pageCostTotal > 0 ? 1 - pageCostTotal / pageTotal : null
  return (
    <div suppressHydrationWarning style={{
      display: 'grid', gridTemplateColumns: gridCols,
      alignItems: 'center', height: 30,
      background: '#EEF2F8',
      borderTop: `2px dashed #94A3B8`,
      borderBottom: `1px solid #CBD5E1`,
    }}>
      <div />
      <div />
      <div style={{ paddingLeft: 52, fontSize: 10, fontWeight: 700, color: '#475569', fontFamily: FONT, letterSpacing: '0.08em' }}>
        P.{pageNum} 小計
      </div>
      <div /><div /><div />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 16, fontWeight: 700, fontSize: 14, color: '#334155', fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
        ¥{fmt(pageTotal)}
      </div>
      <div />
      <div />
      <div />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, fontSize: 12, fontWeight: 600, color: C.textSub, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
        {pageCostTotal > 0 ? `¥${fmt(pageCostTotal)}` : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10 }}>
        {margin != null && (
          <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, fontFamily: FONT, background: margin < 0.15 ? '#FEF2F2' : '#E2E8F0', color: margin < 0.15 ? C.red : '#475569' }}>
            {(margin * 100).toFixed(1)}%
          </span>
        )}
      </div>
      <div />
    </div>
  )
}

// ── FIELD_ORDER（Tab キーナビ用）──────────────────────────

const FIELD_ORDER = ['category', 'name', 'quantity', 'unit', 'selling_price', 'retail_price', 'memo', 'vendor_name', 'cost_price'] as const

// ── ItemRow ───────────────────────────────────────────────

function ItemRow({
  item, inGroup, isDragging, dragHandleProps,
  onSave, onDelete, deleting, rowIndex, onAddAfter,
  selected, onToggleSelect, anySelected,
  indent, onIndent, onUnindent,
  isGhost,
}: {
  item: EstimateItem; inGroup: boolean; isDragging: boolean
  dragHandleProps: DraggableProvidedDragHandleProps | null
  onSave: (c: ItemPatch) => Promise<void>; onDelete: () => void
  deleting: boolean; rowIndex: number; onAddAfter?: () => void
  selected?: boolean; onToggleSelect?: (shift: boolean) => void; anySelected?: boolean
  indent?: number; onIndent?: () => void; onUnindent?: () => void
  isGhost?: boolean
}) {
  const gridCols = useContext(GridColsCtx)
  const [editField, setEditField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editRect,  setEditRect]  = useState<DOMRect | null>(null)
  const [hovered,   setHovered]   = useState(false)
  const nameRef    = useRef<HTMLInputElement>(null)
  const portalRef  = useRef<HTMLInputElement>(null)

  const rowType = item.row_type ?? 'item'

  const rowBg = isDragging ? C.accentLight
    : isGhost        ? `${C.accentLight}99`
    : rowType === 'header' ? (hovered ? '#D8EDE1' : '#E5F2EA')
    : rowType === 'note'   ? (hovered ? '#F5F0D8' : '#FEFAED')
    : selected       ? `${C.accent}10`
    : hovered        ? C.hover
    : C.bg

  function startEdit(field: string, raw: string) {
    setEditField(field); setEditValue(raw)
    if (field === 'name') setTimeout(() => nameRef.current?.select(), 0)
  }

  async function commitEdit(field: string) {
    setEditField(null)
    setEditRect(null)
    const changes: ItemPatch = {}
    if (field === 'name') {
      const v = editValue.trim()
      if (v && v !== item.name) changes.name = v
    } else if (field === 'category') {
      const v = editValue.trim() || null
      if (v !== (item.category ?? null)) changes.category = v
    } else if (field === 'memo') {
      const v = editValue.trim() || null
      if (v !== (item.memo ?? null)) changes.memo = v
    } else if (field === 'vendor_name') {
      const v = editValue.trim() || null
      if (v !== (item.vendor_name ?? null)) changes.vendor_name = v
    }
    if (Object.keys(changes).length > 0) await onSave(changes)
  }

  function handleKey(e: React.KeyboardEvent, field: string) {
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation()
      const idx  = FIELD_ORDER.indexOf(field as typeof FIELD_ORDER[number])
      const next = e.shiftKey ? FIELD_ORDER[idx - 1] : FIELD_ORDER[idx + 1]
      commitEdit(field).then(() => {
        if (next) {
          const map: Record<string, string> = {
            category: item.category ?? '', name: item.name, quantity: String(item.quantity), unit: item.unit,
            selling_price: item.selling_price != null ? String(item.selling_price) : '',
            retail_price: item.retail_price != null ? String(item.retail_price) : '',
            memo: item.memo ?? '', vendor_name: item.vendor_name ?? '',
            cost_price: item.cost_price != null ? String(item.cost_price) : '',
          }
          setEditField(next); setEditValue(map[next] ?? '')
        }
      })
      return
    }
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); commitEdit(field); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditField(null); setEditRect(null); return }
    e.stopPropagation()
  }

  const liveAmt = item.selling_price != null
    ? Math.round(item.quantity * item.selling_price)
    : item.amount

  const margin = item.cost_price != null && item.selling_price != null && item.selling_price > 0
    ? 1 - item.cost_price / item.selling_price
    : null
  const warnMargin = margin != null && margin < MARGIN_WARN

  return (
    <>
    <div
      data-row-id={item.id}
      data-group-id={item.group_id ?? '__none__'}
      style={{
        position: 'relative',
        background: rowBg,
        padding: (rowType === 'header' || rowType === 'note') ? '0' : '6px 0',
        borderBottom: `1px solid #EEF0F5`,
        borderLeft: rowType === 'header' ? `3px solid ${C.accentMid}`
          : rowType === 'note' ? `3px solid #C9A84C`
          : isGhost ? `3px solid ${C.accentTint}` : undefined,
        opacity: isGhost ? 0.55 : 1,
        boxShadow: isDragging ? `0 2px 14px rgba(22,114,236,0.13)` : undefined,
        zIndex: isDragging ? 2 : undefined,
        transition: 'background 0.1s, opacity 0.1s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
    <div
      style={{
        display: 'grid', gridTemplateColumns: gridCols,
        alignItems: 'center', height: (rowType === 'header' || rowType === 'note') ? GRP_H : CELL_H,
      }}
    >
      {/* チェックボックス（左24px）＋ ドラッググリップ（右28px） */}
      <div style={st.dragCell}>
        {/* チェックボックス領域 */}
        <div style={{
          width: 24, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          opacity: hovered || selected || anySelected ? 1 : 0,
          transition: 'opacity 0.15s',
        }}>
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={() => {}}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onToggleSelect(e.shiftKey) }}
              style={{ width: 14, height: 14, cursor: 'pointer', accentColor: C.accent }}
            />
          )}
        </div>
        {/* グリップ領域 */}
        <div {...(dragHandleProps ?? {})} style={{
          width: 28, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'grab', flexShrink: 0,
          opacity: hovered || selected || anySelected ? 1 : 0,
          transition: 'opacity 0.15s',
        }}>
          <GripIcon />
        </div>
      </div>

      {/* ── header / note 行（金額セルなし・全幅テキスト）── */}
      {(rowType === 'header' || rowType === 'note') && (() => {
        const isHeader = rowType === 'header'
        const placeholder = isHeader ? '見出しテキストを入力...' : 'メモを入力...'
        const textColor   = isHeader ? C.green : '#7A5A00'
        const inputBg     = isHeader ? '#D8EDE1' : '#F5F0D8'
        return (
          <>
            {/* cols 2–12: 全幅テキスト入力（種別〜粗利率列含む） */}
            <div style={{
              gridColumn: '2 / 13',
              display: 'flex', alignItems: 'center',
              paddingLeft: inGroup ? 20 : 4, paddingRight: 8, height: '100%', overflow: 'hidden',
            }}>
              {/* アイコン */}
              <div style={{ flexShrink: 0, marginRight: 6, opacity: 0.55 }}>
                {isHeader ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={textColor} strokeWidth="2.5" strokeLinecap="round">
                    <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/>
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={textColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                )}
              </div>
              <div style={{
                flex: 1, height: GRP_H - 6,
                border: editField === 'name' ? `1.5px solid ${C.accent}` : `1px solid ${C.divider}`,
                borderRadius: 6,
                display: 'flex', alignItems: 'center',
                background: editField === 'name' ? '#FFF' : inputBg,
                boxShadow: editField === 'name' ? `0 0 0 3px ${C.accent}20` : undefined,
              }}>
                {editField === 'name' ? (
                  <input ref={nameRef} autoFocus value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => commitEdit('name')}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitEdit('name') }
                      e.stopPropagation()
                    }}
                    placeholder={placeholder}
                    style={{
                      flex: 1, border: 'none', background: 'transparent',
                      padding: '0 10px', fontSize: isHeader ? 13 : 12,
                      fontWeight: isHeader ? 700 : 400,
                      fontStyle: isHeader ? undefined : 'italic',
                      fontFamily: FONT, outline: 'none', color: textColor,
                    }}
                  />
                ) : (
                  <span
                    onDoubleClick={() => startEdit('name', item.name)}
                    title="ダブルクリックで編集"
                    style={{
                      flex: 1, padding: '0 10px',
                      fontSize: isHeader ? 13 : 12,
                      fontWeight: isHeader ? 700 : 400,
                      fontStyle: isHeader ? undefined : 'italic',
                      color: item.name ? textColor : `${textColor}66`,
                      cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', fontFamily: FONT,
                    }}
                  >
                    {item.name || placeholder}
                  </span>
                )}
              </div>
            </div>
            {/* col 13: 削除のみ */}
            <div style={{ gridColumn: '13', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
              <DeleteBtn onClick={onDelete} disabled={deleting} />
            </div>
          </>
        )
      })()}

      {/* ── 通常の item 行 ── */}
      {rowType === 'item' && <>

      {/* 種別 */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 4, paddingRight: 4, height: '100%' }}>
        <div style={{
          flex: 1, height: CELL_H, overflow: 'hidden',
          border: editField === 'category' ? `1.5px solid ${C.accent}` : `1px solid ${C.divider}`,
          borderRadius: 6, display: 'flex', alignItems: 'center',
          background: '#FFF',
          boxShadow: editField === 'category' ? `0 0 0 3px ${C.accent}20` : undefined,
        }}>
          {editField === 'category' && !editRect ? (
            <input autoFocus value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={() => commitEdit('category')}
              onKeyDown={e => handleKey(e, 'category')}
              style={{
                flex: 1, border: 'none', background: 'transparent',
                padding: '0 8px', fontSize: 12, fontFamily: FONT, outline: 'none', color: C.text,
              }}
            />
          ) : (
            <span
              onClick={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).closest('div')!.getBoundingClientRect()
                setEditRect(rect); setEditField('category'); setEditValue(item.category ?? '')
                setTimeout(() => portalRef.current?.select(), 0)
              }}
              title={item.category ?? undefined}
              style={{
                flex: 1, padding: '0 8px', fontSize: 12, color: item.category ? C.textSub : C.textMuted,
                fontStyle: item.category ? undefined : 'italic', opacity: item.category ? 1 : 0.5,
                cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT,
              }}>
              {item.category ?? '─'}
            </span>
          )}
        </div>
      </div>

      {/* 名称 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        paddingLeft: (inGroup ? 24 : 4) + (indent ?? 0) * 20, paddingRight: 4, height: '100%', overflow: 'hidden',
      }}>
        {(inGroup || (indent ?? 0) > 0) && (
          <svg width="8" height="10" viewBox="0 0 8 10" fill="none" style={{ flexShrink: 0 }}>
            <path d="M1 0v5a2 2 0 002 2h5" stroke={(indent ?? 0) > 0 ? C.accentTint : C.divider} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        )}
        <div style={{
          flex: 1, height: CELL_H, overflow: 'hidden',
          border: editField === 'name' ? `1.5px solid ${C.accent}` : `1px solid ${C.divider}`,
          borderRadius: 6,
          display: 'flex', alignItems: 'center',
          background: '#FFF',
          boxShadow: editField === 'name' ? `0 0 0 3px ${C.accent}20` : undefined,
        }}>
          {editField === 'name' && !editRect ? (
            <input ref={nameRef} autoFocus value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={() => commitEdit('name')}
              onKeyDown={e => handleKey(e, 'name')}
              style={{
                flex: 1, border: 'none', background: 'transparent',
                padding: '0 8px', fontSize: 13, fontWeight: 500,
                fontFamily: FONT, outline: 'none', color: C.text,
              }}
            />
          ) : (
            <span
              onClick={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).closest('div')!.getBoundingClientRect()
                setEditRect(rect); setEditField('name'); setEditValue(item.name)
                setTimeout(() => portalRef.current?.select(), 0)
              }}
              title={item.name ?? undefined}
              style={{ flex: 1, padding: '0 8px', fontSize: 13, fontWeight: 500, color: C.text, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
              {item.name}
            </span>
          )}
        </div>
      </div>

      {/* 数量 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <NumInput value={item.quantity} onChange={v => { if (v !== null && v !== item.quantity) onSave({ quantity: v }) }} />
      </div>

      {/* 単位 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <UnitSelect value={item.unit} onChange={v => { if (v !== item.unit) onSave({ unit: v }) }} />
      </div>

      {/* 単価 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <NumInput value={item.selling_price}
          onChange={v => { if (v !== item.selling_price) onSave({ selling_price: v }) }}
          placeholder="未設定"
          fromPast={item.source === 'past_item' && item.selling_price != null} />
      </div>

      {/* 金額（読み取り専用） */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 4, paddingRight: 4, height: '100%' }}>
        <div style={{
          flex: 1, height: CELL_H,
          border: `1px solid ${C.divider}`, borderRadius: 6,
          padding: '0 10px',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          background: liveAmt != null ? '#F0FDF8' : '#FFF',
          fontSize: 13, fontWeight: liveAmt != null ? 600 : undefined,
          color: liveAmt != null ? C.green : C.textMuted,
          fontStyle: liveAmt == null ? 'italic' : undefined,
          opacity: liveAmt == null ? 0.55 : 1,
          fontVariantNumeric: 'tabular-nums', fontFamily: FONT,
        }}>
          {liveAmt != null ? `¥${fmt(liveAmt)}` : '─'}
        </div>
      </div>

      {/* 定価 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <NumInput value={item.retail_price}
          onChange={v => { if (v !== item.retail_price) onSave({ retail_price: v }) }}
          placeholder="─" muted />
      </div>

      {/* 備考 */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 4, paddingRight: 4, height: '100%', overflow: 'hidden' }}>
        <div style={{
          flex: 1, height: CELL_H, overflow: 'hidden',
          border: editField === 'memo' ? `1.5px solid ${C.accent}` : `1px solid ${C.divider}`,
          borderRadius: 6, display: 'flex', alignItems: 'center',
          background: '#FFF',
          boxShadow: editField === 'memo' ? `0 0 0 3px ${C.accent}20` : undefined,
        }}>
          {editField === 'memo' && !editRect ? (
            <input autoFocus value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={() => commitEdit('memo')}
              onKeyDown={e => handleKey(e, 'memo')}
              style={{ flex: 1, border: 'none', background: 'transparent', padding: '0 8px', fontSize: 12, fontFamily: FONT, outline: 'none', color: C.text }}
            />
          ) : (
            <span
              onClick={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).closest('div')!.getBoundingClientRect()
                setEditRect(rect); setEditField('memo'); setEditValue(item.memo ?? '')
                setTimeout(() => portalRef.current?.select(), 0)
              }}
              title={item.memo ?? undefined}
              style={{ flex: 1, padding: '0 8px', fontSize: 12, color: item.memo ? C.text : C.textMuted, fontStyle: item.memo ? undefined : 'italic', opacity: item.memo ? 1 : 0.55, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
              {item.memo || '─'}
            </span>
          )}
        </div>
      </div>

      {/* 業者名（内部専用） */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 4, paddingRight: 4, height: '100%', overflow: 'hidden' }}>
        <div style={{
          flex: 1, height: CELL_H, overflow: 'hidden',
          border: editField === 'vendor_name' ? `1.5px solid ${C.accent}` : `1px solid ${C.divider}`,
          borderRadius: 6, display: 'flex', alignItems: 'center',
          background: '#FFF',
          boxShadow: editField === 'vendor_name' ? `0 0 0 3px ${C.accent}20` : undefined,
        }}>
          {editField === 'vendor_name' && !editRect ? (
            <input autoFocus value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={() => commitEdit('vendor_name')}
              onKeyDown={e => handleKey(e, 'vendor_name')}
              style={{ flex: 1, border: 'none', background: 'transparent', padding: '0 8px', fontSize: 12, fontFamily: FONT, outline: 'none', color: C.text }}
            />
          ) : (
            <span
              onClick={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).closest('div')!.getBoundingClientRect()
                setEditRect(rect); setEditField('vendor_name'); setEditValue(item.vendor_name ?? '')
                setTimeout(() => portalRef.current?.select(), 0)
              }}
              title={item.vendor_name ?? undefined}
              style={{ flex: 1, padding: '0 8px', fontSize: 12, color: item.vendor_name ? C.textSub : C.textMuted, fontStyle: item.vendor_name ? undefined : 'italic', opacity: item.vendor_name ? 1 : 0.55, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
              {item.vendor_name || '─'}
            </span>
          )}
        </div>
      </div>

      {/* 原価（内部専用） */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', justifyContent: 'flex-end', paddingRight: 4 }}>
        <NumInput value={item.cost_price}
          onChange={v => { if (v !== item.cost_price) onSave({ cost_price: v }) }}
          placeholder="─" muted />
      </div>

      {/* 粗利率（内部専用） */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        height: '100%', paddingRight: 8,
      }}>
        {margin != null ? (
          <span style={{
            padding: '3px 6px', borderRadius: 20,
            fontSize: 11, fontWeight: 700, fontFamily: FONT,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            background: warnMargin ? '#FEF2F2' : '#F0FDF4',
            color: warnMargin ? C.red : C.green,
          }}>
            {(margin * 100).toFixed(1)}%
          </span>
        ) : (
          <span style={{ fontSize: 12, color: C.textMuted, opacity: 0.45, fontFamily: FONT }}>─</span>
        )}
      </div>

      {/* 削除 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
        <DeleteBtn onClick={onDelete} disabled={deleting} />
      </div>

      </>}{/* /item */}
    </div>

    {/* 行追加ピル（ホバー時のみ行の下辺に表示） */}
    {onAddAfter && (
      <button
        onClick={e => { e.stopPropagation(); onAddAfter() }}
        title="この行の下に追加"
        style={{
          position: 'absolute',
          bottom: 1,
          left: inGroup ? 44 : 12,
          height: 18,
          padding: '0 8px',
          borderRadius: 10,
          border: 'none',
          background: C.accent,
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          fontFamily: FONT,
          cursor: 'pointer',
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? 'auto' : 'none',
          transition: 'opacity 0.12s',
          letterSpacing: '0.02em',
          boxShadow: '0 1px 4px rgba(22,114,236,0.40)',
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        追加
      </button>
    )}
  </div>
    {editRect && editField && createPortal(
      <input
        ref={portalRef}
        autoFocus
        value={editValue}
        onChange={e => setEditValue(e.target.value)}
        onBlur={() => commitEdit(editField)}
        onKeyDown={e => handleKey(e, editField)}
        style={{
          position: 'fixed',
          top: editRect.top,
          left: editRect.left,
          width: Math.max(editRect.width, 280),
          height: editRect.height,
          zIndex: 9999,
          border: `1.5px solid ${C.accent}`,
          borderRadius: 6,
          padding: '0 8px',
          fontSize: editField === 'name' ? 13 : 12,
          fontWeight: editField === 'name' ? 500 : undefined,
          fontFamily: FONT,
          outline: 'none',
          background: '#FFF',
          color: C.text,
          boxShadow: `0 2px 12px rgba(22,114,236,0.18), 0 0 0 3px ${C.accent}20`,
        }}
      />,
      document.body
    )}
    </>
  )
}

// ── RevDiffModal ──────────────────────────────────────────

type DiffRow = {
  id: string
  name: string
  quantity: number
  unit: string
  selling_price: number | null
  sellingPriceCurrent: number | null
  status: 'added' | 'removed' | 'changed' | 'same'
}

function RevDiffModal({ rev, currentItems, fmt, onClose, fontFamily }: {
  rev: RevisionFull
  currentItems: EstimateItem[]
  fmt: (v: number) => string
  onClose: () => void
  fontFamily: string
}) {
  const snapItems = rev.snapshot?.items ?? []

  const snapMap = new Map(snapItems.map(i => [i.id, i]))
  const currentMap = new Map(currentItems.map(i => [i.id, i]))

  const rows: DiffRow[] = []

  // items in snapshot
  for (const s of snapItems) {
    if (s.row_type !== 'item') continue
    const cur = currentMap.get(s.id)
    if (!cur) {
      rows.push({ id: s.id, name: s.name, quantity: s.quantity, unit: s.unit, selling_price: s.selling_price, sellingPriceCurrent: null, status: 'removed' })
    } else {
      const priceDiff = (s.selling_price ?? 0) !== (cur.selling_price ?? 0)
      const qtyDiff = s.quantity !== cur.quantity
      rows.push({
        id: s.id, name: cur.name, quantity: cur.quantity, unit: cur.unit,
        selling_price: s.selling_price, sellingPriceCurrent: cur.selling_price,
        status: (priceDiff || qtyDiff) ? 'changed' : 'same',
      })
    }
  }
  // items added after snapshot
  for (const cur of currentItems) {
    if (cur.row_type !== 'item') continue
    if (!snapMap.has(cur.id)) {
      rows.push({ id: cur.id, name: cur.name, quantity: cur.quantity, unit: cur.unit, selling_price: null, sellingPriceCurrent: cur.selling_price, status: 'added' })
    }
  }

  const statusColor = { added: '#166534', removed: '#991B1B', changed: '#92400E', same: C.text }
  const statusBg    = { added: '#DCFCE7', removed: '#FEE2E2', changed: '#FEF3C7', same: 'transparent' }
  const statusLabel = { added: '追加', removed: '削除', changed: '変更', same: '' }

  const hasChanges = rows.some(r => r.status !== 'same')

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.22)', fontFamily }}>
        {/* ヘッダー */}
        <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${C.divider}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#3B1B80' }}>
              Rev.{rev.rev_number}{rev.label ? ` — ${rev.label}` : ''}　差分確認
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
              {new Date(rev.created_at).toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 保存
              {rev.total != null && ` ／ 合計 ¥${fmt(rev.total)}`}
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.textMuted, fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        {/* 差分サマリー */}
        {!hasChanges ? (
          <div style={{ padding: '24px', textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
            Rev.{rev.rev_number} から変更はありません
          </div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily }}>
              <thead>
                <tr style={{ background: C.groupBg, position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: C.textMuted, borderBottom: `1px solid ${C.divider}`, width: 56 }}>変更</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: C.textMuted, borderBottom: `1px solid ${C.divider}` }}>名称</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: C.textMuted, borderBottom: `1px solid ${C.divider}`, width: 80 }}>数量</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: C.textMuted, borderBottom: `1px solid ${C.divider}`, width: 110 }}>Rev単価</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: C.textMuted, borderBottom: `1px solid ${C.divider}`, width: 110 }}>現在単価</th>
                </tr>
              </thead>
              <tbody>
                {rows.filter(r => r.status !== 'same').map(r => (
                  <tr key={r.id} style={{ background: statusBg[r.status] }}>
                    <td style={{ padding: '8px 12px', color: statusColor[r.status], fontWeight: 700, borderBottom: `1px solid ${C.divider}` }}>
                      {statusLabel[r.status]}
                    </td>
                    <td style={{ padding: '8px 12px', color: statusColor[r.status], borderBottom: `1px solid ${C.divider}` }}>{r.name}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: C.textSub, borderBottom: `1px solid ${C.divider}`, fontVariantNumeric: 'tabular-nums' }}>
                      {r.quantity} {r.unit}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: C.textSub, borderBottom: `1px solid ${C.divider}`, fontVariantNumeric: 'tabular-nums' }}>
                      {r.selling_price != null ? `¥${fmt(r.selling_price)}` : '─'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: r.status === 'changed' ? statusColor.changed : statusColor[r.status], fontWeight: r.status === 'changed' ? 700 : 400, borderBottom: `1px solid ${C.divider}`, fontVariantNumeric: 'tabular-nums' }}>
                      {r.sellingPriceCurrent != null ? `¥${fmt(r.sellingPriceCurrent)}` : '─'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 合計比較 */}
            {rev.total != null && (
              <div style={{ padding: '14px 24px', borderTop: `1px solid ${C.divider}`, display: 'flex', gap: 32, background: C.groupBg }}>
                <div>
                  <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>Rev.{rev.rev_number} 合計</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#5B21B6', fontVariantNumeric: 'tabular-nums' }}>¥{fmt(rev.total)}</div>
                </div>
                <div style={{ fontSize: 18, color: C.textMuted, alignSelf: 'center' }}>→</div>
                <div>
                  <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>現在 合計</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums' }}>
                    ¥{fmt(currentItems.reduce((acc, i) => acc + (i.selling_price != null ? Math.round(i.quantity * i.selling_price) : (i.amount ?? 0)), 0))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── EstimateTab ───────────────────────────────────────────

export function EstimateTab({ projectId }: { projectId: string }) {
  const supabase = useRef(getClient()).current

  const [groups,      setGroups]      = useState<EstimateGroup[]>([])
  const [items,       setItems]       = useState<EstimateItem[]>([])
  const [collapsed,   setCollapsed]   = useState<Record<string, boolean>>({})
  const [loading,     setLoading]     = useState(true)
  const [creating,    setCreating]    = useState(false)
  const [addingRow,   setAddingRow]   = useState(false)
  const [deleting,    setDeleting]    = useState<Record<string, boolean>>({})
  // 手動で単価を上書き済みのアイテムID（このセットに含まれる行は原価変更でも単価を自動更新しない）
  const [manualSelling, setManualSelling] = useState<Set<string>>(new Set())
  // 諸経費・端数値引（projects テーブルに保存）
  const [miscExpenseOverride, setMiscExpenseOverride] = useState<number | null>(null)
  const [roundingDiscount,    setRoundingDiscount]    = useState<number>(0)
  // グループホバー管理（操作ボタン・行追加ボタンの表示制御）
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)
  // 新規作成直後でラベル未確定のグループID（名称なしでフォーカスを外すと自動削除）
  const [newlyCreatedGroupId, setNewlyCreatedGroupId] = useState<string | null>(null)
  // 複数選択
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Shift+クリック範囲選択用：最後にクリックした行のID
  const lastClickedIdRef = useRef<string | null>(null)
  // ドラッグ作成中のゴースト位置
  const [dragCreate, setDragCreate] = useState<{
    rowType: RowType; x: number; y: number
    indicator: { y: number; groupId: string | null; insertAfterItem: EstimateItem | null } | null
  } | null>(null)
  // マルチドラッグ中のドラッグ元アイテムID
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // renderClone は常に安定した参照を渡す（state 変化で差し替えると DnD がドラッグをキャンセルする）
  const draggingIdRef    = useRef<string | null>(null)
  const selectedIdsRef   = useRef<Set<string>>(selectedIds)
  const itemsRef         = useRef<typeof items>(items)
  // レンダー毎に ref を最新 state に同期（副作用なし）
  selectedIdsRef.current = selectedIds
  itemsRef.current       = items
  const importDragScrollRafRef = useRef<number | null>(null)
  // @hello-pangea/dnd ドラッグ中の自動スクロール用
  const dndMouseYRef        = useRef(0)
  const dndDragActiveRef    = useRef(false)
  const dndAutoScrollRafRef = useRef<number | null>(null)
  // インデント（中項目化）: UI上のみ、DBには未保存
  const [localIndent, setLocalIndent] = useState<Record<string, number>>({})
  // Rev管理
  const [revisions,     setRevisions]     = useState<RevisionHeader[]>([])
  const [showRevHistory, setShowRevHistory] = useState(false)
  const [savingRev,     setSavingRev]     = useState(false)
  const [revDiff,       setRevDiff]       = useState<RevisionFull | null>(null)
  const [showRevConfirm, setShowRevConfirm] = useState(false)
  const [revLabel,      setRevLabel]      = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [activeGroupTab, setActiveGroupTab] = useState<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  const [importDragTarget, setImportDragTarget] = useState<{ afterItemId: string | null; groupId: string } | null>(null)
  const [dragHoverTabId, setDragHoverTabId] = useState<string | 'all' | null>(null)
  const dragTabTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showSummaryDetail, setShowSummaryDetail] = useState(false)
  const [showSummaryBar, setShowSummaryBar] = useState(true)

  // activeGroupTab のグループが削除されたらリセット
  useEffect(() => {
    if (activeGroupTab && !groups.some(g => g.id === activeGroupTab)) {
      setActiveGroupTab(null)
    }
  }, [groups, activeGroupTab])

  // ── react-table（カラム定義・ヘッダー生成） ────────────────

  const columns = useMemo<ColumnDef<EstimateItem, unknown>[]>(() =>
    COL_DEFS.map(c => ({ id: c.id, header: c.label, size: c.size })),
  [])

  const table = useReactTable({
    data:            [] as EstimateItem[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const [leafHeaderGroup] = table.getHeaderGroups()

  // ── データ読み込み ─────────────────────────────────────────

  // 初回ロード済みフラグ：2回目以降の reload では setLoading(true) を呼ばず
  // EstimateImportTab などの子コンポーネントがアンマウントされないようにする
  const hasLoadedRef = useRef(false)

  const reload = useCallback(() => {
    if (!hasLoadedRef.current) setLoading(true)
    Promise.all([
      supabase.from('estimate_groups').select('id,label,display_mode,sort_order')
        .eq('project_id', projectId).is('deleted_at', null).order('sort_order'),
      supabase.from('estimate_items')
        .select('id,name,category,quantity,unit,selling_price,amount,retail_price,cost_price,vendor_name,group_id,sort_order,source,line_event_id,memo,row_type')
        .eq('project_id', projectId).is('deleted_at', null).order('sort_order'),
      supabase.from('projects')
        .select('misc_expense_override,rounding_discount')
        .eq('id', projectId).single(),
    ]).then(([{ data: g, error: gErr }, { data: i, error: iErr }, { data: p }]) => {
      if (iErr) {
        // クエリ失敗時はデータを消さず、コンソールにエラーを出す
        console.error('[EstimateTab] items query failed:', iErr.message)
        hasLoadedRef.current = true
        setLoading(false)
        return
      }
      if (gErr) console.error('[EstimateTab] groups query failed:', gErr.message)
      setGroups((g ?? []) as EstimateGroup[])
      setItems((i ?? []) as EstimateItem[])
      if (p) {
        setMiscExpenseOverride((p as { misc_expense_override: number | null }).misc_expense_override ?? null)
        setRoundingDiscount((p as { rounding_discount: number | null }).rounding_discount ?? 0)
      }
      hasLoadedRef.current = true
      setLoading(false)
    })
  }, [projectId, supabase]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ target_table: string }>).detail
      if (detail?.target_table === 'estimate_items') reload()
    }
    window.addEventListener('genba:data-changed', handler)
    return () => window.removeEventListener('genba:data-changed', handler)
  }, [reload])

  const loadRevisions = useCallback(async () => {
    const res = await fetch(`/api/estimate-revisions?project_id=${projectId}`)
    if (res.ok) setRevisions(await res.json())
  }, [projectId])

  useEffect(() => { loadRevisions() }, [loadRevisions])

  async function handleCreateRevision() {
    if (items.length === 0) return
    setSavingRev(true)
    try {
      const res = await fetch('/api/estimate-revisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          label: revLabel.trim() || null,
          subtotal,
          misc_expense: miscExpense,
          rounding_discount: roundingDiscount,
          tax_amount: tax,
          total,
        }),
      })
      if (res.ok) {
        const rev = await res.json() as RevisionHeader
        setRevisions(prev => [rev, ...prev])
        setShowRevConfirm(false)
        setRevLabel('')
        setShowRevHistory(true)
      }
    } finally {
      setSavingRev(false)
    }
  }

  async function handleViewRevDiff(rev: RevisionHeader) {
    const res = await fetch(`/api/estimate-revisions/${rev.id}`)
    if (res.ok) setRevDiff(await res.json() as RevisionFull)
  }

  // ── @hello-pangea/dnd ドラッグ中の自動スクロール ─────────────────────
  // マウス Y 座標を常時追跡（passive: cost ゼロ）
  useEffect(() => {
    const onMove = (e: MouseEvent) => { dndMouseYRef.current = e.clientY }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  const startDndAutoScroll = useCallback(() => {
    dndDragActiveRef.current = true
    const ZONE      = 80   // エッジからこの px 以内でスクロール開始
    const MAX_SPEED = 18   // 最大 px/frame

    const tick = () => {
      if (!dndDragActiveRef.current) return
      const container = document.getElementById('estimate-table-scroll')
      if (container) {
        const rect    = container.getBoundingClientRect()
        const y       = dndMouseYRef.current
        const topDist = y - rect.top
        const botDist = rect.bottom - y
        let speed = 0
        if (topDist > 0 && topDist < ZONE)
          speed = -MAX_SPEED * Math.pow(1 - topDist / ZONE, 2)
        else if (botDist > 0 && botDist < ZONE)
          speed = MAX_SPEED * Math.pow(1 - botDist / ZONE, 2)
        if (speed !== 0) container.scrollTop += speed
      }
      dndAutoScrollRafRef.current = requestAnimationFrame(tick)
    }
    dndAutoScrollRafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopDndAutoScroll = useCallback(() => {
    dndDragActiveRef.current = false
    if (dndAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(dndAutoScrollRafRef.current)
      dndAutoScrollRafRef.current = null
    }
  }, [])

  // ── HTML5ドラッグ（取込パネル→見積）中の自動スクロール ────────────────
  useEffect(() => {
    const ZONE = 100
    const MAX_SPEED = 16
    let rafId: number | null = null
    let latestY = 0
    let isDraggingImport = false

    function scheduleScroll() {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(function loop() {
        if (!isDraggingImport) return
        const container = document.getElementById('dashboard-main')
        if (!container) return
        const rect    = container.getBoundingClientRect()
        const topDist = latestY - rect.top
        const botDist = rect.bottom - latestY
        let speed = 0
        if (topDist > 0 && topDist < ZONE) speed = -MAX_SPEED * Math.pow(1 - topDist / ZONE, 2)
        else if (botDist > 0 && botDist < ZONE) speed = MAX_SPEED * Math.pow(1 - botDist / ZONE, 2)
        if (speed !== 0) container.scrollTop += speed
        rafId = requestAnimationFrame(loop)
      })
    }

    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('application/genba-import-item')) return
      latestY = e.clientY
      if (!isDraggingImport) { isDraggingImport = true; scheduleScroll() }
    }
    function onDragEnd() {
      isDraggingImport = false
      if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragend',  onDragEnd)
    window.addEventListener('drop',     onDragEnd)
    importDragScrollRafRef.current = null
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragend',  onDragEnd)
      window.removeEventListener('drop',     onDragEnd)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // ── ドラッグ＆プレース行作成 ──────────────────────────────

  function startDragCreate(e: React.MouseEvent, rowType: RowType) {
    e.preventDefault()
    const capturedItems = items

    function findTarget(cx: number, cy: number) {
      const els = document.elementsFromPoint(cx, cy) as HTMLElement[]
      for (const el of els) {
        const rowEl = el.closest('[data-row-id]') as HTMLElement | null
        if (!rowEl?.dataset.rowId) continue
        const item = capturedItems.find(i => i.id === rowEl.dataset.rowId)
        if (!item) continue
        const rect = rowEl.getBoundingClientRect()
        const gId = item.group_id
        const gItems = capturedItems.filter(i => i.group_id === gId).sort((a, b) => a.sort_order - b.sort_order)
        const idx = gItems.findIndex(i => i.id === item.id)
        if (cy <= rect.top + rect.height / 2) {
          const prev = idx > 0 ? gItems[idx - 1] : null
          return { y: rect.top, groupId: gId, insertAfterItem: prev }
        } else {
          return { y: rect.bottom, groupId: gId, insertAfterItem: item }
        }
      }
      return null
    }

    setDragCreate({ rowType, x: e.clientX, y: e.clientY, indicator: null })
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const t = findTarget(ev.clientX, ev.clientY)
      setDragCreate(prev => prev ? {
        ...prev, x: ev.clientX, y: ev.clientY,
        indicator: t ? { y: t.y, groupId: t.groupId, insertAfterItem: t.insertAfterItem } : null,
      } : null)
    }

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const t = findTarget(ev.clientX, ev.clientY)
      setDragCreate(null)
      // ターゲットが見つからない場合、表示中のグループタブのグループに追加する
      const fallbackGroupId = activeGroupTab ?? undefined
      handleAddRow(t?.groupId ?? fallbackGroupId, t?.insertAfterItem ?? undefined, rowType)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── 派生値 ────────────────────────────────────────────────

  const ungroupedItems = useMemo(
    () => items.filter(i => !i.group_id).sort((a, b) => a.sort_order - b.sort_order),
    [items],
  )

  // 空ラベル×実コンテンツなし のグループは非表示（新規作成直後のグループは例外）
  // 「新規項目」という名前のアイテムのみ → 実コンテンツなしとみなす
  const visibleGroups = useMemo(
    () => groups.filter(g => {
      if (g.id === newlyCreatedGroupId) return true
      if (g.label.trim() !== '') return true
      return items.some(i => i.group_id === g.id && i.name !== '新規項目')
    }),
    [groups, items, newlyCreatedGroupId],
  )

  function itemsForGroup(gid: string) {
    return items.filter(i => i.group_id === gid).sort((a, b) => a.sort_order - b.sort_order)
  }

  // タブ切替：activeGroupTab が null なら全体表示、それ以外はそのグループのみ
  const displayedGroups = useMemo(
    () => activeGroupTab ? visibleGroups.filter(g => g.id === activeGroupTab) : visibleGroups,
    [activeGroupTab, visibleGroups],
  )

  // ページ区切りマップ：item.id → そのアイテムの直前にページ区切りを入れる場合の情報
  // 見積書（estimate/page.tsx）と同じ計算：グループごとに行数をリセット・各グループが1ページ以上を占有
  const pageBreakMap = useMemo(() => {
    const result = new Map<string, { pageNum: number; pageTotal: number; pageCostTotal: number }>()
    // 見積書の詳細ページは2ページ目から（1ページ目 = 総括表）
    let pageNum = 2

    for (const group of visibleGroups) {
      const gItems = items
        .filter(i => i.group_id === group.id)
        .sort((a, b) => a.sort_order - b.sort_order)

      let pageTotal = 0
      let pageCostTotal = 0

      for (let localRow = 0; localRow < gItems.length; localRow++) {
        const item = gItems[localRow]

        // グループ内 19行ごとに改ページ（見積書と同じ）
        if (localRow > 0 && localRow % ROWS_PER_PAGE === 0) {
          result.set(item.id, { pageNum, pageTotal, pageCostTotal })
          pageNum++
          pageTotal     = 0
          pageCostTotal = 0
        }

        if ((item.row_type ?? 'item') === 'item') {
          pageTotal     += liveAmount(item)
          pageCostTotal += (item.cost_price ?? 0) * item.quantity
        }
      }

      // グループの最終チャンク分（見積書では各グループが最低1ページを占有）
      pageNum++
    }
    return result
  }, [visibleGroups, items])

  const subtotal      = useMemo(() => items.reduce((acc, i) => acc + liveAmount(i), 0), [items])
  // 各明細の原価合計（quantity × cost_price）
  const itemCostTotal = useMemo(() => items.reduce((acc, i) => acc + ((i.cost_price ?? 0) * i.quantity), 0), [items])
  // 諸経費（見積金額）: 手動上書きがあればその値、なければ小計×8%
  const miscExpense   = miscExpenseOverride != null ? miscExpenseOverride : Math.round(subtotal * 0.08)
  // 税抜合計（見積書の「合計」欄に相当）
  const taxBase       = subtotal + miscExpense - roundingDiscount
  // 諸経費の原価: 税抜合計×3%（Excelの S52 = H54×0.03 に対応）
  const miscExpenseCost  = Math.round(taxBase * 0.03)
  // 真の原価合計（明細原価 + 諸経費原価）
  const totalCost        = itemCostTotal + miscExpenseCost
  // 見積時粗利高（税抜）
  const grossProfit      = taxBase - totalCost
  // 全体粗利率
  const overallMargin    = taxBase > 0 && totalCost > 0 ? 1 - totalCost / taxBase : null
  // 消費税・総合計
  const tax              = Math.floor(taxBase * 0.1)
  const total            = taxBase + tax

  // ヘッダーに合計金額を通知（genba:total イベント）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('genba:total', { detail: total }))
  }, [total])

  // 35%粗利参考金額（原価÷0.65）— Excelの O38, O41 に対応
  const ref35ExclTax     = totalCost > 0 ? Math.round(totalCost / 0.65) : null
  const ref35InclTax     = ref35ExclTax != null ? Math.round(ref35ExclTax * 1.1) : null

  function toggleCollapsed(gid: string) {
    setCollapsed(p => ({ ...p, [gid]: !p[gid] }))
  }

  // ── 永続化 ────────────────────────────────────────────────

  async function persistReorder(
    groupUpdates: { id: string; sort_order: number }[],
    itemUpdates:  { id: string; sort_order: number; group_id: string | null }[],
  ) {
    await fetch('/api/estimate-items/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: groupUpdates, items: itemUpdates }),
    })
  }

  function handleDragEnd(result: DropResult) {
    const { source, destination, type, draggableId } = result
    if (!destination) { setSelectedIds(new Set()); return }

    if (type === 'GROUP') {
      setSelectedIds(new Set())
      if (source.index === destination.index) return
      const ng = reorder(visibleGroups, source.index, destination.index)
        .map((g, i) => ({ ...g, sort_order: i * 1000 }))
      const ngIds = new Set(ng.map(g => g.id))
      setGroups(prev => [...ng, ...prev.filter(g => !ngIds.has(g.id))])
      persistReorder(ng.map(g => ({ id: g.id, sort_order: g.sort_order })), [])
      return
    }

    if (type === 'ITEM') {
      const draggedId = draggableId.replace('item-', '')
      const dstGid    = destination.droppableId === 'ungrouped' ? null : destination.droppableId.replace('group-', '')

      // ── マルチドラッグ: 選択中のアイテムをドラッグした場合は選択全体を一括移動 ──
      if (selectedIds.has(draggedId) && selectedIds.size > 1) {
        // 選択アイテムを現在の sort_order 順で並べる
        const selectedSorted = items
          .filter(i => selectedIds.has(i.id))
          .sort((a, b) => a.sort_order - b.sort_order)

        // 移動先グループの非選択アイテム（挿入位置の計算基準）
        const dstNonSelected = items
          .filter(i => i.group_id === dstGid && !selectedIds.has(i.id))
          .sort((a, b) => a.sort_order - b.sort_order)

        // destination.index は DnD が報告する視覚上の位置（ゴースト行を含む全行が対象）。
        // 非選択行リストへの正確な挿入位置を求めるため、
        // 「destination.index より前にある非選択行の数」を insertAt とする。
        const srcGid = source.droppableId === 'ungrouped' ? null : source.droppableId.replace('group-', '')
        const dstAllSorted = items
          .filter(i => i.group_id === dstGid)
          .sort((a, b) => a.sort_order - b.sort_order)
        // 同一グループ内ドラッグ時: DnD は primary を取り除いたリストで index を報告する
        const withoutPrimary = srcGid === dstGid
          ? dstAllSorted.filter(i => i.id !== draggedId)
          : dstAllSorted
        const insertAt = withoutPrimary
          .slice(0, destination.index)
          .filter(i => !selectedIds.has(i.id))
          .length
        const newDst = [
          ...dstNonSelected.slice(0, insertAt),
          ...selectedSorted.map(i => ({ ...i, group_id: dstGid })),
          ...dstNonSelected.slice(insertAt),
        ].map((x, i) => ({ ...x, sort_order: i * 1000 }))

        const updatedItems = items.map(item => newDst.find(x => x.id === item.id) ?? item)
        setItems(updatedItems)
        setSelectedIds(new Set())

        const changed = updatedItems.filter(i => {
          const o = items.find(x => x.id === i.id)
          return o && (o.sort_order !== i.sort_order || o.group_id !== i.group_id)
        })
        persistReorder([], changed.map(i => ({ id: i.id, sort_order: i.sort_order, group_id: i.group_id })))
        return
      }

      // ── シングルドラッグ（従来通り）──
      setSelectedIds(new Set())
      const srcGid = source.droppableId === 'ungrouped' ? null : source.droppableId.replace('group-', '')
      const srcItems = items.filter(i => i.group_id === srcGid).sort((a, b) => a.sort_order - b.sort_order)
      const dstItems = srcGid === dstGid ? srcItems : items.filter(i => i.group_id === dstGid).sort((a, b) => a.sort_order - b.sort_order)
      const moved = srcItems[source.index]
      if (!moved) return

      let updatedItems: EstimateItem[]
      if (srcGid === dstGid) {
        const reordered = reorder(srcItems, source.index, destination.index)
          .map((x, i) => ({ ...x, sort_order: i * 1000 }))
        updatedItems = items.map(i => reordered.find(u => u.id === i.id) ?? i)
      } else {
        const newSrc  = srcItems.filter((_, idx) => idx !== source.index).map((x, i) => ({ ...x, sort_order: i * 1000 }))
        const newDst  = [...dstItems]
        newDst.splice(destination.index, 0, { ...moved, group_id: dstGid })
        const newDstO = newDst.map((x, i) => ({ ...x, sort_order: i * 1000 }))
        updatedItems  = items.map(i => {
          const a = newSrc.find(u => u.id === i.id);  if (a) return a
          const b = newDstO.find(u => u.id === i.id); if (b) return b
          return i
        })
      }
      setItems(updatedItems)
      const changed = updatedItems.filter(i => {
        const o = items.find(x => x.id === i.id)
        return o && (o.sort_order !== i.sort_order || o.group_id !== i.group_id)
      })
      persistReorder([], changed.map(i => ({ id: i.id, sort_order: i.sort_order, group_id: i.group_id })))
    }
  }

  async function handleAddRow(groupId?: string | null, insertAfterItem?: EstimateItem, rowType: RowType = 'item') {
    setAddingRow(true)
    try {
      const scope = groupId ? items.filter(i => i.group_id === groupId) : ungroupedItems
      let newOrder: number
      if (insertAfterItem) {
        const sorted = [...scope].sort((a, b) => a.sort_order - b.sort_order)
        const idx = sorted.findIndex(i => i.id === insertAfterItem.id)
        const next = sorted[idx + 1]
        newOrder = next
          ? Math.round((insertAfterItem.sort_order + next.sort_order) / 2)
          : insertAfterItem.sort_order + 1000
      } else {
        newOrder = scope.length > 0 ? Math.max(...scope.map(i => i.sort_order)) + 1000 : 0
      }
      const res = await fetch('/api/estimate-items/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, sort_order: newOrder, group_id: groupId ?? null, row_type: rowType }),
      })
      if (res.ok) {
        const item = await res.json() as EstimateItem
        setItems(prev => [...prev, { ...item, row_type: item.row_type ?? 'item' }])
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string }
        console.error('[EstimateTab] handleAddRow failed:', body.error)
        alert('行の追加に失敗しました。\n' + (body.error ?? '不明なエラー'))
      }
    } finally { setAddingRow(false) }
  }

  async function handleDropImportItem(
    row: { name: string; quantity: number; unit: string; cost_price: number | null; vendor_name: string; memo: string; _importId?: string },
    groupId: string,
    afterItemId?: string | null
  ) {
    // afterItemId が渡された場合はそこに挿入する sort_order を計算する
    let insertSortOrder: number | undefined
    if (afterItemId !== undefined) {
      const gItems = itemsForGroup(groupId)
      if (afterItemId === null) {
        // グループの先頭に挿入
        insertSortOrder = (gItems[0]?.sort_order ?? 1000) - 500
      } else {
        const idx = gItems.findIndex(i => i.id === afterItemId)
        if (idx >= 0) {
          const curr = gItems[idx]
          const next = gItems[idx + 1]
          insertSortOrder = next
            ? Math.round((curr.sort_order + next.sort_order) / 2)
            : curr.sort_order + 1000
        }
      }
    }

    const res = await fetch('/api/estimate-items/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId, group_id: groupId,
        ...(insertSortOrder !== undefined ? { sort_order: insertSortOrder } : {}),
        items: [{ name: row.name, quantity: row.quantity, unit: row.unit, cost_price: row.cost_price, vendor_name: row.vendor_name || null, memo: row.memo || null }],
      }),
    })
    if (res.ok) {
      window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } }))
      if (row._importId) {
        window.dispatchEvent(new CustomEvent('genba:import-item-moved', { detail: { importId: row._importId } }))
      }
    }
  }

  async function handleCreateGroup() {
    setCreating(true)
    try {
      const maxOrder = groups.length > 0 ? Math.max(...groups.map(g => g.sort_order)) + 1000 : 0
      const res = await fetch('/api/estimate-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, label: '', sort_order: maxOrder }),
      })
      if (res.ok) { const group = await res.json() as EstimateGroup; setGroups(prev => [...prev, group]); setNewlyCreatedGroupId(group.id) }
    } finally { setCreating(false) }
  }

  async function handleGroupLabelChange(gid: string, label: string) {
    setGroups(prev => prev.map(g => g.id === gid ? { ...g, label } : g))
    if (gid === newlyCreatedGroupId && label.trim() !== '') setNewlyCreatedGroupId(null)
    await fetch(`/api/estimate-groups/${gid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })
  }

  async function handleDisplayModeToggle(gid: string) {
    const g  = groups.find(x => x.id === gid); if (!g) return
    const nm = g.display_mode === 'detailed' ? 'lump_sum' : 'detailed'
    setGroups(prev => prev.map(x => x.id === gid ? { ...x, display_mode: nm } : x))
    await fetch(`/api/estimate-groups/${gid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_mode: nm }),
    })
  }

  async function handleDeleteGroup(gid: string) {
    if (!confirm('グループを削除しますか？\n項目はグループなしに移動されます。')) return
    const res = await fetch(`/api/estimate-groups/${gid}`, { method: 'DELETE' })
    if (res.ok) {
      setGroups(prev => prev.filter(g => g.id !== gid))
      setItems(prev => prev.map(i => i.group_id === gid ? { ...i, group_id: null } : i))
    }
  }

  async function handleDeleteEmptyGroup(gid: string) {
    setNewlyCreatedGroupId(null)
    const res = await fetch(`/api/estimate-groups/${gid}`, { method: 'DELETE' })
    if (res.ok) setGroups(prev => prev.filter(g => g.id !== gid))
  }

  async function handleSave(itemId: string, changes: ItemPatch) {
    let finalChanges: ItemPatch = { ...changes }

    if ('cost_price' in changes && changes.cost_price != null) {
      // 手動上書きされていない限り selling_price を原価×1.45 で自動計算
      if (!manualSelling.has(itemId)) {
        finalChanges = { ...finalChanges, selling_price: Math.round(changes.cost_price * 1.45) }
      }
    } else if ('selling_price' in changes) {
      // 手動で単価を編集 → 以降の原価変更でも上書きしない
      setManualSelling(prev => new Set([...prev, itemId]))
    }

    // 楽観的更新でUIを即時反映
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...finalChanges } : i))

    const res = await fetch(`/api/estimate-items/${itemId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalChanges),
    })
    if (!res.ok) { alert('保存に失敗しました'); return }
    const updated = await res.json() as Partial<EstimateItem>
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...updated } : i))
  }

  async function handleDelete(itemId: string) {
    setDeleting(p => ({ ...p, [itemId]: true }))
    try {
      const res = await fetch(`/api/estimate-items/${itemId}`, { method: 'DELETE' })
      if (res.ok) setItems(prev => prev.filter(i => i.id !== itemId))
      else alert('削除に失敗しました')
    } finally { setDeleting(p => { const n = { ...p }; delete n[itemId]; return n }) }
  }

  async function saveMiscExpense(value: number | null) {
    setMiscExpenseOverride(value)
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ misc_expense_override: value }),
    })
  }

  async function saveRoundingDiscount(value: number) {
    setRoundingDiscount(value)
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounding_discount: value }),
    })
  }

  // ── 複数選択 → グループ移動 ───────────────────────────────

  // グループの一括選択状態を返す
  function calcGroupCheckState(gid: string): 'none' | 'partial' | 'all' {
    const gItems = items.filter(i => i.group_id === gid)
    if (gItems.length === 0) return 'none'
    const cnt = gItems.filter(i => selectedIds.has(i.id)).length
    if (cnt === 0) return 'none'
    return cnt === gItems.length ? 'all' : 'partial'
  }

  function handleGroupSelect(gid: string) {
    const gItems = items.filter(i => i.group_id === gid)
    if (gItems.length === 0) return
    const state = calcGroupCheckState(gid)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (state === 'all') gItems.forEach(i => next.delete(i.id))
      else                 gItems.forEach(i => next.add(i.id))
      return next
    })
  }

  // 全行を画面表示順にフラット化（Shift範囲選択の基準）
  const flatItemOrder = useMemo(() => {
    const result: EstimateItem[] = []
    for (const g of visibleGroups) {
      result.push(...items.filter(i => i.group_id === g.id).sort((a, b) => a.sort_order - b.sort_order))
    }
    result.push(...ungroupedItems)
    return result
  }, [visibleGroups, items, ungroupedItems])

  function handleItemSelect(itemId: string, shift: boolean) {
    if (shift && lastClickedIdRef.current && lastClickedIdRef.current !== itemId) {
      // Shift+クリック: 前回クリックした行から今回の行まで一括選択
      const allIds = flatItemOrder.map(i => i.id)
      const fromIdx = allIds.indexOf(lastClickedIdRef.current)
      const toIdx   = allIds.indexOf(itemId)
      if (fromIdx !== -1 && toIdx !== -1) {
        const lo = Math.min(fromIdx, toIdx)
        const hi = Math.max(fromIdx, toIdx)
        setSelectedIds(prev => {
          const next = new Set(prev)
          allIds.slice(lo, hi + 1).forEach(id => next.add(id))
          return next
        })
        return // lastClickedIdRef は更新しない（連続Shift選択ができるよう）
      }
    }
    // 通常クリック: 単体トグル
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(itemId) ? next.delete(itemId) : next.add(itemId)
      return next
    })
    lastClickedIdRef.current = itemId
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return
    if (!confirm(`選択中の ${selectedIds.size} 件を削除しますか？`)) return
    const ids = Array.from(selectedIds)
    setSelectedIds(new Set())
    await Promise.all(
      ids.map(id =>
        fetch(`/api/estimate-items/${id}`, { method: 'DELETE' })
          .then(res => { if (res.ok) setItems(prev => prev.filter(i => i.id !== id)) })
      )
    )
  }

  async function moveSelectedToGroup(targetGroupId: string | null) {
    if (selectedIds.size === 0) return
    const tgtItems = items.filter(i => i.group_id === targetGroupId).sort((a, b) => a.sort_order - b.sort_order)
    const baseOrder = tgtItems.length > 0 ? Math.max(...tgtItems.map(i => i.sort_order)) + 1000 : 0
    const updates = Array.from(selectedIds).map((id, i) => ({
      id, group_id: targetGroupId, sort_order: baseOrder + i * 1000,
    }))
    setItems(prev => prev.map(item => {
      const u = updates.find(x => x.id === item.id)
      return u ? { ...item, group_id: u.group_id, sort_order: u.sort_order } : item
    }))
    setSelectedIds(new Set())
    await persistReorder([], updates)
  }

  // ── 安定した renderClone（常に同一参照） ──────────────────────────────────
  // renderClone を onDragStart 後の再レンダーで差し替えると、@hello-pangea/dnd が
  // ドロップ可能エリア深部でのドラッグをキャンセルする。ref を読むことで
  // 関数参照を変えずにマルチ/シングル判定を動的に切り替える。
  const stableRenderClone = useCallback(
    (provided: import('@hello-pangea/dnd').DraggableProvided,
     _snap: import('@hello-pangea/dnd').DraggableStateSnapshot,
     rubric: import('@hello-pangea/dnd').DraggableRubric) => {
      const dId  = draggingIdRef.current
      const sIds = selectedIdsRef.current
      const ci   = itemsRef.current.find(i => `item-${i.id}` === rubric.draggableId)

      if (!dId) {
        // シングルドラッグ: シンプルなカード型ゴースト
        return (
          <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
            style={{ ...provided.draggableProps.style, background: '#fff', border: `1.5px solid ${C.divider}`, borderRadius: 6, height: ROW_H, display: 'flex', alignItems: 'center', paddingLeft: 52, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', fontFamily: FONT }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 16 }}>{ci?.name ?? ''}</span>
          </div>
        )
      }

      // マルチドラッグ: 積み重ねゴースト
      const extra = sIds.size - 1
      return (
        <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={provided.draggableProps.style}>
          <div style={{ position: 'relative' }}>
            {extra >= 2 && <div style={{ position: 'absolute', top: 6, left: 6, right: -6, bottom: -6, background: `${C.accentLight}70`, border: `1.5px solid ${C.accentTint}50`, borderRadius: 8 }} />}
            {extra >= 1 && <div style={{ position: 'absolute', top: 3, left: 3, right: -3, bottom: -3, background: `${C.accentLight}90`, border: `1.5px solid ${C.accentTint}`, borderRadius: 8 }} />}
            <div style={{ position: 'relative', background: C.accentLight, border: `2px solid ${C.accent}`, borderRadius: 8, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', boxShadow: `0 8px 28px rgba(22,114,236,0.28)`, fontFamily: FONT }}>
              <GripIcon />
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ci?.name ?? ''}</span>
              {extra > 0 && <span style={{ background: C.accent, color: '#fff', borderRadius: 12, padding: '2px 9px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>+{extra}件</span>}
            </div>
          </div>
        </div>
      )
    },
    [], // ref から読むので依存なし・参照が変わらない
  )

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleExcelDownload() {
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/excel`)
      if (!res.ok) { const b = await res.json().catch(() => ({})); alert((b as { error?: string }).error ?? 'ダウンロードに失敗しました'); return }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = Object.assign(document.createElement('a'), { href: url, download: '内訳明細書.xlsx' })
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    } catch { /* noop */ }
  }

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>読み込み中...</div>
  )

  const isEmpty = items.length === 0 && visibleGroups.length === 0

  // ── レンダー ──────────────────────────────────────────────

  return (
    <GridColsCtx.Provider value={GRID_COLS}>
    <style>{`
      @keyframes tab-drag-fill {
        from { width: 0%; }
        to   { width: 100%; }
      }
    `}</style>
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', background: '#EEF1F6', padding: 12, gap: 12 }}>
      <div style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 10, overflow: 'clip',
        border: `1px solid ${C.divider}`,
        boxShadow: '0 1px 4px rgba(26,35,50,0.06)',
        background: C.bg,
      }}>

        {/* ── ツールバー + 選択アクションバー（sticky 固定）── */}
        <div style={{ position: 'sticky', top: 0, zIndex: 30, background: C.bg }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 16px', height: 52,
          background: C.bg, borderBottom: HDIV,
        }}>
          <button style={st.tbBtn} onMouseDown={e => startDragCreate(e, 'item')} disabled={addingRow}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            行を追加
          </button>
          <button style={st.tbBtnHeader} onMouseDown={e => startDragCreate(e, 'header')} disabled={addingRow} title="グループ内の区切り見出し（金額なし）">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="17" y2="18"/>
            </svg>
            見出し行
          </button>
          <button style={st.tbBtnNote} onMouseDown={e => startDragCreate(e, 'note')} disabled={addingRow} title="自由記載のメモ行（金額なし）">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            メモ行
          </button>
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <button style={st.tbBtn} onClick={handleCreateGroup} disabled={creating}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            工種グループ追加
          </button>
          <div style={{ flex: 1 }} />
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <button
            onClick={() => { setShowSummaryBar(v => !v); if (showSummaryBar) setShowSummaryDetail(false) }}
            title={showSummaryBar ? '金額バーを閉じる' : '金額バーを表示'}
            style={{
              fontSize: 10, padding: '2px 7px', height: 22, lineHeight: 1,
              border: `1px solid ${showSummaryBar ? C.accentTint : C.divider}`, borderRadius: 4,
              background: showSummaryBar ? C.accentLight : '#F3F4F6',
              cursor: 'pointer', color: showSummaryBar ? C.accent : C.textMuted,
              fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 2,
              flexShrink: 0,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points={showSummaryBar ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
            </svg>
            金額
          </button>
          <button
            onClick={() => setShowImportModal(v => !v)}
            style={{
              ...st.tbBtn, display: 'inline-flex', alignItems: 'center', gap: 5,
              borderColor: showImportModal ? '#93C5FD' : '#A8C5B5',
              color: showImportModal ? '#1E40AF' : '#1E5C3A',
              background: showImportModal ? '#DBEAFE' : '#EAF3DE',
            }}
            title="見積書の画像・PDFをAIで解析して取り込む"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            {showImportModal ? '取込パネルを閉じる' : '見積書を取り込む'}
          </button>
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <a href={`/projects/${projectId}/estimate`} target="_blank" rel="noreferrer"
            style={{ ...st.tbBtn, ...st.tbAccent, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            見積書を表示
          </a>
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('genba:tab', { detail: 'invoice' }))}
            style={{ ...st.tbBtn, display: 'inline-flex', alignItems: 'center', gap: 5, borderColor: '#A0BFD8', color: '#1E3A5F', background: '#EFF6FF' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              <line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="15" y2="11"/>
            </svg>
            請求書を作成
          </button>
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <button
            onClick={() => setShowRevConfirm(true)}
            style={{ ...st.tbBtn, borderColor: '#B5A0D8', color: '#5B21B6', background: '#F5F0FF' }}
            title="現在の見積をRevとしてスナップショット保存"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
            </svg>
            Rev確定
          </button>
          <button
            onClick={() => setShowRevHistory(v => !v)}
            style={{ ...st.tbBtn, borderColor: '#B5A0D8', color: '#5B21B6', background: showRevHistory ? '#EDE9FE' : '#F5F0FF', position: 'relative' }}
            title="改訂履歴を表示"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            履歴
            {revisions.length > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, background: '#5B21B6', color: '#fff', borderRadius: 10, padding: '1px 5px', marginLeft: 2 }}>
                {revisions.length}
              </span>
            )}
          </button>
        </div>

        {/* ── 選択アクションバー（複数選択時のみ表示）── */}
        {selectedIds.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '0 16px', height: 40,
            background: C.accentLight,
            borderBottom: `1px solid ${C.accentTint}`,
            flexShrink: 0,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, fontFamily: FONT }}>
              {selectedIds.size}件選択中
            </span>
            <span style={{ fontSize: 12, color: C.textSub, fontFamily: FONT }}>→ 移動先：</span>
            <select
              defaultValue=""
              onChange={e => {
                const v = e.target.value
                if (!v) return
                moveSelectedToGroup(v === '__none__' ? null : v)
                e.target.value = ''
              }}
              style={{
                fontSize: 12, border: `1px solid ${C.accentTint}`, borderRadius: 5,
                padding: '3px 8px', background: '#fff', cursor: 'pointer',
                color: C.text, fontFamily: FONT, outline: 'none',
              }}
            >
              <option value="">── グループを選択 ──</option>
              <option value="__none__">グループなし</option>
              {visibleGroups.map(g => (
                <option key={g.id} value={g.id}>{g.label || '（無題）'}</option>
              ))}
            </select>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleDeleteSelected}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 700,
                color: C.red, background: C.redBg,
                border: `1px solid #F9C0CF`, borderRadius: 5,
                padding: '3px 10px', cursor: 'pointer', fontFamily: FONT,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
              </svg>
              削除
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              style={{
                fontSize: 11, color: C.textMuted, background: 'none',
                border: 'none', cursor: 'pointer', fontFamily: FONT,
              }}
            >
              解除
            </button>
          </div>
        )}

        {/* ── 合計バー（コンパクト1行・非表示切替可）── */}
        {showSummaryBar && <div style={{
          background: C.bg,
          borderBottom: `1px solid ${C.divider}`,
          boxShadow: '0 1px 6px rgba(26,35,50,0.08)',
        }}>

          {/* メイン行：合計（税込）| フロー | 全体粗利率 */}
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '0 20px', height: SUMMARY_TOP_H,
            gap: 16,
          }}>
            {/* 合計（税込） */}
            <TopFormulaCell
              label="合計（税込）"
              value={`¥${fmt(total)}`}
              valueColor={C.green}
              formula={[
                '税抜合計 + 消費税',
                `= ¥${fmt(taxBase)} + ¥${fmt(tax)}`,
                `= ¥${fmt(total)}`,
                '─────────────────',
                `税抜合計 = 小計 + 諸経費 − 端数値引`,
                `= ¥${fmt(subtotal)} + ¥${fmt(miscExpense)} − ¥${fmt(roundingDiscount)}`,
              ]}
            />

            {/* 中央：小計→諸経費→消費税の小さいフロー表示 */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, overflow: 'hidden' }}>
              {[
                { label: '小計', value: `¥${fmt(subtotal)}` },
                null,
                { label: miscExpenseOverride != null ? '諸経費▲' : '諸経費', value: `¥${fmt(miscExpense)}`, highlight: miscExpenseOverride != null },
                ...(roundingDiscount > 0 ? [null, { label: '値引', value: `▲¥${fmt(roundingDiscount)}`, negative: true }] : []),
                null,
                { label: '消費税', value: `¥${fmt(tax)}` },
              ].map((chip, i) =>
                chip === null ? (
                  <span key={i} style={{ color: C.textMuted, fontSize: 10, flexShrink: 0 }}>→</span>
                ) : (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0 }}>
                    <span style={{ fontSize: 9, color: (chip as {highlight?: boolean}).highlight ? C.orange : C.textMuted, letterSpacing: '0.04em' }}>{chip.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: (chip as {negative?: boolean}).negative ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>{chip.value}</span>
                  </div>
                )
              )}
              {/* 詳細トグル */}
              <button
                onClick={() => setShowSummaryDetail(p => !p)}
                title={showSummaryDetail ? '詳細を閉じる' : '諸経費・値引きを編集'}
                style={{ marginLeft: 8, background: showSummaryDetail ? C.accentLight : '#F3F4F6', border: `1px solid ${showSummaryDetail ? C.accentTint : C.divider}`, borderRadius: 5, cursor: 'pointer', padding: '2px 8px', fontSize: 10, color: showSummaryDetail ? C.accent : C.textMuted, fontFamily: FONT, flexShrink: 0 }}
              >
                {showSummaryDetail ? '▲ 閉じる' : '▼ 編集'}
              </button>
            </div>

            {/* 全体粗利率 */}
            <TopFormulaCell
              label="全体粗利率"
              value={overallMargin != null ? `${(overallMargin * 100).toFixed(1)}%` : '─'}
              valueColor={overallMargin != null
                ? (overallMargin < 0.15 ? C.red : overallMargin < 0.30 ? C.orange : '#2B5E40')
                : C.textMuted}
              formula={overallMargin != null ? [
                '1 − 原価合計 ÷ 税抜合計',
                `= 1 − ¥${fmt(totalCost)} ÷ ¥${fmt(taxBase)}`,
                `= ${(overallMargin * 100).toFixed(2)}%`,
                '─────────────────',
                `原価合計 = 明細原価 + 諸経費原価`,
                `= ¥${fmt(itemCostTotal)} + ¥${fmt(miscExpenseCost)}`,
              ] : undefined}
            />
          </div>

          {/* 詳細行（諸経費・端数値引き編集）展開時のみ */}
          {showSummaryDetail && (
            <>
              <div style={{ height: 1, background: C.divider }} />
              <div style={{
                display: 'flex', alignItems: 'stretch', gap: 6,
                background: '#F8F9FA',
                padding: '6px 16px', height: SUMMARY_ROW1_H,
              }}>
                <DetailCell label="小計" value={`¥${fmt(subtotal)}`}
                  formula={['各明細の「数量 × 売価」の合計', `= ¥${fmt(subtotal)}`]}
                />
                <SummaryEditCell
                  label={miscExpenseOverride != null ? '諸経費（上書き中）' : '諸経費（小計×8%）'}
                  value={miscExpense}
                  highlight={miscExpenseOverride != null}
                  onCommit={v => saveMiscExpense(v)}
                  onReset={() => saveMiscExpense(null)}
                  showReset={miscExpenseOverride != null}
                />
                <SummaryEditCell
                  label="端数値引"
                  value={roundingDiscount}
                  negative
                  onCommit={v => saveRoundingDiscount(v ?? 0)}
                />
                <DetailCell label="消費税（10%）" value={`¥${fmt(tax)}`}
                  formula={['（小計 + 諸経費 − 端数値引）× 10%', `= ¥${fmt(taxBase)} × 10%`, `= ¥${fmt(tax)}`]}
                />
              </div>
            </>
          )}

        </div>}

        {/* ── グループタブバー ── */}
        {visibleGroups.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'stretch', gap: 0,
            height: 40, padding: '0 8px',
            borderBottom: `1px solid ${C.divider}`,
            background: C.bg, overflowX: 'auto',
            scrollbarWidth: 'none',
          }}>
            {[{ id: null as string | null, label: '全体' }, ...visibleGroups.map(g => ({ id: g.id, label: g.label || '（無題）' }))].map(tab => {
              const tabKey = tab.id ?? 'all'
              const isActive = tab.id === activeGroupTab
              const isDragHover = dragHoverTabId === tabKey
              return (
                <button
                  key={tabKey}
                  onClick={() => setActiveGroupTab(tab.id)}
                  onDragOver={e => {
                    if (!e.dataTransfer.types.includes('application/genba-import-item')) return
                    e.preventDefault()
                    if (dragHoverTabId === tabKey) return
                    setDragHoverTabId(tabKey)
                    if (dragTabTimer.current) clearTimeout(dragTabTimer.current)
                    dragTabTimer.current = setTimeout(() => {
                      setActiveGroupTab(tab.id)
                      setDragHoverTabId(null)
                      dragTabTimer.current = null
                    }, 500)
                  }}
                  onDragLeave={() => {
                    setDragHoverTabId(null)
                    if (dragTabTimer.current) { clearTimeout(dragTabTimer.current); dragTabTimer.current = null }
                  }}
                  style={{
                    position: 'relative', overflow: 'hidden',
                    height: '100%', padding: '0 14px', border: 'none',
                    background: isDragHover ? `${C.accentLight}` : 'none',
                    cursor: 'pointer', fontFamily: FONT, fontSize: 12,
                    fontWeight: isActive ? 700 : 400,
                    color: isActive ? C.accent : isDragHover ? C.accent : C.textSub,
                    borderBottom: isActive ? `2px solid ${C.accent}` : isDragHover ? `2px solid ${C.accentMid}` : '2px solid transparent',
                    whiteSpace: 'nowrap', flexShrink: 0,
                    transition: 'color 0.12s, border-color 0.12s, background 0.12s',
                  }}
                >
                  {tab.label}
                  {isDragHover && (
                    <div style={{
                      position: 'absolute', bottom: 0, left: 0,
                      height: 2, background: C.accent,
                      animation: 'tab-drag-fill 0.5s linear forwards',
                    }} />
                  )}
                </button>
              )
            })}
          </div>
        )}
        </div>{/* /sticky toolbar wrapper */}

        {/* ── テーブル ── */}
        <div id="estimate-table-scroll" style={{ overflow: 'auto', flex: 1 }}>
          <div style={{ minWidth: 1310 }}>

            {/* ── 2段ヘッダー（sticky でまとめてスクロール追従） ── */}
            <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>

              {/* 列ヘッダー（固定幅） */}
              <div style={{
                display: 'grid', gridTemplateColumns: GRID_COLS,
                background: '#FAFBFD',
                borderBottom: `2px solid ${C.divider}`,
                fontFamily: FONT,
              }}>
                {leafHeaderGroup?.headers.map(header => {
                  const def        = COL_DEFS.find(c => c.id === header.id)
                  const isInternal = def?.meta.group === 'internal'
                  const align      = def?.meta.align ?? 'left'
                  return (
                    <div key={header.id} style={{
                      padding: '0 10px', height: HEAD_H,
                      display: 'flex', alignItems: 'center',
                      justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
                      fontSize: 10, fontWeight: 700,
                      color: C.textMuted,
                      whiteSpace: 'nowrap',
                      letterSpacing: '0.07em',
                      textTransform: 'uppercase' as const,
                      background: isInternal ? C.internalBg : undefined,
                    }}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 空状態 */}
            {isEmpty && (
              <div style={{ padding: '60px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={C.divider} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
                </svg>
                <p style={{ margin: 0, color: C.textSub, fontSize: 14, fontWeight: 600, fontFamily: FONT }}>見積項目がありません</p>
                <p style={{ margin: 0, color: C.textMuted, fontSize: 12, fontFamily: FONT }}>
                  上の「行を追加」または「工種グループ追加」から作成してください
                </p>
              </div>
            )}

            {/* ── DnD 本体 ── */}
            {/* グレーキャンバス: カードが白い背景に浮いて見えるよう内側にグレーサーフェスを敷く */}
            <div style={{ background: C.bg }}>
            <DragDropContext
              onDragStart={(start: DragStart) => {
                startDndAutoScroll()
                if (start.type !== 'ITEM') return
                const id = start.draggableId.replace('item-', '')
                if (selectedIds.has(id) && selectedIds.size > 1) {
                  draggingIdRef.current = id   // 再レンダー前に同期
                  setDraggingId(id)            // isGhost のために state も更新
                }
              }}
              onDragEnd={result => { stopDndAutoScroll(); draggingIdRef.current = null; setDraggingId(null); handleDragEnd(result) }}
            >

              {/* グループ */}
              <Droppable droppableId="group-list" type="GROUP">
                {provided => (
                  <div ref={provided.innerRef} {...provided.droppableProps}>
                    {displayedGroups.map((group, gi) => {
                      const gItems    = itemsForGroup(group.id)
                      const gTotal    = gItems.reduce((acc, i) => acc + liveAmount(i), 0)
                      const gCostTotal = gItems.reduce((acc, i) => acc + ((i.cost_price ?? 0) * i.quantity), 0)
                      const isOpen    = !collapsed[group.id]

                      // GroupSubtotal に表示する「小　計」= 最終ページ分のみ
                      // ページ区切りがある場合（>19行）は最後のP.X区切り以降の項目合計のみ表示
                      const numGroupBreaks = gItems.length > 0 ? Math.floor((gItems.length - 1) / ROWS_PER_PAGE) : 0
                      const lastPageStart  = numGroupBreaks * ROWS_PER_PAGE
                      const lastPageItems  = gItems.slice(lastPageStart)
                      const lastPageSubtotal  = lastPageItems.reduce((acc, i) => acc + liveAmount(i), 0)
                      const lastPageCostTotal = lastPageItems.reduce((acc, i) => acc + ((i.cost_price ?? 0) * i.quantity), 0)

                      return (
                        <Draggable key={group.id} draggableId={`group-${group.id}`} index={gi}>
                          {(prov, snap) => (
                            <div ref={prov.innerRef} {...prov.draggableProps}
                              style={{
                                ...prov.draggableProps.style,
                                marginBottom: 12,
                                opacity: snap.isDragging ? 0.96 : 1,
                              }}
                              onMouseEnter={() => setHoveredGroup(group.id)}
                              onMouseLeave={() => setHoveredGroup(null)}>

                              {/* 枠線コンテナ（カード型・グループ名は中のヘッダー行に表示） */}
                              <div
                                style={{
                                  border: dragOverGroupId === group.id
                                    ? `2px solid ${C.accent}`
                                    : `1.5px solid ${C.divider}`,
                                  borderRadius: 10,
                                  overflow: 'hidden',
                                  boxShadow: snap.isDragging
                                    ? `0 6px 24px rgba(0,0,0,0.12)`
                                    : dragOverGroupId === group.id
                                      ? `0 0 0 3px ${C.accent}22`
                                      : '0 1px 3px rgba(0,0,0,0.04)',
                                  transition: 'border-color 0.12s, box-shadow 0.12s',
                                }}
                                onDragOver={e => {
                                  if (!e.dataTransfer.types.includes('application/genba-import-item')) return
                                  e.preventDefault()
                                  setDragOverGroupId(group.id)
                                }}
                                onDragLeave={e => {
                                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                                    setDragOverGroupId(null)
                                    setImportDragTarget(null)
                                  }
                                }}
                                onDrop={async e => {
                                  e.preventDefault()
                                  const afterItemId = importDragTarget?.groupId === group.id ? importDragTarget.afterItemId : undefined
                                  setDragOverGroupId(null)
                                  setImportDragTarget(null)
                                  const raw = e.dataTransfer.getData('application/genba-import-item')
                                  if (!raw) return
                                  await handleDropImportItem(JSON.parse(raw) as { name: string; quantity: number; unit: string; cost_price: number | null; vendor_name: string; memo: string }, group.id, afterItemId)
                                }}
                              >
                              <GroupHeader
                                group={group} groupIndex={gi} expanded={isOpen}
                                isNew={group.id === newlyCreatedGroupId}
                                onToggle={() => toggleCollapsed(group.id)}
                                onLabelChange={l => handleGroupLabelChange(group.id, l)}
                                onDisplayModeToggle={() => handleDisplayModeToggle(group.id)}
                                onDelete={() => handleDeleteGroup(group.id)}
                                onDeleteEmpty={() => handleDeleteEmptyGroup(group.id)}
                                dragHandleProps={prov.dragHandleProps}
                                hovered={hoveredGroup === group.id} subtotal={gTotal}
                                groupCheckState={calcGroupCheckState(group.id)}
                                onGroupSelect={() => handleGroupSelect(group.id)}
                              />

                              {isOpen && group.display_mode !== 'lump_sum' && (
                                <Droppable droppableId={`group-${group.id}`} type="ITEM"
                                  renderClone={stableRenderClone}
                                >
                                  {(dp, ds) => (
                                    <div ref={dp.innerRef} {...dp.droppableProps}
                                      style={{ minHeight: 32, background: ds.isDraggingOver ? `${C.accent}08` : 'transparent', transition: 'background 0.12s' }}>
                                      {gItems.map((item, idx) => {
                                        // PageBreakRow を Draggable の兄弟として置くと @hello-pangea/dnd の
                                        // 位置計算が狂い複数選択ドラッグが失敗する。
                                        // 代わりに直前の Draggable 内（paddingBottom 領域）に埋め込む。
                                        const nextItem = gItems[idx + 1]
                                        const nextPb = nextItem ? pageBreakMap.get(nextItem.id) : undefined
                                        // インポートドラッグの挿入インジケーター表示判定
                                        const prevId = idx === 0 ? null : gItems[idx - 1].id
                                        const showIndicatorBefore = importDragTarget?.groupId === group.id && importDragTarget?.afterItemId === prevId
                                        const showIndicatorAfter  = importDragTarget?.groupId === group.id && importDragTarget?.afterItemId === item.id && idx === gItems.length - 1
                                        return (
                                        <Draggable key={item.id} draggableId={`item-${item.id}`} index={idx}>
                                          {(ip, is) => (
                                            <div ref={ip.innerRef} {...ip.draggableProps} style={ip.draggableProps.style}
                                              onDragOver={e => {
                                                if (!e.dataTransfer.types.includes('application/genba-import-item')) return
                                                e.preventDefault()
                                                e.stopPropagation()
                                                const rect = e.currentTarget.getBoundingClientRect()
                                                const mid  = rect.top + rect.height / 2
                                                if (e.clientY < mid) {
                                                  setImportDragTarget({ afterItemId: idx === 0 ? null : gItems[idx - 1].id, groupId: group.id })
                                                } else {
                                                  setImportDragTarget({ afterItemId: item.id, groupId: group.id })
                                                }
                                              }}
                                            >
                                              {showIndicatorBefore && !is.isDragging && (
                                                <div style={{
                                                  height: 28, margin: '2px 8px',
                                                  borderRadius: 4,
                                                  border: '2px dashed #16a34a',
                                                  background: '#dcfce7',
                                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                  fontSize: 11, color: '#16a34a', fontWeight: 600, letterSpacing: '0.04em',
                                                  pointerEvents: 'none',
                                                }}>ここに追加</div>
                                              )}
                                              <div style={{ position: 'relative', paddingBottom: nextPb ? 30 : 0 }}>
                                                <ItemRow item={item} inGroup isDragging={is.isDragging}
                                                  dragHandleProps={ip.dragHandleProps}
                                                  onSave={c => handleSave(item.id, c)}
                                                  onDelete={() => handleDelete(item.id)}
                                                  deleting={!!deleting[item.id]} rowIndex={idx}
                                                  selected={selectedIds.has(item.id)}
                                                  onToggleSelect={(shift) => handleItemSelect(item.id, shift)}
                                                  anySelected={selectedIds.size > 0}
                                                  indent={localIndent[item.id] ?? 0}
                                                  onIndent={() => setLocalIndent(p => ({ ...p, [item.id]: Math.min((p[item.id] ?? 0) + 1, 3) }))}
                                                  onUnindent={() => setLocalIndent(p => ({ ...p, [item.id]: Math.max((p[item.id] ?? 0) - 1, 0) }))}
                                                  isGhost={draggingId !== null && selectedIds.has(item.id) && item.id !== draggingId} />
                                                {nextPb && !is.isDragging && (
                                                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 30 }}>
                                                    <PageBreakRow pageNum={nextPb.pageNum} pageTotal={nextPb.pageTotal} pageCostTotal={nextPb.pageCostTotal} />
                                                  </div>
                                                )}
                                              </div>
                                              {showIndicatorAfter && !is.isDragging && (
                                                <div style={{
                                                  height: 28, margin: '2px 8px',
                                                  borderRadius: 4,
                                                  border: '2px dashed #16a34a',
                                                  background: '#dcfce7',
                                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                  fontSize: 11, color: '#16a34a', fontWeight: 600, letterSpacing: '0.04em',
                                                  pointerEvents: 'none',
                                                }}>ここに追加</div>
                                              )}
                                            </div>
                                          )}
                                        </Draggable>
                                        )
                                      })}
                                      {dp.placeholder}
                                      {gItems.length === 0 && (
                                        <div style={{ padding: '8px 52px' }}>
                                          <PillAddBtn onClick={() => handleAddRow(group.id)} disabled={addingRow} label="行を追加" />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </Droppable>
                              )}

                              {isOpen && group.display_mode === 'lump_sum' && (
                                <div style={{ padding: '8px 52px', color: C.textMuted, fontSize: 12, background: `${C.groupBg}60`, fontFamily: FONT }}>
                                  {gItems.length}項目を一括表示中
                                </div>
                              )}

                              {isOpen && <GroupSubtotal total={lastPageSubtotal} itemCount={gItems.length} costTotal={lastPageCostTotal} />}
                              </div> {/* 枠線コンテナ閉じ */}
                            </div>
                          )}
                        </Draggable>
                      )
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>

              {/* グループなし */}
              {ungroupedItems.length > 0 && activeGroupTab === null && (
                <>
                  {groups.length > 0 && (
                    <div style={{
                      display: 'grid', gridTemplateColumns: GRID_COLS,
                      height: GRP_H, background: C.groupBg,
                      alignItems: 'center',
                      borderTop: `1px solid ${C.divider}`,
                      borderBottom: `1px solid ${C.divider}`,
                    }}>
                      <div />
                      <div style={{ paddingLeft: 16, fontSize: 10, fontWeight: 800, color: C.textMuted, letterSpacing: '0.09em', textTransform: 'uppercase' as const, fontFamily: FONT }}>
                        その他
                      </div>
                      <div/><div/><div/><div/><div/>
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div/>
                    </div>
                  )}
                  <Droppable droppableId="ungrouped" type="ITEM"
                    renderClone={stableRenderClone}
                  >
                    {(dp, ds) => (
                      <div ref={dp.innerRef} {...dp.droppableProps}
                        style={{ minHeight: 32, background: ds.isDraggingOver ? `${C.accent}08` : 'transparent', transition: 'background 0.12s' }}>
                        {ungroupedItems.map((item, idx) => (
                          <Draggable key={item.id} draggableId={`item-${item.id}`} index={idx}>
                            {(ip, is) => (
                              <div ref={ip.innerRef} {...ip.draggableProps} style={ip.draggableProps.style}>
                                <ItemRow item={item} inGroup={false} isDragging={is.isDragging}
                                  dragHandleProps={ip.dragHandleProps}
                                  onSave={c => handleSave(item.id, c)}
                                  onDelete={() => handleDelete(item.id)}
                                  deleting={!!deleting[item.id]} rowIndex={idx}
                                  selected={selectedIds.has(item.id)}
                                  onToggleSelect={(shift) => handleItemSelect(item.id, shift)}
                                  anySelected={selectedIds.size > 0}
                                  indent={localIndent[item.id] ?? 0}
                                  onIndent={() => setLocalIndent(p => ({ ...p, [item.id]: Math.min((p[item.id] ?? 0) + 1, 3) }))}
                                  onUnindent={() => setLocalIndent(p => ({ ...p, [item.id]: Math.max((p[item.id] ?? 0) - 1, 0) }))}
                                  isGhost={draggingId !== null && selectedIds.has(item.id) && item.id !== draggingId} />
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {dp.placeholder}
                      </div>
                    )}
                  </Droppable>
                </>
              )}

            </DragDropContext>
            </div>{/* /グレーキャンバス */}

          </div>
        </div>


      </div>

      {/* ── 取込パネル（右サイドパネル）── */}
      {showImportModal && (
        <div style={{
          width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRadius: 10, border: `1px solid ${C.divider}`,
          boxShadow: '0 1px 4px rgba(26,35,50,0.06)',
          background: C.bg, overflow: 'hidden',
          // スクロール追従: 見積エディタを下にスクロールしても右パネルが追従
          position: 'sticky', top: 12, alignSelf: 'flex-start',
          maxHeight: 'calc(100dvh - 24px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', height: 52, borderBottom: HDIV, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1A2E24', fontFamily: FONT }}>見積書を取り込む</span>
            <button
              onClick={() => setShowImportModal(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: 4, display: 'flex', borderRadius: 6 }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <EstimateImportTab projectId={projectId} />
          </div>
        </div>
      )}
    </div>

    {/* ── Rev履歴パネル ── */}
    {showRevHistory && (
      <div style={{
        background: '#FDFCFF', borderTop: '1px solid #DDD5F0',
        padding: '16px 20px', fontFamily: FONT,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#5B21B6' }}>改訂履歴</span>
          <span style={{ fontSize: 11, color: C.textMuted }}>クリックで現在との差分を確認</span>
        </div>
        {revisions.length === 0 ? (
          <p style={{ fontSize: 12, color: C.textMuted, margin: 0 }}>まだRevが確定されていません</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {revisions.map(rev => (
              <button
                key={rev.id}
                onClick={() => handleViewRevDiff(rev)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderRadius: 8,
                  border: '1px solid #DDD5F0', background: '#fff',
                  cursor: 'pointer', textAlign: 'left', width: '100%',
                  fontFamily: FONT,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, color: '#5B21B6', minWidth: 48 }}>
                  Rev.{rev.rev_number}
                </span>
                {rev.label && (
                  <span style={{ fontSize: 12, color: C.textSub, flex: 1 }}>{rev.label}</span>
                )}
                <span style={{ fontSize: 12, color: C.textMuted, flex: rev.label ? 0 : 1 }}>
                  {new Date(rev.created_at).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                {rev.total != null && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums' }}>
                    ¥{fmt(rev.total)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    )}

    {/* ── Rev確定確認ダイアログ ── */}
    {showRevConfirm && createPortal(
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={e => { if (e.target === e.currentTarget) { setShowRevConfirm(false); setRevLabel('') } }}
      >
        <div style={{ background: '#fff', borderRadius: 14, padding: '28px 28px 24px', width: 380, boxShadow: '0 8px 40px rgba(91,33,182,0.18)', fontFamily: FONT }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#3B1B80', margin: '0 0 6px' }}>
            Rev.{(revisions[0]?.rev_number ?? 0) + 1} として確定
          </h2>
          <p style={{ fontSize: 12, color: C.textMuted, margin: '0 0 18px', lineHeight: 1.6 }}>
            現在の見積内容をスナップショットとして保存します。<br/>
            内訳は変更されません。
          </p>
          <div style={{ marginBottom: 18 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#7C5CB8', display: 'block', marginBottom: 6 }}>ラベル（任意）</label>
            <input
              autoFocus
              value={revLabel}
              onChange={e => setRevLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateRevision() }}
              placeholder="例：初版、設計変更1回目、追加工事後"
              style={{ width: '100%', border: '1.5px solid #DDD5F0', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: C.text, outline: 'none', boxSizing: 'border-box', fontFamily: FONT }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => { setShowRevConfirm(false); setRevLabel('') }}
              style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1.5px solid #DDD5F0', background: '#fff', color: C.textMuted, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
              キャンセル
            </button>
            <button onClick={handleCreateRevision} disabled={savingRev}
              style={{ flex: 2, padding: '9px', borderRadius: 8, border: 'none', background: savingRev ? '#C4B3E8' : '#5B21B6', color: '#fff', fontSize: 13, fontWeight: 700, cursor: savingRev ? 'default' : 'pointer', fontFamily: FONT }}>
              {savingRev ? '保存中…' : '確定する'}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}

    {/* ── Rev差分モーダル ── */}
    {revDiff && createPortal(
      <RevDiffModal
        rev={revDiff}
        currentItems={items}
        fmt={fmt}
        onClose={() => setRevDiff(null)}
        fontFamily={FONT}
      />,
      document.body
    )}

    {/* ── ドラッグ作成ゴースト＆インジケーター ── */}
    {dragCreate && (
      <>
        {/* カーソル追随バッジ */}
        <div style={{
          position: 'fixed',
          left: dragCreate.x + 16,
          top: dragCreate.y - 14,
          zIndex: 9999,
          pointerEvents: 'none',
          background: C.accent,
          color: '#fff',
          padding: '5px 14px',
          borderRadius: 20,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: FONT,
          boxShadow: `0 4px 16px rgba(22,114,236,0.45)`,
          whiteSpace: 'nowrap',
          transform: 'rotate(-2deg)',
        }}>
          ＋ {dragCreate.rowType === 'header' ? '見出し行' : dragCreate.rowType === 'note' ? 'メモ行' : '行'}
        </div>
        {/* 挿入位置インジケーターライン */}
        {dragCreate.indicator && (
          <div style={{
            position: 'fixed',
            left: 0,
            right: 0,
            top: dragCreate.indicator.y - 2,
            height: 4,
            zIndex: 9998,
            pointerEvents: 'none',
            background: C.accent,
            borderRadius: 2,
            opacity: 0.85,
          }} />
        )}
      </>
    )}

    </GridColsCtx.Provider>
  )
}

// ── 共有スタイル ──────────────────────────────────────────

const st = {
  dragCell: {
    display: 'flex', alignItems: 'center',
    justifyContent: 'flex-start', height: '100%',
    userSelect: 'none' as const, width: 52, flexShrink: 0,
  } as React.CSSProperties,

  expandBtn: {
    width: 22, height: 22, borderRadius: 4,
    border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  } as React.CSSProperties,

  tbBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 32, padding: '0 14px', borderRadius: 7,
    border: `1px solid ${C.divider}`, background: C.bg,
    color: C.textSub, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: FONT, transition: 'background 0.1s, border-color 0.1s',
  } as React.CSSProperties,

  tbAccent: {
    background: '#E3EFE7', color: '#2B5E40', border: '1px solid #BDD1C3',
  } as React.CSSProperties,

  tbBtnHeader: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 32, padding: '0 11px', borderRadius: 7,
    border: `1px solid #8BA3D9`, background: '#EEF1F8',
    color: '#2B3A5C', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: FONT,
  } as React.CSSProperties,

  tbBtnNote: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 32, padding: '0 11px', borderRadius: 7,
    border: `1px solid #C9A84C`, background: '#FEFAED',
    color: '#7A5A00', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: FONT,
  } as React.CSSProperties,
} as const
