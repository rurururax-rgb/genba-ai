'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import {
  DragDropContext, Droppable, Draggable,
  type DropResult, type DraggableProvidedDragHandleProps,
} from '@hello-pangea/dnd'
import { getClient } from '@/lib/supabase/client'

// ── 型定義 ────────────────────────────────────────────────

type EstimateGroup = {
  id: string
  label: string
  display_mode: 'detailed' | 'lump_sum'
  sort_order: number
}

type EstimateItem = {
  id: string
  name: string
  quantity: number
  unit: string
  selling_price: number | null
  amount: number | null
  cost_price: number | null
  vendor_name: string | null
  group_id: string | null
  sort_order: number
  source: string
  line_event_id: string | null
  memo: string | null
}

type ItemPatch = {
  name?: string
  quantity?: number
  unit?: string
  selling_price?: number | null
  cost_price?: number | null
  vendor_name?: string | null
  memo?: string | null
}

// ── デザイントークン ──────────────────────────────────────

const C = {
  pageBg:      '#F8F9FB',
  bg:          '#FFFFFF',
  groupBg:     '#F4F5F7',
  hover:       '#F5F7FA',
  divider:     '#E5E7EB',
  accent:      '#2D6FF6',
  accentLight: '#EBF1FF',
  text:        '#1F2937',
  textSub:     '#374151',
  textMuted:   '#6B7280',
  green:       '#0C7A4A',
  orange:      '#D97706',
  red:         '#D12953',
  redBg:       '#FFF0F4',
  internalBg:  '#FAFAFA',
} as const

// GroupSubtotal の3段階グレー（C.divider を基準に C.textMuted 方向へ暗くする）
// color-mix() 非対応ブラウザ向けに事前計算したhexをフォールバックとして持つ
// - SUBTOTAL_CELL_BG   : divider 88% + textMuted 12% ≈ #D6D9DE
// - SUBTOTAL_BORDER    : divider 65% + textMuted 35% ≈ #BABEc6
const _cmixOk =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('background', 'color-mix(in srgb, red, blue)')
const SUBTOTAL_CELL_BG     = _cmixOk ? `color-mix(in srgb, ${C.divider} 88%, ${C.textMuted})` : '#D6D9DE'
const SUBTOTAL_BORDER_COLOR = _cmixOk ? `color-mix(in srgb, ${C.divider} 65%, ${C.textMuted})` : '#BABEc6'

const FONT      = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const ROW_H     = 56
const HEAD_H    = 44
const GRP_H     = 52
const HDIV      = '1px solid #F0F0F0'
const MARGIN_WARN = 0.15
// サマリーバーの固定高さ（テーブルの sticky header の top オフセットに使用）
// 上段(52) + 区切り(1) + 下段(51) ≈ 104
const SUMMARY_H = 104

// selling_price 変更の楽観的更新に対応するため、クライアント側で amount を再計算するヘルパー
function liveAmount(item: { quantity: number; selling_price: number | null; amount: number | null }): number {
  return item.selling_price != null ? Math.round(item.quantity * item.selling_price) : (item.amount ?? 0)
}

// ── カラム定義（react-table + CSS grid の共通ソース）────────

type ColMeta = { group: 'estimate' | 'internal' | null; align: 'left' | 'center' | 'right'; gridSize?: string }

const COL_DEFS: Array<{ id: string; label: string; size: number; meta: ColMeta }> = [
  { id: 'drag',          label: '',       size: 28,  meta: { group: null,       align: 'left'   } },
  { id: 'name',          label: '名　称', size: 220, meta: { group: null,       align: 'left',   gridSize: 'minmax(200px,2fr)' } },
  { id: 'quantity',      label: '数量',   size: 60,  meta: { group: null,       align: 'right'  } },
  { id: 'unit',          label: '単位',   size: 52,  meta: { group: null,       align: 'center' } },
  { id: 'selling_price', label: '単　価', size: 124, meta: { group: 'estimate', align: 'right'  } },
  { id: 'amount',        label: '金　額', size: 136, meta: { group: 'estimate', align: 'right'  } },
  { id: 'memo',          label: '備　考', size: 120, meta: { group: 'estimate', align: 'left',   gridSize: 'minmax(80px,1fr)' } },
  { id: 'vendor_name',   label: '業者名', size: 120, meta: { group: 'internal', align: 'left'  } },
  { id: 'cost_price',    label: '原　価', size: 116, meta: { group: 'internal', align: 'right'  } },
  { id: 'margin',        label: '粗利率', size: 64,  meta: { group: 'internal', align: 'right'  } },
  { id: 'actions',       label: '',       size: 68,  meta: { group: null,       align: 'center' } },
]

