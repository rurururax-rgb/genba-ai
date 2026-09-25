'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ScheduleItem, ScheduleConflict, ScheduleStatus, SchedulePeriod } from '@/lib/services/schedule'
import { detectScheduleConflicts } from '@/lib/services/schedule'
import { ScheduleTimeline } from './ScheduleTimeline'
import type { AIScheduleDraftItem } from '@/lib/ai/schedule/generate-schedule'
import {
  DEFAULT_CALENDAR,
  type ItemDates,
  type ScheduleCalendarOptions,
} from '@/lib/services/schedule-slots'
import {
  DragDropContext, Droppable, Draggable,
  type DropResult,
} from '@hello-pangea/dnd'

// ── 型 ────────────────────────────────────────────────────

type EstimateGroup = { id: string; name: string }
type ViewMode = 'timeline' | 'list'

type FormState = {
  name:              string
  category:          string
  vendor_name:       string
  assignee:          string
  start_date:        string
  start_period:      SchedulePeriod
  end_date:          string
  end_period:        SchedulePeriod
  status:            ScheduleStatus
  memo:              string
  estimate_group_id: string
}

const EMPTY_FORM: FormState = {
  name: '', category: '', vendor_name: '', assignee: '',
  start_date: '', start_period: 'am',
  end_date:   '', end_period:   'pm',
  status: 'planned', memo: '', estimate_group_id: '',
}

// ── 定数 ──────────────────────────────────────────────────

const STATUS_LABELS: Record<ScheduleStatus, string> = {
  planned: '予定', confirmed: '確定', in_progress: '施工中', done: '完了', delayed: '遅延',
}

const STATUS_COLORS: Record<ScheduleStatus, { bg: string; color: string }> = {
  planned:    { bg: '#EFF6FF', color: '#1D4ED8' },
  confirmed:  { bg: '#F0FDF4', color: '#15803D' },
  in_progress:{ bg: '#DBEAFE', color: '#1D4ED8' },
  done:       { bg: '#EAF3DE', color: '#3B6D11' },
  delayed:    { bg: '#FEF2F2', color: '#DC2626' },
}

const CATEGORY_OPTIONS = ['大工', '電気', '設備', 'クロス', '塗装', '左官', '外構', '解体', '基礎', 'その他']

// ── アイコン ───────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
    </svg>
  )
}
function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  )
}
function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

// ── スタイル定数 ────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
  marginBottom: 4, marginTop: 12,
}
const selectCls = "h-9 w-full rounded-[8px] border border-[#D5DED8] bg-white px-[10px] text-sm text-[#1A2E24] outline-none hover:border-[#AFC4B5] focus:border-[#2B5E40] focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] cursor-pointer"

const viewToggleBtn: React.CSSProperties = {
  padding: '6px 14px', border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const iconActionBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  padding: '4px 6px', color: '#64748B', borderRadius: 4,
  display: 'inline-flex', alignItems: 'center',
}
const arrowBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 8, color: '#94A3B8', padding: '1px 3px', lineHeight: 1,
}
const thStyle: React.CSSProperties = {
  padding: '9px 8px', fontSize: 11, fontWeight: 600,
  color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em',
  textAlign: 'center',
}

// ── フォームモーダル（追加・編集共用）────────────────────────

