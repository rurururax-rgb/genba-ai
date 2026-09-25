'use client'

import { useState, useCallback } from 'react'
import { CatalogImportModal } from './CatalogImportModal'
import { Input } from '@/components/ui/input'

// ─────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────

type Item = {
  id: string
  name: string
  spec: string | null
  unit: string | null
  selling_price: number | null
  cost_price: number | null
  url: string | null
  category: string | null
  usage_count: number | null
  updated_at: string | null
}

type Props = {
  initialItems: Item[]
}

// ─────────────────────────────────────────────────────────
// デザイントークン
// ─────────────────────────────────────────────────────────

const C = {
  navy:      '#2B5E40',
  navyLight: '#EFF6FF',
  border:    '#D8E0EE',
  muted:     '#8A96A8',
  bg:        '#F7F9FC',
  white:     '#FFFFFF',
  danger:    '#B91C1C',
  dangerBg:  '#FEE2E2',
  success:   '#166534',
  successBg: '#DCFCE7',
}

const FONT = "'Inter','Hiragino Kaku Gothic ProN','Meiryo UI',Meiryo,sans-serif"

// ─────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────

const fmt = (v: number | null) =>
  v != null ? `¥${v.toLocaleString('ja-JP')}` : '—'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

// ─────────────────────────────────────────────────────────
// EditRow — インライン編集フォーム
// ─────────────────────────────────────────────────────────

type EditableFields = {
  name: string
  spec: string
  unit: string
  selling_price: string
  cost_price: string
  url: string
  category: string
}