const GRID_COLS    = COL_DEFS.map(c => c.meta.gridSize ?? `${c.size}px`).join(' ')
const ESTIMATE_CNT = COL_DEFS.filter(c => c.meta.group === 'estimate').length  // 3
const INTERNAL_CNT = COL_DEFS.filter(c => c.meta.group === 'internal').length  // 3
// before estimate group: drag + name + quantity + unit = 4 cols
const PRE_EST_CNT  = COL_DEFS.findIndex(c => c.meta.group === 'estimate')      // 4

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
      <circle cx="2.5" cy="3"  r="1.5" fill={C.divider} />
      <circle cx="2.5" cy="7"  r="1.5" fill={C.divider} />
      <circle cx="2.5" cy="11" r="1.5" fill={C.divider} />
      <circle cx="7.5" cy="3"  r="1.5" fill={C.divider} />
      <circle cx="7.5" cy="7"  r="1.5" fill={C.divider} />
      <circle cx="7.5" cy="11" r="1.5" fill={C.divider} />
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
  value, onChange, placeholder = '─', align = 'right', muted = false,
}: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  align?: 'left' | 'right'
  muted?: boolean
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
        ref={ref} autoFocus type="number" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit() }
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        style={{
          width: '100%', height: 30,
          border: `1.5px solid ${C.accent}`, borderRadius: 5,
          padding: '0 8px', fontSize: 13, textAlign: align,
          fontFamily: FONT, outline: 'none', background: C.bg,
          color: C.text, fontVariantNumeric: 'tabular-nums',
          boxShadow: `0 0 0 3px ${C.accent}20`,
        }}
      />
    )
  }

  return (
    <div onClick={start} style={{
      width: '100%', padding: '0 8px',
      fontSize: 13, textAlign: align,
      color: value != null ? C.textSub : C.textMuted,
      fontWeight: value != null && !muted ? 600 : undefined,
      fontStyle: value == null ? 'italic' : undefined,
      opacity: value == null ? 0.45 : 1,
      cursor: 'text', fontVariantNumeric: 'tabular-nums',
      fontFamily: FONT, lineHeight: `${ROW_H}px`,
    }}>
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
        width: '100%', border: 'none', background: 'transparent',
        fontSize: 13, color: C.textSub, fontFamily: FONT,
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
          width: '100%', height: 30,
          border: `1.5px solid ${C.accent}`, borderRadius: 5,
          padding: '0 8px', fontSize: 12, fontFamily: FONT,
          outline: 'none', background: C.bg, color: C.text,
          boxShadow: `0 0 0 3px ${C.accent}20`,
        }}
      />
    )
  }

  return (
    <div onClick={start} style={{
      width: '100%', padding: '0 8px',
      fontSize: 12, color: value != null ? C.textSub : C.textMuted,
      fontStyle: value == null ? 'italic' : undefined,
      opacity: value == null ? 0.45 : 1,
      cursor: 'text', fontFamily: FONT, lineHeight: `${ROW_H}px`,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>
      {value ?? placeholder}
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
        height: 28, padding: '0 16px', borderRadius: 999,
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

// ── DetailCell ────────────────────────────────────────────
// サマリーバー下段の読み取り専用セル

function DetailCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      flex: 1, minWidth: 110, padding: '8px 16px', gap: 2,
      background: C.bg, border: `1px solid ${C.divider}`, borderRadius: 8,
    }}>
      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: FONT, whiteSpace: 'nowrap', letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
        {label}
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, color: color ?? C.textSub, fontFamily: FONT, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {value}
      </span>
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
          ref={ref} autoFocus type="number" value={draft}
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
}: {
  group: EstimateGroup; groupIndex: number; expanded: boolean
  onToggle: () => void; onLabelChange: (l: string) => void
  onDisplayModeToggle: () => void; onDelete: () => void; onDeleteEmpty: () => void
  dragHandleProps: DraggableProvidedDragHandleProps | null
  hovered: boolean; subtotal: number; isNew?: boolean
}) {
  const [editingLabel, setEditingLabel] = useState(isNew ?? false)
  const [labelDraft,   setLabelDraft]   = useState(group.label)

  function commitLabel() {
    setEditingLabel(false)
    const trimmed = labelDraft.trim()
    if (!trimmed && isNew) { onDeleteEmpty(); return }
    if (trimmed !== group.label) onLabelChange(trimmed)
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: GRID_COLS,
      alignItems: 'center', height: GRP_H,
      background: '#E8EBF0',
      borderBottom: `1px solid ${C.divider}`,
    }}>
      <div {...(dragHandleProps ?? {})} style={{ ...st.dragCell, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}><GripIcon /></div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 12, overflow: 'hidden' }}>
        <button onClick={onToggle} style={st.expandBtn}><ChevronIcon open={expanded} /></button>
        <span style={{
          fontSize: 10, fontWeight: 700, color: C.textMuted,
          background: C.bg, border: `1px solid ${C.divider}`,
          padding: '1px 6px', borderRadius: 4,
          letterSpacing: '0.04em', flexShrink: 0,
        }}>
          {String(groupIndex + 1).padStart(2, '0')}
        </span>
        {editingLabel ? (
          <input autoFocus value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={e => {
              if (e.key === 'Enter') commitLabel()
              if (e.key === 'Escape') { setLabelDraft(group.label); setEditingLabel(false) }
              e.stopPropagation()
            }}
            style={{
              flex: 1, border: `1.5px solid ${C.accent}`, borderRadius: 5,
              padding: '3px 8px', fontSize: 13, fontWeight: 600,
              fontFamily: FONT, outline: 'none', background: C.bg, color: C.text,
              boxShadow: `0 0 0 3px ${C.accent}20`,
            }}
          />
        ) : (
          <span onClick={() => { setLabelDraft(group.label); setEditingLabel(true) }}
            style={{ flex: 1, fontSize: 13, fontWeight: 700, color: C.text, cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
            {group.label || '（工種名を入力）'}
          </span>
        )}
      </div>

      {/* quantity, unit, selling_price */}
      <div /><div /><div />

      {/* amount: 折りたたみ時に小計表示 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 12 }}>
        {!expanded && subtotal > 0 && (
          <span style={{ fontSize: 13, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
            ¥{fmt(subtotal)}
          </span>
        )}
      </div>

      {/* memo */}
      <div />

      {/* 内部専用列（空・グレー背景） */}
      <div style={{ background: C.internalBg, height: '100%' }} />
      <div style={{ background: C.internalBg, height: '100%' }} />
      <div style={{ background: C.internalBg, height: '100%' }} />

      {/* 操作 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6, gap: 4, flexShrink: 0, flexWrap: 'nowrap', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
        <button onClick={onDisplayModeToggle}
          title={group.display_mode === 'detailed' ? '一括表示に切替' : '明細表示に切替'}
          style={{
            height: 20, padding: '0 5px', borderRadius: 4, border: 'none',
            fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
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
  const margin = total > 0 && costTotal > 0 ? 1 - costTotal / total : null
  return (
    // suppressHydrationWarning: SUBTOTAL_CELL_BG / SUBTOTAL_BORDER_COLOR は
    // SSR（CSS未定義）とクライアント（color-mix対応ブラウザ）で値が異なる場合があるため抑制
    <div suppressHydrationWarning style={{
      display: 'grid', gridTemplateColumns: GRID_COLS,
      alignItems: 'center', height: 52,
      background: C.divider,
      borderTop: `2px solid ${SUBTOTAL_BORDER_COLOR}`,
    }}>
      <div />
      <div style={{ paddingLeft: 52, fontSize: 12, fontWeight: 700, color: C.textSub, fontFamily: FONT, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
        小計
      </div>
      <div /><div /><div />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 16, fontWeight: 700, fontSize: 14, color: C.text, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
        ¥{fmt(total)}
      </div>
      <div />
      {/* 業者名 */}
      <div suppressHydrationWarning style={{ background: SUBTOTAL_CELL_BG, height: '100%' }} />
      {/* 原価合計 */}
      <div suppressHydrationWarning style={{
        background: SUBTOTAL_CELL_BG, height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8,
        fontSize: 12, fontWeight: 600, color: C.textSub, fontVariantNumeric: 'tabular-nums', fontFamily: FONT,
      }}>
        {costTotal > 0 ? `¥${fmt(costTotal)}` : ''}
      </div>
      {/* 粗利率 */}
      <div suppressHydrationWarning style={{
        background: SUBTOTAL_CELL_BG, height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 16,
        fontSize: 11, fontWeight: 700,
        color: margin != null ? (margin < 0.15 ? C.red : C.green) : C.textMuted,
        fontFamily: FONT,
      }}>
        {margin != null ? `${(margin * 100).toFixed(1)}%` : ''}
      </div>
      <div />
    </div>
  )
}