function ScheduleFormModal({
  initial,
  estimateGroups,
  title,
  onSave,
  onClose,
}: {
  initial: FormState
  estimateGroups: EstimateGroup[]
  title: string
  onSave: (form: FormState) => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('工程名は必須です'); return }
    if (form.start_date && form.end_date && form.start_date > form.end_date) {
      setError('終了日は開始日以降にしてください'); return
    }
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: '#FFF', borderRadius: 12, padding: 24, width: '100%', maxWidth: 540,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)', maxHeight: '90vh', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#1e3a5f' }}>{title}</h3>
        <form onSubmit={handleSubmit}>
          {/* 工程名 */}
          <label style={labelStyle}>工程名<span style={{ color: '#DC2626' }}>*</span></label>
          <Input inputSize="compact" value={form.name} autoFocus
            onChange={e => set('name', e.target.value)} placeholder="例: 大工工事、電気配線工事" />

          {/* 工種 */}
          <label style={labelStyle}>工種</label>
          <select className={selectCls} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">未設定</option>
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          {/* 業者名 */}
          <label style={labelStyle}>業者名</label>
          <Input inputSize="compact" value={form.vendor_name}
            onChange={e => set('vendor_name', e.target.value)} placeholder="例: 山田建設" />

          {/* 担当者 */}
          <label style={labelStyle}>担当者</label>
          <Input inputSize="compact" value={form.assignee}
            onChange={e => set('assignee', e.target.value)} placeholder="例: 田中" />

          {/* 開始日 + AM/PM */}
          <label style={labelStyle}>開始日・時間帯</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input type="date" inputSize="compact" className="flex-1" value={form.start_date}
              onChange={e => set('start_date', e.target.value)} />
            <select className={selectCls} style={{ width: 80 }} value={form.start_period}
              onChange={e => set('start_period', e.target.value as SchedulePeriod)}>
              <option value="am">AM</option>
              <option value="pm">PM</option>
            </select>
          </div>

          {/* 終了日 + AM/PM */}
          <label style={labelStyle}>終了日・時間帯</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input type="date" inputSize="compact" className="flex-1" value={form.end_date}
              onChange={e => set('end_date', e.target.value)} />
            <select className={selectCls} style={{ width: 80 }} value={form.end_period}
              onChange={e => set('end_period', e.target.value as SchedulePeriod)}>
              <option value="am">AM</option>
              <option value="pm">PM</option>
            </select>
          </div>

          {/* 状態 */}
          <label style={labelStyle}>状態</label>
          <select className={selectCls} value={form.status}
            onChange={e => set('status', e.target.value as ScheduleStatus)}>
            {(Object.entries(STATUS_LABELS) as [ScheduleStatus, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          {/* 見積グループ */}
          {estimateGroups.length > 0 && (
            <>
              <label style={labelStyle}>見積グループ連携</label>
              <select className={selectCls} value={form.estimate_group_id}
                onChange={e => set('estimate_group_id', e.target.value)}>
                <option value="">なし</option>
                {estimateGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </>
          )}

          {/* メモ */}
          <label style={labelStyle}>メモ</label>
          <Textarea
            inputSize="compact"
            value={form.memo} onChange={e => set('memo', e.target.value)}
            placeholder="備考・注意点"
          />

          {error && <p style={{ color: '#DC2626', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── 一覧 行コンポーネント（@hello-pangea/dnd 対応）────────────

function ScheduleRow({
  item, conflicted, provided,
  onEdit, onDelete, onStatusChange,
}: {
  item: ScheduleItem; conflicted: boolean
  provided: import('@hello-pangea/dnd').DraggableProvided
  onEdit: () => void; onDelete: () => void
  onStatusChange: (s: ScheduleStatus) => void
}) {
  const statusStyle = STATUS_COLORS[item.status]
  // @hello-pangea/dnd provides innerRef, draggableProps, and dragHandleProps
  // during render. Passing these values directly to DOM elements is required
  // by the library API and cannot be restructured without breaking drag & drop.
  /* eslint-disable react-hooks/refs */
  return (
    <tr
      ref={provided.innerRef}
      {...provided.draggableProps}
      style={{ borderBottom: '1px solid #F0F2F8', ...provided.draggableProps.style }}
    >
      <td {...provided.dragHandleProps} style={{ padding: '8px 6px', width: 28, textAlign: 'center', cursor: 'grab' }}>
        <span style={{ color: '#CBD5E1', fontSize: 14, userSelect: 'none' }}>⠿</span>
      </td>
      <td style={{ padding: '8px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {conflicted && <span style={{ color: '#F59E0B' }}><WarnIcon /></span>}
          <span style={{ fontSize: 13, fontWeight: 500, color: '#1e3a5f' }}>{item.name}</span>
        </div>
        {item.category && <span style={{ fontSize: 11, color: '#64748B', display: 'block' }}>{item.category}</span>}
      </td>
      <td style={{ padding: '8px', fontSize: 13, color: '#374151' }}>
        <div>{item.vendor_name || '—'}</div>
        {item.assignee && <div style={{ fontSize: 11, color: '#64748B' }}>{item.assignee}</div>}
      </td>
      <td style={{ padding: '8px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>
        {item.start_date ? (
          <div>
            <div>{item.start_date} <span style={{ color: '#94A3B8' }}>{item.start_period?.toUpperCase()}</span></div>
            {item.end_date && (
              <div style={{ color: '#64748B' }}>
                〜 {item.end_date} <span style={{ color: '#94A3B8' }}>{item.end_period?.toUpperCase()}</span>
              </div>
            )}
          </div>
        ) : '—'}
      </td>
      <td style={{ padding: '8px' }}>
        <select value={item.status} onChange={e => onStatusChange(e.target.value as ScheduleStatus)}
          style={{
            background: statusStyle.bg, color: statusStyle.color,
            border: 'none', borderRadius: 4, padding: '3px 6px',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
          {(Object.entries(STATUS_LABELS) as [ScheduleStatus, string][]).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </td>
      <td style={{ padding: '8px', fontSize: 12, color: '#64748B', maxWidth: 140 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.memo || '—'}
        </div>
      </td>
      <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button onClick={onEdit} style={iconActionBtn} title="編集" aria-label="編集"><EditIcon /></button>
        <button onClick={onDelete} style={{ ...iconActionBtn, color: '#DC2626' }} title="削除" aria-label="削除"><TrashIcon /></button>
      </td>
    </tr>
  )
  /* eslint-enable react-hooks/refs */
}

// ── 休業日設定モーダル ─────────────────────────────────────────

function HolidaySettingsModal({
  projectId,
  current,
  onSaved,
  onClose,
}: {
  projectId: string
  current: ScheduleCalendarOptions
  onSaved: (opts: ScheduleCalendarOptions) => void
  onClose: () => void
}) {
  const [nonWorkingWeekdays, setNonWorkingWeekdays] = useState<number[]>(current.nonWorkingWeekdays)
  const [nonWorkingDates,    setNonWorkingDates]    = useState<string[]>(current.nonWorkingDates)
  const [dateInput,          setDateInput]          = useState('')
  const [saving,             setSaving]             = useState(false)
  const [err,                setErr]                = useState<string | null>(null)
  const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']

  const toggleDow = (dow: number) => {
    setNonWorkingWeekdays(prev =>
      prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow],
    )
  }
  const addDate = () => {
    if (!dateInput || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return
    if (!nonWorkingDates.includes(dateInput)) {
      setNonWorkingDates(prev => [...prev, dateInput].sort())
    }
    setDateInput('')
  }
  const removeDate = (d: string) => setNonWorkingDates(prev => prev.filter(x => x !== d))

  const handleSave = async () => {
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/schedule-settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonWorkingWeekdays, nonWorkingDates }),
      })
      if (!res.ok) throw new Error('保存に失敗しました')
      onSaved({ nonWorkingWeekdays, nonWorkingDates })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: '#FFF', borderRadius: 12, padding: 24, width: '100%', maxWidth: 420,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#1e3a5f' }}>
          休業日設定
        </h3>

        <label style={labelStyle}>休業曜日（チェック = 休業）</label>
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
          {DOW_LABELS.map((label, dow) => (
            <label key={dow} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 13, cursor: 'pointer',
              color: nonWorkingWeekdays.includes(dow) ? '#DC2626' : '#374151',
            }}>
              <input type="checkbox" checked={nonWorkingWeekdays.includes(dow)}
                onChange={() => toggleDow(dow)}
                style={{ width: 15, height: 15, cursor: 'pointer' }}
              />
              {label}
            </label>
          ))}
        </div>

        <label style={{ ...labelStyle, marginTop: 16 }}>個別休業日</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input type="date" inputSize="compact" className="flex-1"
            value={dateInput} onChange={e => setDateInput(e.target.value)} />
          <Button type="button" size="sm" variant="primary" onClick={addDate}>追加</Button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {nonWorkingDates.map(d => (
            <span key={d} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 12, padding: '3px 8px', borderRadius: 20,
              background: '#FEE2E2', color: '#991B1B',
            }}>
              {d.slice(5).replace('-', '/')}
              <button onClick={() => removeDate(d)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#991B1B', padding: 0, lineHeight: 1, fontSize: 14,
              }}>×</button>
            </span>
          ))}
          {nonWorkingDates.length === 0 && <span style={{ fontSize: 12, color: '#94A3B8' }}>なし</span>}
        </div>

        {err && <p style={{ color: '#DC2626', fontSize: 13, margin: '8px 0 0' }}>{err}</p>}

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="button" variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── AIモーダル ─────────────────────────────────────────────

function AIScheduleModal({
  defaultCalendar,
  onGenerate,
  onClose,
}: {
  defaultCalendar: ScheduleCalendarOptions
  onGenerate: (startDate: string, conditions: string, nonWorkingWeekdays: number[], nonWorkingDates: string[]) => void
  onClose: () => void
}) {
  const [startDate,          setStartDate]          = useState('')
  const [conditions,         setConditions]         = useState('')
  const [nonWorkingWeekdays, setNonWorkingWeekdays] = useState<number[]>(defaultCalendar.nonWorkingWeekdays)
  const [err,                setErr]                = useState<string | null>(null)

  const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']

  const toggleDow = (dow: number) => {
    setNonWorkingWeekdays(prev =>
      prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow],
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!startDate) { setErr('着工予定日を入力してください'); return }
    onGenerate(startDate, conditions, nonWorkingWeekdays, defaultCalendar.nonWorkingDates)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: '#FFF', borderRadius: 12, padding: 24, width: '100%', maxWidth: 460,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600, color: '#1e3a5f' }}>
          ✨ AIで工程案を作る
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748B' }}>
          見積内容をもとにAIが工程の叩き台を生成します。
          最終判断は担当者が行ってください。
        </p>
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>着工予定日<span style={{ color: '#DC2626' }}>*</span></label>
          <Input
            type="date" inputSize="compact" autoFocus
            value={startDate} onChange={e => setStartDate(e.target.value)}
          />

          <label style={labelStyle}>休業曜日（チェック = 休業）</label>
          <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
            {DOW_LABELS.map((label, dow) => (
              <label key={dow} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 13, cursor: 'pointer',
                color: nonWorkingWeekdays.includes(dow) ? '#DC2626' : '#374151',
              }}>
                <input
                  type="checkbox"
                  checked={nonWorkingWeekdays.includes(dow)}
                  onChange={() => toggleDow(dow)}
                  style={{ width: 15, height: 15, cursor: 'pointer' }}
                />
                {label}
              </label>
            ))}
          </div>

          <label style={labelStyle}>施工条件・備考（任意）</label>
          <Textarea
            inputSize="compact"
            value={conditions} onChange={e => setConditions(e.target.value)}
            placeholder="例: 2階のみ、お客様在宅"
          />

          {err && <p style={{ color: '#DC2626', fontSize: 13, margin: '4px 0 0' }}>{err}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
            <Button type="submit" variant="primary">工程案を生成</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── AI採用確認モーダル ──────────────────────────────────────

function AdoptConfirmModal({
  draftCount,
  adopting,
  onAdopt,
  onDiscard,
}: {
  draftCount: number
  adopting: boolean
  onAdopt: () => void
  onDiscard: () => void
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={e => e.stopPropagation()}>
      <div style={{
        background: '#FFF', borderRadius: 12, padding: 24, width: '100%', maxWidth: 400,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600, color: '#1e3a5f' }}>
          工程案を採用しますか？
        </h3>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#374151' }}>
          AI案の <strong>{draftCount}件</strong> の工程を正式な工程表に追加します。
          既存の工程は変更されません。
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 12, color: '#64748B', background: '#F8FAFC', borderRadius: 6, padding: '8px 12px' }}>
          この内容はAIによる整理結果です。最終判断は担当者が行ってください。
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onDiscard} disabled={adopting}>破棄</Button>
          <Button type="button" variant="primary" onClick={onAdopt} disabled={adopting}>
            {adopting ? '追加中…' : '採用して追加'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── メインコンポーネント ────────────────────────────────────

export function ScheduleTab({ projectId }: { projectId: string }) {
  const [viewMode, setViewMode] = useState<ViewMode>('timeline')
  const [items, setItems]       = useState<ScheduleItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [modal, setModal]       = useState<{ mode: 'add' | 'edit'; item?: ScheduleItem } | null>(null)
  const [estimateGroups, setEstimateGroups] = useState<EstimateGroup[]>([])
  const [conflicts, setConflicts]           = useState<ScheduleConflict[]>([])

  // AI ドラフト状態
  const [showAIModal, setShowAIModal]       = useState(false)
  const [aiLoading, setAiLoading]           = useState(false)
  const [aiError, setAiError]               = useState<string | null>(null)
  const [draftItems, setDraftItems]         = useState<AIScheduleDraftItem[] | null>(null)
  const [draftId, setDraftId]               = useState<string | null>(null)
  const [showAdoptModal, setShowAdoptModal] = useState(false)
  const [adopting, setAdopting]             = useState(false)
  // ドラフト編集モーダル（DB書込みなし）
  const [draftEditModal, setDraftEditModal] = useState<{
    draftId: string; initial: FormState
  } | null>(null)

  // カレンダー設定（工程の休業日）
  const [calendarOptions, setCalendarOptions] = useState<ScheduleCalendarOptions>(DEFAULT_CALENDAR)
  const [showHolidayModal, setShowHolidayModal] = useState(false)

  // ドラッグ保存ステータス
  const [patchStatus, setPatchStatus] = useState<'idle' | 'saving' | 'error'>('idle')

  // 最新の items を window ハンドラ（ドラッグ完了コールバック）から参照するための ref
  const itemsRef = useRef<ScheduleItem[]>(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // ── データ取得 ────────────────────────────────────────────

  const load = useCallback(async () => {
    let errorMsg: string | null = null
    try {
      // .catch() on Promise.all eliminates a language-level catch block, which
      // would create a synchronous path to finally and trigger set-state-in-effect.
      const results = await Promise.all([
        fetch(`/api/schedule-items?project_id=${projectId}`),
        fetch(`/api/estimate-groups?project_id=${projectId}`),
        fetch(`/api/projects/${projectId}/schedule-settings`),
      ]).catch((err: unknown) => { errorMsg = err instanceof Error ? err.message : 'エラーが発生しました'; return null })
      if (results !== null) {
        const [itemsRes, groupsRes, settingsRes] = results
        try {
          if (!itemsRes.ok) throw new Error('工程データの取得に失敗しました')
          const itemsData: ScheduleItem[] = await itemsRes.json()
          setItems(itemsData)
          setConflicts(detectScheduleConflicts(itemsData))
          if (groupsRes.ok) {
            const g = await groupsRes.json()
            setEstimateGroups(Array.isArray(g) ? g : (g.groups ?? []))
          }
          if (settingsRes.ok) {
            const s = await settingsRes.json() as { nonWorkingWeekdays?: number[]; nonWorkingDates?: string[] }
            setCalendarOptions({
              nonWorkingWeekdays: s.nonWorkingWeekdays ?? [0],
              nonWorkingDates:    s.nonWorkingDates    ?? [],
            })
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : 'エラーが発生しました'
        }
      }
    } finally {
      setError(errorMsg)
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  // ── CRUD ──────────────────────────────────────────────────

  const toApiBody = (form: FormState, projectIdStr?: string) => ({
    ...(projectIdStr ? { project_id: projectIdStr } : {}),
    name:              form.name,
    category:          form.category    || null,
    vendor_name:       form.vendor_name || null,
    assignee:          form.assignee    || null,
    start_date:        form.start_date  || null,
    start_period:      form.start_period,
    end_date:          form.end_date    || null,
    end_period:        form.end_period,
    status:            form.status,
    memo:              form.memo        || null,
    estimate_group_id: form.estimate_group_id || null,
  })

  const handleAdd = async (form: FormState) => {
    const res = await fetch('/api/schedule-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toApiBody(form, projectId)),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error((d as { error?: string }).error ?? '追加に失敗しました')
    }
    await load()
  }

  const handleEdit = async (form: FormState, itemId: string) => {
    const res = await fetch(`/api/schedule-items/${itemId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toApiBody(form)),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error((d as { error?: string }).error ?? '更新に失敗しました')
    }
    await load()
  }

  const handleDelete = async (itemId: string) => {
    if (!confirm('この工程を削除しますか？')) return
    const res = await fetch(`/api/schedule-items/${itemId}`, { method: 'DELETE' })
    if (!res.ok) { alert('削除に失敗しました'); return }
    await load()
  }

  const handleStatusChange = async (itemId: string, status: ScheduleStatus) => {
    const res = await fetch(`/api/schedule-items/${itemId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) { alert('状態の更新に失敗しました'); return }
    await load()
  }

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return
    const src = result.source.index
    const dst = result.destination.index
    if (src === dst) return
    const newItems = [...items]
    const [moved] = newItems.splice(src, 1)
    newItems.splice(dst, 0, moved)
    setItems(newItems)
    setConflicts(detectScheduleConflicts(newItems))
    const res = await fetch('/api/schedule-items/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ordered_ids: newItems.map(i => i.id) }),
    })
    if (!res.ok) await load()
  }

  // ── ドラッグ完了ハンドラ ────────────────────────────────────

  const handleItemDragComplete = useCallback(async (itemId: string, newDates: ItemDates) => {
    const prevItems    = itemsRef.current
    const updatedItems = prevItems.map(i =>
      i.id !== itemId ? i : {
        ...i,
        start_date:   newDates.start_date   || null,
        start_period: newDates.start_period,
        end_date:     newDates.end_date     || null,
        end_period:   newDates.end_period,
      },
    )
    // 楽観的更新
    setItems(updatedItems)
    setConflicts(detectScheduleConflicts(updatedItems))
    setPatchStatus('saving')
    try {
      const res = await fetch(`/api/schedule-items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date:   newDates.start_date   || null,
          start_period: newDates.start_period,
          end_date:     newDates.end_date     || null,
          end_period:   newDates.end_period,
        }),
      })
      if (!res.ok) throw new Error('保存に失敗しました')
      setPatchStatus('idle')
    } catch {
      // ロールバック
      setItems(prevItems)
      setConflicts(detectScheduleConflicts(prevItems))
      setPatchStatus('error')
      setTimeout(() => setPatchStatus('idle'), 3000)
    }
  }, [])

  const handleDraftDragComplete = useCallback((draftId: string, newDates: ItemDates) => {
    setDraftItems(prev =>
      prev?.map(d =>
        d._draft_id !== draftId ? d : {
          ...d,
          start_date:   newDates.start_date   || null,
          start_period: newDates.start_period,
          end_date:     newDates.end_date     || null,
          end_period:   newDates.end_period,
        },
      ) ?? null,
    )
  }, [])

  // ── AI 工程案生成 ──────────────────────────────────────────

  const handleGenerateDraft = async (startDate: string, conditions: string, nonWorkingWeekdays: number[], nonWorkingDates: string[]) => {
    setShowAIModal(false)
    setAiLoading(true)
    setAiError(null)
    setDraftItems(null)
    setDraftId(null)
    try {
      const res = await fetch('/api/schedule-items/ai-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id:        projectId,
          start_date:        startDate,
          conditions:        conditions || undefined,
          nonWorkingWeekdays,
          nonWorkingDates,
        }),
      })
      const data = await res.json() as { items?: Array<Omit<AIScheduleDraftItem, '_draft_id'>>; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'AI生成に失敗しました')
      if (!Array.isArray(data.items) || data.items.length === 0) throw new Error('AIから工程案が返されませんでした')

      // 各 draft item に React key 用の一時ID を付与
      const withIds: AIScheduleDraftItem[] = data.items.map(item => ({
        ...item,
        _draft_id: `draft-${Math.random().toString(36).slice(2, 10)}`,
      }))
      // この AI 案セッションを一意に識別する draft_id（二重採用防止用）
      const newDraftId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      setDraftItems(withIds)
      setDraftId(newDraftId)
      setViewMode('timeline')
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI生成に失敗しました')
    } finally {
      setAiLoading(false)
    }
  }

  // ── AI ドラフト一括採用（batch API 経由）─────────────────────

  const handleAdoptDraft = async () => {
    if (!draftItems || draftItems.length === 0 || !draftId) return
    setAdopting(true)
    try {
      const res = await fetch('/api/schedule-items/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          draft_id:   draftId,
          items: draftItems.map(d => ({
            name:              d.name,
            category:          d.category          ?? null,
            vendor_name:       d.vendor_name        ?? null,
            start_date:        d.start_date         ?? null,
            end_date:          d.end_date           ?? null,
            start_period:      d.start_period       ?? 'am',
            end_period:        d.end_period         ?? 'pm',
            memo:              d.memo               ?? null,
            estimate_group_id: d.estimate_group_id  ?? null,
          })),
        }),
      })
      const data = await res.json() as { ok?: boolean; inserted?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? '採用に失敗しました')

      setDraftItems(null)
      setDraftId(null)
      setShowAdoptModal(false)
      await load()
    } catch (err) {
      alert(err instanceof Error ? err.message : '採用に失敗しました')
    } finally {
      setAdopting(false)
    }
  }

  // ── AI ドラフト編集（DB 書込みなし・React state のみ）────────

  const handleDraftEdit = (savedForm: FormState, targetDraftId: string) => {
    setDraftItems(prev =>
      prev?.map(d =>
        d._draft_id !== targetDraftId
          ? d
          : {
              ...d,
              name:              savedForm.name,
              category:          savedForm.category          || null,
              vendor_name:       savedForm.vendor_name        || null,
              start_date:        savedForm.start_date         || null,
              end_date:          savedForm.end_date           || null,
              start_period:      savedForm.start_period,
              end_period:        savedForm.end_period,
              memo:              savedForm.memo               || null,
              estimate_group_id: savedForm.estimate_group_id  || null,
            },
      ) ?? null,
    )
    setDraftEditModal(null)
  }

  // ── モーダル ───────────────────────────────────────────────

  const openAdd  = () => setModal({ mode: 'add' })
  const openEdit = (item: ScheduleItem) => setModal({ mode: 'edit', item })
  const closeModal = () => setModal(null)

  const conflictedIds = new Set(conflicts.flatMap(c => [c.itemA.id, c.itemB.id]))

  // ── サマリー統計 ──────────────────────────────────────────

  const earliest  = items.filter(i => i.start_date).map(i => i.start_date!).sort()[0]
  const latest    = items.filter(i => i.end_date).map(i => i.end_date!).sort().at(-1)
  const unconfirmed = items.filter(i => i.status === 'planned').length
  const delayed     = items.filter(i => i.status === 'delayed').length

  // ── 表示 ──────────────────────────────────────────────────

  if (loading) {
    return <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8', fontSize: 14 }}>読み込み中…</div>
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '12px 16px', color: '#DC2626', fontSize: 14 }}>
          {error}
          <button onClick={() => { setLoading(true); setError(null); void load() }} style={{ marginLeft: 12, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626' }}>
            再読み込み
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* ── ツールバー ──────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', borderBottom: '1px solid #E8ECF6',
        flexWrap: 'wrap',
      }}>
        {/* 表示切替 */}
        <div style={{ display: 'flex', border: '1px solid #E2E8F0', borderRadius: 6, overflow: 'hidden' }}>
          <button
            onClick={() => setViewMode('timeline')}
            style={{ ...viewToggleBtn, background: viewMode === 'timeline' ? '#2B5E40' : '#FFF', color: viewMode === 'timeline' ? '#FFF' : '#374151' }}
          >
            工程表
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={{ ...viewToggleBtn, borderLeft: '1px solid #E2E8F0', background: viewMode === 'list' ? '#2B5E40' : '#FFF', color: viewMode === 'list' ? '#FFF' : '#374151' }}
          >
            一覧
          </button>
        </div>

        {/* 追加ボタン */}
        <Button type="button" size="sm" variant="primary" onClick={openAdd}>
          <PlusIcon /> 工程を追加
        </Button>

        {/* 休業日設定 */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setShowHolidayModal(true)}
        >
          🗓 休業日設定
        </Button>

        {/* AI工程案生成 */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => { setAiError(null); setShowAIModal(true) }}
          disabled={aiLoading}
        >
          {aiLoading ? '生成中…' : '✨ AIで工程案を作る'}
        </Button>
        {draftItems && (
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => { setDraftItems(null); setDraftId(null) }}
          >
            AI案を破棄
          </Button>
        )}

        {/* 保存ステータス */}
        {patchStatus === 'saving' && (
          <span style={{ fontSize: 12, color: '#64748B' }}>保存中…</span>
        )}
        {patchStatus === 'error' && (
          <span style={{ fontSize: 12, color: '#DC2626' }}>⚠ 保存に失敗しました。元の位置に戻しました。</span>
        )}

        {/* サマリー */}
        {items.length > 0 && (
          <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748B', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>工程数 <strong style={{ color: '#1e3a5f' }}>{items.length}件</strong></span>
            {earliest && latest && (
              <span>期間 <strong style={{ color: '#1e3a5f' }}>{earliest.slice(5).replace('-', '/')}〜{latest.slice(5).replace('-', '/')}</strong></span>
            )}
            {unconfirmed > 0 && (
              <span>未確定 <strong style={{ color: '#1D4ED8' }}>{unconfirmed}件</strong></span>
            )}
            {delayed > 0 && (
              <span>遅延 <strong style={{ color: '#DC2626' }}>{delayed}件</strong></span>
            )}
          </div>
        )}
      </div>

      {/* ── 重複警告 ─────────────────────────────────── */}
      {conflicts.length > 0 && (
        <div style={{
          background: '#FFFBEB', border: '1px solid #FDE68A',
          borderRadius: 0, padding: '8px 20px',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ color: '#F59E0B', flexShrink: 0, marginTop: 1 }}><WarnIcon /></span>
          <div style={{ fontSize: 12, color: '#92400E' }}>
            {conflicts.map((c, i) => (
              <span key={i}>
                <strong>{c.vendorName}</strong>:「{c.itemA.name}」と「{c.itemB.name}」の日程が重複{i < conflicts.length - 1 ? '　' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── AI エラー ─────────────────────────────── */}
      {aiError && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA',
          padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 13, color: '#DC2626' }}>⚠ {aiError}</span>
          <button onClick={() => setAiError(null)} aria-label="エラーを閉じる" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626', fontSize: 12 }}>✕</button>
        </div>
      )}

      {/* ── AI ドラフト採用バナー ─────────────────────── */}
      {draftItems && draftItems.length > 0 && (
        <div style={{
          background: '#EFF6FF', borderBottom: '2px solid #BFDBFE',
          padding: '12px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, color: '#1D4ED8', fontWeight: 700 }}>
              ✨ AIが {draftItems.length}件 の工程案を作成しました
            </span>
            <span style={{ fontSize: 12, color: '#3B82F6' }}>
              タイムライン下部に点線（AI案）で表示されています。各行クリックで編集できます。
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => { setViewMode('timeline') }}
            >
              内容を確認
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => setShowAdoptModal(true)}
            >
              この工程案を採用
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={() => { setDraftItems(null); setDraftId(null) }}
            >
              破棄
            </Button>
          </div>
        </div>
      )}

      {/* ── コンテンツ ───────────────────────────────── */}
      {viewMode === 'timeline' ? (
        <ScheduleTimeline
          items={items}
          conflictedIds={conflictedIds}
          onItemClick={openEdit}
          draftItems={draftItems ?? undefined}
          onItemDragComplete={handleItemDragComplete}
          onDraftDragComplete={handleDraftDragComplete}
          calendarOptions={calendarOptions}
          onDraftClick={item => {
            setDraftEditModal({
              draftId: item._draft_id,
              initial: {
                name:              item.name,
                category:          item.category          ?? '',
                vendor_name:       item.vendor_name        ?? '',
                assignee:          '',
                start_date:        item.start_date         ?? '',
                start_period:      item.start_period       ?? 'am',
                end_date:          item.end_date           ?? '',
                end_period:        item.end_period         ?? 'pm',
                status:            'planned',
                memo:              item.memo               ?? '',
                estimate_group_id: item.estimate_group_id  ?? '',
              },
            })
          }}
        />
      ) : (
        /* 一覧モード */
        <div style={{ padding: '16px 20px' }}>
          {items.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '48px 24px', color: '#94A3B8',
              border: '2px dashed #E2E8F0', borderRadius: 12,
            }}>
              <p style={{ margin: 0 }}>工程がまだありません</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #E8ECF6' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: '#FFF', minWidth: 700 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8ECF6' }}>
                    <th style={thStyle}></th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>工程名</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>業者・担当</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>日程 (AM/PM)</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>状態</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>メモ</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <DragDropContext onDragEnd={handleDragEnd}>
                  <Droppable droppableId="schedule-list">
                    {provided => (
                      <tbody ref={provided.innerRef} {...provided.droppableProps}>
                        {items.map((item, index) => (
                          <Draggable key={item.id} draggableId={item.id} index={index}>
                            {dragProvided => (
                              <ScheduleRow
                                item={item}
                                conflicted={conflictedIds.has(item.id)}
                                provided={dragProvided}
                                onEdit={() => openEdit(item)}
                                onDelete={() => handleDelete(item.id)}
                                onStatusChange={s => handleStatusChange(item.id, s)}
                              />
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </tbody>
                    )}
                  </Droppable>
                </DragDropContext>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 編集モーダル ─────────────────────────────── */}
      {modal && (
        <ScheduleFormModal
          estimateGroups={estimateGroups}
          title={modal.mode === 'add' ? '工程を追加' : '工程を編集'}
          initial={
            modal.mode === 'edit' && modal.item
              ? {
                  name:              modal.item.name,
                  category:          modal.item.category       ?? '',
                  vendor_name:       modal.item.vendor_name    ?? '',
                  assignee:          modal.item.assignee       ?? '',
                  start_date:        modal.item.start_date     ?? '',
                  start_period:      modal.item.start_period   ?? 'am',
                  end_date:          modal.item.end_date       ?? '',
                  end_period:        modal.item.end_period     ?? 'pm',
                  status:            modal.item.status,
                  memo:              modal.item.memo           ?? '',
                  estimate_group_id: modal.item.estimate_group_id ?? '',
                }
              : EMPTY_FORM
          }
          onSave={async form => {
            if (modal.mode === 'add') {
              await handleAdd(form)
            } else if (modal.item) {
              await handleEdit(form, modal.item.id)
            }
          }}
          onClose={closeModal}
        />
      )}

      {/* ── AI ドラフト編集モーダル（DB 書込みなし）─────── */}
      {draftEditModal && (
        <ScheduleFormModal
          estimateGroups={estimateGroups}
          title="AI案を編集（確定前・DB未保存）"
          initial={draftEditModal.initial}
          onSave={async form => handleDraftEdit(form, draftEditModal.draftId)}
          onClose={() => setDraftEditModal(null)}
        />
      )}

      {/* ── 休業日設定モーダル ────────────────────────── */}
      {showHolidayModal && (
        <HolidaySettingsModal
          projectId={projectId}
          current={calendarOptions}
          onSaved={opts => setCalendarOptions(opts)}
          onClose={() => setShowHolidayModal(false)}
        />
      )}

      {/* ── AI 入力モーダル ───────────────────────────── */}
      {showAIModal && (
        <AIScheduleModal
          defaultCalendar={calendarOptions}
          onGenerate={(sd, cond, nww, nwd) => handleGenerateDraft(sd, cond, nww, nwd)}
          onClose={() => setShowAIModal(false)}
        />
      )}

      {/* ── AI 採用確認モーダル ───────────────────────── */}
      {showAdoptModal && draftItems && (
        <AdoptConfirmModal
          draftCount={draftItems.length}
          adopting={adopting}
          onAdopt={handleAdoptDraft}
          onDiscard={() => { setShowAdoptModal(false); setDraftItems(null) }}
        />
      )}
    </div>
  )
}