function EditRow({
  item,
  onSave,
  onCancel,
}: {
  item: Item
  onSave: (fields: EditableFields) => Promise<void>
  onCancel: () => void
}) {
  const [fields, setFields] = useState<EditableFields>({
    name:          item.name,
    spec:          item.spec          ?? '',
    unit:          item.unit          ?? '式',
    selling_price: item.selling_price != null ? String(item.selling_price) : '',
    cost_price:    item.cost_price    != null ? String(item.cost_price)    : '',
    url:           item.url           ?? '',
    category:      item.category      ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = (key: keyof EditableFields) => (
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }))
  )

  const handleSave = async () => {
    setSaving(true)
    await onSave(fields)
    setSaving(false)
  }

  return (
    <tr style={{ background: C.navyLight }}>
      {/* 品名 */}
      <td style={td}><Input inputSize="compact" value={fields.name} onChange={set('name')} /></td>
      {/* 仕様 */}
      <td style={td}><Input inputSize="compact" value={fields.spec} onChange={set('spec')} placeholder="型番・仕様" /></td>
      {/* 参考単価 */}
      <td style={td}><Input inputSize="compact" value={fields.selling_price} onChange={set('selling_price')} placeholder="例: 552000" className="text-right" /></td>
      {/* URL */}
      <td style={td}><Input inputSize="compact" value={fields.url} onChange={set('url')} placeholder="https://..." /></td>
      {/* 更新日 */}
      <td style={td} />
      {/* 操作 */}
      <td style={{ ...td, textAlign: 'right' }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={saving} style={btnOutline}>
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving || !fields.name.trim()} style={btnPrimary}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─────────────────────────────────────────────────────────
// AddRow — 新規追加行
// ─────────────────────────────────────────────────────────

function AddRow({ onAdd }: { onAdd: (fields: EditableFields) => Promise<void> }) {
  const empty: EditableFields = { name: '', spec: '', unit: '式', selling_price: '', cost_price: '', url: '', category: '' }
  const [fields, setFields] = useState<EditableFields>(empty)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  const set = (key: keyof EditableFields) => (
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }))
  )

  const handleAdd = async () => {
    setSaving(true)
    await onAdd(fields)
    setFields(empty)
    setOpen(false)
    setSaving(false)
  }

  if (!open) {
    return (
      <tr>
        <td colSpan={6} style={{ padding: '10px 14px' }}>
          <button
            onClick={() => setOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'none', border: `1.5px dashed ${C.border}`,
              borderRadius: 8, padding: '7px 16px', cursor: 'pointer',
              fontSize: 13, color: C.muted, fontFamily: FONT,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>＋</span> 新規追加
          </button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ background: '#F0FDF4' }}>
      <td style={td}><Input inputSize="compact" value={fields.name} onChange={set('name')} placeholder="品名（必須）" autoFocus /></td>
      <td style={td}><Input inputSize="compact" value={fields.spec} onChange={set('spec')} placeholder="型番・仕様" /></td>
      <td style={td}><Input inputSize="compact" value={fields.selling_price} onChange={set('selling_price')} placeholder="例: 552000" className="text-right" /></td>
      <td style={td}><Input inputSize="compact" value={fields.url} onChange={set('url')} placeholder="https://..." /></td>
      <td style={td} />
      <td style={{ ...td, textAlign: 'right' }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => { setOpen(false); setFields(empty) }} style={btnOutline}>
            キャンセル
          </button>
          <button onClick={handleAdd} disabled={saving || !fields.name.trim()} style={btnPrimary}>
            {saving ? '追加中…' : '追加'}
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─────────────────────────────────────────────────────────
// MaterialMasterList
// ─────────────────────────────────────────────────────────

export function MaterialMasterList({ initialItems }: Props) {
  const [items, setItems]       = useState<Item[]>(initialItems)
  const [editingId, setEditing] = useState<string | null>(null)
  const [q, setQ]               = useState('')
  const [err, setErr]           = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  const filtered = q
    ? items.filter(it => it.name.includes(q) || (it.spec ?? '').includes(q) || (it.category ?? '').includes(q))
    : items

  // ── 追加 ──────────────────────────────────────────────
  const handleAdd = useCallback(async (fields: EditableFields) => {
    setErr(null)
    const body = buildBody(fields)
    const res = await fetch('/api/material-master', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json() as { data?: Item; error?: string }
    if (!res.ok || !json.data) { setErr(json.error ?? '追加に失敗しました'); return }
    setItems(prev => [json.data!, ...prev])
  }, [])

  // ── 保存（更新） ──────────────────────────────────────
  const handleSave = useCallback(async (id: string, fields: EditableFields) => {
    setErr(null)
    const body = buildBody(fields)
    const res = await fetch(`/api/material-master/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json() as { data?: Item; error?: string }
    if (!res.ok || !json.data) { setErr(json.error ?? '保存に失敗しました'); return }
    setItems(prev => prev.map(it => it.id === id ? json.data! : it))
    setEditing(null)
  }, [])

  // ── 削除 ──────────────────────────────────────────────
  const handleDelete = useCallback(async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    setErr(null)
    const res = await fetch(`/api/material-master/${id}`, { method: 'DELETE' })
    if (!res.ok) { setErr('削除に失敗しました'); return }
    setItems(prev => prev.filter(it => it.id !== id))
  }, [])

  // カタログ取込後にリストを再取得して反映
  const handleImportDone = useCallback(async () => {
    const res = await fetch('/api/material-master')
    const json = await res.json() as { data?: Item[]; error?: string }
    if (json.data) setItems(json.data)
  }, [])

  return (
    <div style={{ fontFamily: FONT }}>
      {showImport && (
        <CatalogImportModal
          onClose={() => setShowImport(false)}
          onImportDone={handleImportDone}
        />
      )}

      {/* ── 検索バー ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="品名・仕様・カテゴリで絞り込み…"
          className="flex-1"
        />
        <span style={{ fontSize: 13, color: C.muted, whiteSpace: 'nowrap' }}>
          {filtered.length}件
        </span>
        <button
          onClick={() => setShowImport(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '0 16px', height: 44,
            background: C.navy, color: C.white,
            border: 'none', borderRadius: 8,
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          AI取込
        </button>
      </div>

      {/* ── エラー ── */}
      {err && (
        <div style={{
          background: C.dangerBg, color: C.danger, border: '1px solid #FCA5A5',
          borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13,
        }}>
          {err}
        </div>
      )}

      {/* ── テーブル ── */}
      <div style={{ overflowX: 'auto', borderRadius: 12, border: `1px solid ${C.border}`, background: C.white }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#F0F4F8', borderBottom: `1px solid ${C.border}` }}>
              {['品名', '仕様・型番', '参考単価', 'URL', '更新日', '操作'].map(h => (
                <th key={h} style={{
                  padding: '10px 14px', textAlign: 'left', fontWeight: 600,
                  color: '#464F60', whiteSpace: 'nowrap', fontSize: 12,
                  letterSpacing: '0.04em',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 新規追加行 */}
            <AddRow onAdd={handleAdd} />

            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '32px 14px', textAlign: 'center', color: C.muted }}>
                  {q ? `「${q}」に一致する資材がありません` : '資材マスターが空です。上の「新規追加」から登録してください。'}
                </td>
              </tr>
            )}

            {filtered.map((item, ri) => (
              editingId === item.id
                ? <EditRow
                    key={item.id}
                    item={item}
                    onSave={fields => handleSave(item.id, fields)}
                    onCancel={() => setEditing(null)}
                  />
                : <tr key={item.id} style={{ background: ri % 2 === 0 ? C.white : C.bg, borderTop: `1px solid ${C.border}` }}>
                    {/* 品名 */}
                    <td style={td}>
                      <div style={{ fontWeight: 500, color: '#1A1A2E' }}>{item.name}</div>
                      {item.category && (
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                          {item.category}
                        </div>
                      )}
                    </td>
                    {/* 仕様 */}
                    <td style={{ ...td, color: '#464F60' }}>{item.spec ?? '—'}</td>
                    {/* 単価 */}
                    <td style={{ ...td, textAlign: 'right', fontWeight: 500 }}>
                      {fmt(item.selling_price)}
                    </td>
                    {/* URL */}
                    <td style={td}>
                      {item.url
                        ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontSize: 12, wordBreak: 'break-all' }}>
                            {item.url.replace(/^https?:\/\//, '').slice(0, 40)}
                            {item.url.length > 50 ? '…' : ''}
                          </a>
                        : <span style={{ color: C.muted }}>—</span>
                      }
                    </td>
                    {/* 更新日 */}
                    <td style={{ ...td, color: C.muted, whiteSpace: 'nowrap' }}>
                      {formatDate(item.updated_at)}
                    </td>
                    {/* 操作 */}
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => setEditing(item.id)} style={btnOutline}>編集</button>
                        <button onClick={() => handleDelete(item.id, item.name)} style={btnDanger}>削除</button>
                      </div>
                    </td>
                  </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 12, fontSize: 12, color: C.muted }}>
        ※ チャットAIから「資材マスターに登録して」と指示しても登録できます。
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────

function buildBody(f: EditableFields): Record<string, unknown> {
  return {
    name:          f.name.trim(),
    spec:          f.spec.trim()          || null,
    unit:          f.unit.trim()          || '式',
    selling_price: f.selling_price !== '' ? Number(f.selling_price) : null,
    cost_price:    f.cost_price    !== '' ? Number(f.cost_price)    : null,
    url:           f.url.trim()           || null,
    category:      f.category.trim()      || null,
  }
}

// ─────────────────────────────────────────────────────────
// スタイル定数
// ─────────────────────────────────────────────────────────

const td: React.CSSProperties = { padding: '9px 14px', verticalAlign: 'middle' }

const btnBase: React.CSSProperties = {
  border: 'none', borderRadius: 8, padding: '5px 12px',
  fontSize: 12, cursor: 'pointer', fontFamily: FONT, fontWeight: 600,
  whiteSpace: 'nowrap',
}

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: '#2B5E40', color: '#FFFFFF',
}

const btnOutline: React.CSSProperties = {
  ...btnBase,
  background: C.white, color: '#1A2E24',
  border: '1px solid #C0D4C5',
}

const btnDanger: React.CSSProperties = {
  ...btnBase,
  background: C.dangerBg, color: C.danger,
  border: '1px solid #FCA5A5',
}