// ── FIELD_ORDER（Tab キーナビ用）──────────────────────────

const FIELD_ORDER = ['name', 'quantity', 'unit', 'selling_price', 'memo', 'vendor_name', 'cost_price'] as const

// ── ItemRow ───────────────────────────────────────────────

function ItemRow({
  item, inGroup, isDragging, dragHandleProps,
  onSave, onDelete, deleting, rowIndex, onAddAfter,
}: {
  item: EstimateItem; inGroup: boolean; isDragging: boolean
  dragHandleProps: DraggableProvidedDragHandleProps | null
  onSave: (c: ItemPatch) => Promise<void>; onDelete: () => void
  deleting: boolean; rowIndex: number; onAddAfter?: () => void
}) {
  const [editField, setEditField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [hovered,   setHovered]   = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const rowBg = isDragging ? C.accentLight : hovered ? C.hover : C.bg

  function startEdit(field: string, raw: string) {
    setEditField(field); setEditValue(raw)
    if (field === 'name') setTimeout(() => nameRef.current?.select(), 0)
  }

  async function commitEdit(field: string) {
    setEditField(null)
    const changes: ItemPatch = {}
    if (field === 'name') {
      const v = editValue.trim()
      if (v && v !== item.name) changes.name = v
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
            name: item.name, quantity: String(item.quantity), unit: item.unit,
            selling_price: item.selling_price != null ? String(item.selling_price) : '',
            memo: item.memo ?? '', vendor_name: item.vendor_name ?? '',
            cost_price: item.cost_price != null ? String(item.cost_price) : '',
          }
          setEditField(next); setEditValue(map[next] ?? '')
        }
      })
      return
    }
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); commitEdit(field); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditField(null); return }
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
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
    <div
      style={{
        display: 'grid', gridTemplateColumns: GRID_COLS,
        alignItems: 'center', height: ROW_H,
        background: rowBg,
        transition: 'background 0.08s',
        outline: isDragging ? `1.5px solid ${C.accent}` : undefined,
        outlineOffset: isDragging ? -1 : undefined,
      }}
    >
      {/* ドラッグ */}
      <div {...(dragHandleProps ?? {})}
        style={{ ...st.dragCell, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
        <GripIcon />
      </div>

      {/* 名称 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        paddingLeft: inGroup ? 36 : 16, paddingRight: 12, height: '100%', overflow: 'hidden',
      }}>
        {inGroup && (
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ flexShrink: 0 }}>
            <path d="M2 0v6a2 2 0 002 2h6" stroke={C.divider} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        )}
        {editField === 'name' ? (
          <input ref={nameRef} autoFocus value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={() => commitEdit('name')}
            onKeyDown={e => handleKey(e, 'name')}
            style={{
              flex: 1, border: `1.5px solid ${C.accent}`, borderRadius: 5,
              padding: '2px 8px', fontSize: 14, fontWeight: 500,
              fontFamily: FONT, outline: 'none', background: C.bg, color: C.text,
              boxShadow: `0 0 0 3px ${C.accent}20`,
            }}
          />
        ) : (
          <span onDoubleClick={() => startEdit('name', item.name)} title="ダブルクリックで編集"
            style={{ flex: 1, fontSize: 13, fontWeight: 400, color: C.textSub, cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
            {item.name}
          </span>
        )}
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
          placeholder="未設定" />
      </div>

      {/* 金額（読み取り専用） */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        paddingRight: 16, fontSize: 13, fontWeight: liveAmt != null ? 700 : undefined,
        color: liveAmt != null ? C.green : C.textMuted,
        fontStyle: liveAmt == null ? 'italic' : undefined,
        opacity: liveAmt == null ? 0.45 : 1,
        fontVariantNumeric: 'tabular-nums', fontFamily: FONT,
      }}>
        {liveAmt != null ? `¥${fmt(liveAmt)}` : '─'}
      </div>

      {/* 備考 */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, overflow: 'hidden' }}>
        {editField === 'memo' ? (
          <input autoFocus value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={() => commitEdit('memo')}
            onKeyDown={e => handleKey(e, 'memo')}
            style={{
              flex: 1, border: `1.5px solid ${C.accent}`, borderRadius: 5,
              padding: '2px 8px', fontSize: 12,
              fontFamily: FONT, outline: 'none', background: C.bg, color: C.text,
            }}
          />
        ) : (
          <span onClick={() => startEdit('memo', item.memo ?? '')}
            style={{ flex: 1, fontSize: 12, color: item.memo ? C.textSub : C.textMuted, cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT,
              fontStyle: item.memo ? undefined : 'italic',
              opacity: item.memo ? 1 : 0.45,
            }}>
            {item.memo || '─'}
          </span>
        )}
      </div>

      {/* 業者名（内部専用） */}
      <div style={{ display: 'flex', alignItems: 'center', background: C.internalBg, paddingLeft: 4, paddingRight: 4, height: '100%', overflow: 'hidden' }}>
        <TextInput value={item.vendor_name}
          onChange={v => { if (v !== item.vendor_name) onSave({ vendor_name: v }) }} />
      </div>

      {/* 原価（内部専用） */}
      <div style={{ display: 'flex', alignItems: 'center', background: C.internalBg, height: '100%', justifyContent: 'flex-end' }}>
        <NumInput value={item.cost_price}
          onChange={v => { if (v !== item.cost_price) onSave({ cost_price: v }) }}
          placeholder="─" muted />
      </div>

      {/* 粗利率（内部専用） */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        background: C.internalBg, height: '100%',
        paddingRight: 16,
        fontSize: 12, fontWeight: 600, fontFamily: FONT,
        fontVariantNumeric: 'tabular-nums',
        color: margin == null ? C.textMuted : warnMargin ? C.red : C.green,
        fontStyle: margin == null ? 'italic' : undefined,
        opacity: margin == null ? 0.45 : 1,
      }}>
        {margin != null ? `${(margin * 100).toFixed(1)}%` : '─'}
      </div>

      {/* 削除 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
        <DeleteBtn onClick={onDelete} disabled={deleting} />
      </div>
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
          borderRadius: 999,
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
          boxShadow: '0 1px 4px rgba(45,111,246,0.35)',
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        追加
      </button>
    )}
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

  const reload = useCallback(() => {
    setLoading(true)
    Promise.all([
      supabase.from('estimate_groups').select('id,label,display_mode,sort_order')
        .eq('project_id', projectId).is('deleted_at', null).order('sort_order'),
      supabase.from('estimate_items')
        .select('id,name,quantity,unit,selling_price,amount,cost_price,vendor_name,group_id,sort_order,source,line_event_id,memo')
        .eq('project_id', projectId).is('deleted_at', null).order('sort_order'),
      supabase.from('projects')
        .select('misc_expense_override,rounding_discount')
        .eq('id', projectId).single(),
    ]).then(([{ data: g }, { data: i }, { data: p }]) => {
      setGroups((g ?? []) as EstimateGroup[])
      setItems((i ?? []) as EstimateItem[])
      if (p) {
        setMiscExpenseOverride((p as { misc_expense_override: number | null }).misc_expense_override ?? null)
        setRoundingDiscount((p as { rounding_discount: number | null }).rounding_discount ?? 0)
      }
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

  const subtotal      = useMemo(() => items.reduce((acc, i) => acc + liveAmount(i), 0), [items])
  const totalCost     = useMemo(() => items.reduce((acc, i) => acc + ((i.cost_price ?? 0) * i.quantity), 0), [items])
  const grossProfit   = subtotal - totalCost
  const overallMargin = subtotal > 0 && totalCost > 0 ? 1 - totalCost / subtotal : null
  // 諸経費: 手動上書きがあればその値、なければ小計×8%
  const miscExpense   = miscExpenseOverride != null ? miscExpenseOverride : Math.round(subtotal * 0.08)
  const taxBase       = subtotal + miscExpense - roundingDiscount
  const tax           = Math.floor(taxBase * 0.1)
  const total         = taxBase + tax

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
    const { source, destination, type } = result
    if (!destination) return

    if (type === 'GROUP') {
      if (source.index === destination.index) return
      const ng = reorder(visibleGroups, source.index, destination.index)
        .map((g, i) => ({ ...g, sort_order: i * 1000 }))
      setGroups(prev => prev.map(g => ng.find(x => x.id === g.id) ?? g))
      persistReorder(ng.map(g => ({ id: g.id, sort_order: g.sort_order })), [])
      return
    }

    if (type === 'ITEM') {
      const srcGid = source.droppableId === 'ungrouped' ? null : source.droppableId.replace('group-', '')
      const dstGid = destination.droppableId === 'ungrouped' ? null : destination.droppableId.replace('group-', '')
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

  async function handleAddRow(groupId?: string | null, insertAfterItem?: EstimateItem) {
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
        body: JSON.stringify({ project_id: projectId, sort_order: newOrder, group_id: groupId ?? null }),
      })
      if (res.ok) { const item = await res.json() as EstimateItem; setItems(prev => [...prev, item]) }
    } finally { setAddingRow(false) }
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, padding: 12 }}>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        borderRadius: 8, overflow: 'clip',
        border: `1px solid ${C.divider}`,
        background: C.bg,
      }}>

        {/* ── ツールバー ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 16px', height: 52,
          background: C.bg, borderBottom: HDIV,
        }}>
          <button style={st.tbBtn} onClick={() => handleAddRow()} disabled={addingRow}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            行を追加
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
          <button style={st.tbBtn} onClick={() => window.dispatchEvent(new CustomEvent('genba:open-import-panel'))}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            見積書を取り込む
          </button>
          <div style={{ width: 1, height: 18, background: C.divider }} />
          <a href={`/projects/${projectId}/estimate`} target="_blank" rel="noreferrer"
            style={{ ...st.tbBtn, ...st.tbAccent, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            見積書を表示
          </a>
        </div>

        {/* ── 合計バー（ツールバー直下 sticky 固定・2段構成）── */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 20,
          background: C.bg,
          borderBottom: `1px solid ${C.divider}`,
          boxShadow: '0 3px 10px rgba(14,23,41,0.08)',
        }}>

          {/* 上段: 合計（税込） と 全体粗利率 を大きく強調 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 24px', height: 52,
            background: C.bg,
          }}>
            {/* 合計（税込） */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                合計（税込）
              </span>
              <span style={{ fontSize: 26, fontWeight: 700, color: C.green, fontFamily: FONT, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>
                ¥{fmt(total)}
              </span>
            </div>
            {/* 全体粗利率 */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                全体粗利率
              </span>
              <span style={{
                fontSize: 26, fontWeight: 700, fontFamily: FONT, fontVariantNumeric: 'tabular-nums',
                color: overallMargin != null
                  ? (overallMargin < 0.15 ? C.red : overallMargin < 0.30 ? C.orange : C.green)
                  : C.textMuted,
              }}>
                {overallMargin != null ? `${(overallMargin * 100).toFixed(1)}%` : '─'}
              </span>
            </div>
          </div>

          {/* 区切り線 */}
          <div style={{ height: 1, background: C.divider }} />

          {/* 下段: 6項目をカード形式で横並び */}
          <div style={{
            display: 'flex', alignItems: 'stretch', gap: 8,
            background: C.groupBg,
            flexWrap: 'wrap',
            padding: '8px 16px',
          }}>
            <DetailCell label="小計" value={`¥${fmt(subtotal)}`} />
            <DetailCell label="原価合計" value={`¥${fmt(totalCost)}`} />
            <DetailCell label="見積時粗利高" value={`¥${fmt(grossProfit)}`} />
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
            <DetailCell label="消費税（10%）" value={`¥${fmt(tax)}`} />
          </div>

        </div>

        {/* ── テーブル ── */}
        <div style={{ overflowX: 'auto', flex: 1 }}>
          <div style={{ minWidth: 1000 }}>

            {/* ── 2段ヘッダー（sticky でまとめてスクロール追従） ── */}
            <div style={{ position: 'sticky', top: SUMMARY_H, zIndex: 10 }}>

              {/* 段1: グループラベル行 */}
              <div style={{
                display: 'grid', gridTemplateColumns: GRID_COLS,
                background: C.groupBg, borderBottom: `1px solid ${C.divider}`,
                fontFamily: FONT,
              }}>
                {/* drag */}
                <div style={{ height: 28 }} />
                {/* name + quantity + unit */}
                <div style={{ height: 28, gridColumn: `span ${PRE_EST_CNT - 1}` }} />
                {/* 見積情報 */}
                <div style={{
                  height: 28, gridColumn: `span ${ESTIMATE_CNT}`,
                  display: 'flex', alignItems: 'center', paddingLeft: 10,
                  fontSize: 9, fontWeight: 700, color: C.textMuted,
                  letterSpacing: '0.10em', textTransform: 'uppercase',
                }}>
                  見積情報
                </div>
                {/* INTERNAL */}
                <div style={{
                  height: 28, gridColumn: `span ${INTERNAL_CNT}`,
                  display: 'flex', alignItems: 'center', paddingLeft: 10,
                  fontSize: 9, fontWeight: 700, color: C.textMuted,
                  letterSpacing: '0.10em', textTransform: 'uppercase',
                  background: C.internalBg,
                }}>
                  内部専用
                </div>
                {/* actions */}
                <div style={{ height: 28 }} />
              </div>

              {/* 段2: リーフ列ヘッダー（react-table が生成） */}
              <div style={{
                display: 'grid', gridTemplateColumns: GRID_COLS,
                background: C.groupBg, borderBottom: `1px solid ${C.divider}`,
                fontFamily: FONT,
              }}>
                {leafHeaderGroup?.headers.map(header => {
                  const def        = COL_DEFS.find(c => c.id === header.id)
                  const isInternal = def?.meta.group === 'internal'
                  const align      = def?.meta.align ?? 'left'
                  return (
                    <div key={header.id} style={{
                      padding: '0 8px', height: HEAD_H,
                      display: 'flex', alignItems: 'center',
                      justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
                      fontSize: 10, fontWeight: 500,
                      color: C.textMuted,
                      letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
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
            <div style={{ background: '#F5F6F8', paddingTop: 16, paddingBottom: 16 }}>
            <DragDropContext onDragEnd={handleDragEnd}>

              {/* グループ */}
              <Droppable droppableId="group-list" type="GROUP">
                {provided => (
                  <div ref={provided.innerRef} {...provided.droppableProps}>
                    {visibleGroups.map((group, gi) => {
                      const gItems    = itemsForGroup(group.id)
                      const gTotal    = gItems.reduce((acc, i) => acc + liveAmount(i), 0)
                      const gCostTotal = gItems.reduce((acc, i) => acc + ((i.cost_price ?? 0) * i.quantity), 0)
                      const isOpen    = !collapsed[group.id]

                      return (
                        <Draggable key={group.id} draggableId={`group-${group.id}`} index={gi}>
                          {(prov, snap) => (
                            <div ref={prov.innerRef} {...prov.draggableProps}
                              style={{
                                ...prov.draggableProps.style,
                                borderRadius: 12,
                                overflow: 'hidden',
                                border: `1px solid ${C.divider}`,
                                boxShadow: snap.isDragging
                                  ? `0 6px 24px ${C.accent}22`
                                  : '0 2px 8px rgba(0,0,0,0.08)',
                                marginBottom: 24,
                              }}
                              onMouseEnter={() => setHoveredGroup(group.id)}
                              onMouseLeave={() => setHoveredGroup(null)}>
                              <GroupHeader
                                group={group} groupIndex={gi} expanded={isOpen}
                                onToggle={() => toggleCollapsed(group.id)}
                                onLabelChange={l => handleGroupLabelChange(group.id, l)}
                                onDisplayModeToggle={() => handleDisplayModeToggle(group.id)}
                                onDelete={() => handleDeleteGroup(group.id)}
                                onDeleteEmpty={() => handleDeleteEmptyGroup(group.id)}
                                dragHandleProps={prov.dragHandleProps}
                                hovered={hoveredGroup === group.id} subtotal={gTotal}
                                isNew={group.id === newlyCreatedGroupId}
                              />

                              {isOpen && group.display_mode !== 'lump_sum' && (
                                <Droppable droppableId={`group-${group.id}`} type="ITEM">
                                  {(dp, ds) => (
                                    <div ref={dp.innerRef} {...dp.droppableProps}
                                      style={{ minHeight: 32, background: ds.isDraggingOver ? `${C.accent}08` : 'transparent', transition: 'background 0.12s' }}>
                                      {gItems.map((item, idx) => (
                                        <Draggable key={item.id} draggableId={`item-${item.id}`} index={idx}>
                                          {(ip, is) => (
                                            <div ref={ip.innerRef} {...ip.draggableProps} style={ip.draggableProps.style}>
                                              <ItemRow item={item} inGroup isDragging={is.isDragging}
                                                dragHandleProps={ip.dragHandleProps}
                                                onSave={c => handleSave(item.id, c)}
                                                onDelete={() => handleDelete(item.id)}
                                                deleting={!!deleting[item.id]} rowIndex={idx}
                                                onAddAfter={() => handleAddRow(group.id, item)} />
                                            </div>
                                          )}
                                        </Draggable>
                                      ))}
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

                              {isOpen && <GroupSubtotal total={gTotal} itemCount={gItems.length} costTotal={gCostTotal} />}
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
              {ungroupedItems.length > 0 && (
                <>
                  {groups.length > 0 && (
                    <div style={{
                      display: 'grid', gridTemplateColumns: GRID_COLS,
                      height: 44, background: C.groupBg,
                      alignItems: 'center',
                    }}>
                      <div />
                      <div style={{ paddingLeft: 16, fontSize: 10, fontWeight: 800, color: C.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' as const, fontFamily: FONT }}>
                        その他
                      </div>
                      <div/><div/><div/><div/><div/>
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div style={{ background: C.internalBg, height: '100%' }} />
                      <div/>
                    </div>
                  )}
                  <Droppable droppableId="ungrouped" type="ITEM">
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
                                  onAddAfter={() => handleAddRow(null, item)} />
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
    </div>
  )
}

// ── 共有スタイル ──────────────────────────────────────────

const st = {
  dragCell: {
    cursor: 'grab', display: 'flex', alignItems: 'center',
    justifyContent: 'center', height: '100%',
    userSelect: 'none' as const, width: 28,
  } as React.CSSProperties,

  expandBtn: {
    width: 22, height: 22, borderRadius: 4,
    border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  } as React.CSSProperties,

  tbBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 34, padding: '0 16px', borderRadius: 999,
    border: `1px solid ${C.divider}`, background: C.bg,
    color: C.textSub, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: FONT, transition: 'all 0.12s',
  } as React.CSSProperties,

  tbAccent: {
    background: C.accent, color: '#fff', border: `1px solid ${C.accent}`,
  } as React.CSSProperties,
} as const
