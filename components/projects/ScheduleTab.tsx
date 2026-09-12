'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ScheduleItem, ScheduleConflict, ScheduleStatus, SchedulePeriod } from '@/lib/services/schedule'
import { detectScheduleConflicts } from '@/lib/services/schedule'
import { ScheduleTimeline } from './ScheduleTimeline'

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
          <input style={inputStyle} value={form.name} autoFocus
            onChange={e => set('name', e.target.value)} placeholder="例: 大工工事、電気配線工事" />

          {/* 工種 */}
          <label style={labelStyle}>工種</label>
          <select style={inputStyle} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">未設定</option>
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          {/* 業者名 */}
          <label style={labelStyle}>業者名</label>
          <input style={inputStyle} value={form.vendor_name}
            onChange={e => set('vendor_name', e.target.value)} placeholder="例: 山田建設" />

          {/* 担当者 */}
          <label style={labelStyle}>担当者</label>
          <input style={inputStyle} value={form.assignee}
            onChange={e => set('assignee', e.target.value)} placeholder="例: 田中" />

          {/* 開始日 + AM/PM */}
          <label style={labelStyle}>開始日・時間帯</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" style={{ ...inputStyle, flex: 1 }} value={form.start_date}
              onChange={e => set('start_date', e.target.value)} />
            <select style={{ ...inputStyle, width: 80 }} value={form.start_period}
              onChange={e => set('start_period', e.target.value as SchedulePeriod)}>
              <option value="am">AM</option>
              <option value="pm">PM</option>
            </select>
          </div>

          {/* 終了日 + AM/PM */}
          <label style={labelStyle}>終了日・時間帯</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" style={{ ...inputStyle, flex: 1 }} value={form.end_date}
              onChange={e => set('end_date', e.target.value)} />
            <select style={{ ...inputStyle, width: 80 }} value={form.end_period}
              onChange={e => set('end_period', e.target.value as SchedulePeriod)}>
              <option value="am">AM</option>
              <option value="pm">PM</option>
            </select>
          </div>

          {/* 状態 */}
          <label style={labelStyle}>状態</label>
          <select style={inputStyle} value={form.status}
            onChange={e => set('status', e.target.value as ScheduleStatus)}>
            {(Object.entries(STATUS_LABELS) as [ScheduleStatus, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          {/* 見積グループ */}
          {estimateGroups.length > 0 && (
            <>
              <label style={labelStyle}>見積グループ連携</label>
              <select style={inputStyle} value={form.estimate_group_id}
                onChange={e => set('estimate_group_id', e.target.value)}>
                <option value="">なし</option>
                {estimateGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </>
          )}

          {/* メモ */}
          <label style={labelStyle}>メモ</label>
          <textarea
            style={{ ...inputStyle, height: 60, resize: 'vertical' as const }}
            value={form.memo} onChange={e => set('memo', e.target.value)}
            placeholder="備考・注意点"
          />

          {error && <p style={{ color: '#DC2626', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtnStyle}>キャンセル</button>
            <button type="submit" disabled={saving} style={saveBtnStyle}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── 一覧 行コンポーネント ────────────────────────────────────

function ScheduleRow({
  item, index, total, conflicted,
  onEdit, onDelete, onMoveUp, onMoveDown, onStatusChange,
}: {
  item: ScheduleItem; index: number; total: number; conflicted: boolean
  onEdit: () => void; onDelete: () => void
  onMoveUp: () => void; onMoveDown: () => void
  onStatusChange: (s: ScheduleStatus) => void
}) {
  const statusStyle = STATUS_COLORS[item.status]
  return (
    <tr style={{ borderBottom: '1px solid #F0F2F8' }}>
      <td style={{ padding: '8px 6px', width: 36, textAlign: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
          <button disabled={index === 0} onClick={onMoveUp}
            style={{ ...arrowBtnStyle, opacity: index === 0 ? 0.25 : 1 }}>▲</button>
          <button disabled={index === total - 1} onClick={onMoveDown}
            style={{ ...arrowBtnStyle, opacity: index === total - 1 ? 0.25 : 1 }}>▼</button>
        </div>
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
        <button onClick={onEdit} style={iconActionBtn} title="編集"><EditIcon /></button>
        <button onClick={onDelete} style={{ ...iconActionBtn, color: '#DC2626' }} title="削除"><TrashIcon /></button>
      </td>
    </tr>
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

  // ── データ取得 ────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [itemsRes, groupsRes] = await Promise.all([
        fetch(`/api/schedule-items?project_id=${projectId}`),
        fetch(`/api/estimate-groups?project_id=${projectId}`),
      ])
      if (!itemsRes.ok) throw new Error('工程データの取得に失敗しました')
      const itemsData: ScheduleItem[] = await itemsRes.json()
      setItems(itemsData)
      setConflicts(detectScheduleConflicts(itemsData))
      if (groupsRes.ok) {
        const g = await groupsRes.json()
        setEstimateGroups(Array.isArray(g) ? g : (g.groups ?? []))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エラーが発生しました')
    } finally {
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

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    const newItems = [...items]
    const target = direction === 'up' ? index - 1 : index + 1
    ;[newItems[index], newItems[target]] = [newItems[target], newItems[index]]
    setItems(newItems)
    setConflicts(detectScheduleConflicts(newItems))
    const res = await fetch('/api/schedule-items/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ordered_ids: newItems.map(i => i.id) }),
    })
    if (!res.ok) await load()
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
          <button onClick={load} style={{ marginLeft: 12, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626' }}>
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
            style={{ ...viewToggleBtn, background: viewMode === 'timeline' ? '#1e3a5f' : '#FFF', color: viewMode === 'timeline' ? '#FFF' : '#374151' }}
          >
            工程表
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={{ ...viewToggleBtn, borderLeft: '1px solid #E2E8F0', background: viewMode === 'list' ? '#1e3a5f' : '#FFF', color: viewMode === 'list' ? '#FFF' : '#374151' }}
          >
            一覧
          </button>
        </div>

        {/* 追加ボタン */}
        <button onClick={openAdd} style={addBtnStyle}>
          <PlusIcon /> 工程を追加
        </button>

        {/* AI工程案（Phase 2 プレースホルダー） */}
        <button
          disabled
          title="Phase 2で実装予定"
          style={{ ...addBtnStyle, background: '#F8FAFC', color: '#94A3B8', border: '1px solid #E2E8F0', cursor: 'not-allowed' }}
        >
          ✨ AIで工程案を作る
        </button>

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

      {/* ── コンテンツ ───────────────────────────────── */}
      {viewMode === 'timeline' ? (
        <ScheduleTimeline
          items={items}
          conflictedIds={conflictedIds}
          onItemClick={openEdit}
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
                <tbody>
                  {items.map((item, index) => (
                    <ScheduleRow
                      key={item.id}
                      item={item}
                      index={index}
                      total={items.length}
                      conflicted={conflictedIds.has(item.id)}
                      onEdit={() => openEdit(item)}
                      onDelete={() => handleDelete(item.id)}
                      onMoveUp={() => handleMove(index, 'up')}
                      onMoveDown={() => handleMove(index, 'down')}
                      onStatusChange={s => handleStatusChange(item.id, s)}
                    />
                  ))}
                </tbody>
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
    </div>
  )
}

// ── スタイル定数 ────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
  marginBottom: 4, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px',
  border: '1px solid #E2E8F0', borderRadius: 6,
  fontSize: 14, color: '#1e293b', background: '#FAFAFA',
  boxSizing: 'border-box',
}
const cancelBtnStyle: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 6, border: '1px solid #E2E8F0',
  background: '#FFF', fontSize: 14, cursor: 'pointer', color: '#374151',
}
const saveBtnStyle: React.CSSProperties = {
  padding: '9px 24px', borderRadius: 6, border: 'none',
  background: '#1e3a5f', color: '#FFF', fontSize: 14, fontWeight: 600, cursor: 'pointer',
}
const addBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
  padding: '7px 14px', background: '#1e3a5f', color: '#FFF',
  border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer',
}
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
