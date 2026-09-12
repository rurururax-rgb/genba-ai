'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// ── 型 ───────────────────────────────────────────────────

type Project = {
  id: string
  name: string
  customer_name: string | null
  site_address: string | null
  status: string
  updated_at: string
}

type StatusConfig = Record<string, { label: string; color: string; bg: string }>
type FilterTab    = 'active' | 'done' | 'all'
type BadgeInfo    = { label: string; color: string; bg: string; border: string }

type Props = {
  projects:        Project[]
  thumbMap:        Record<string, string>
  statusConfig:    StatusConfig
  derivedBadgeMap: Record<string, BadgeInfo>
}

// ── ユーティリティ ────────────────────────────────────────

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return '本日'
  if (days === 1) return '昨日'
  if (days < 7)  return `${days}日前`
  return new Date(iso).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
}

const STATUS_BORDER: Record<string, string> = {
  collecting: '#9CA3AF',
  reviewing:  '#F59E0B',
  estimating: '#FB923C',
  scheduled:  '#3B82F6',
  done:       '#22C55E',
}

// ── 案件カード ────────────────────────────────────────────

/* eslint-disable @next/next/no-img-element */
function ProjectCard({ project: p, thumbUrl, statusConfig, derivedBadge }: {
  project: Project
  thumbUrl?: string
  statusConfig: StatusConfig
  derivedBadge?: BadgeInfo
}) {
  const fallback    = statusConfig[p.status] ?? { label: p.status, color: '#6B7280', bg: '#F3F4F6' }
  const cfg         = derivedBadge ?? fallback
  const borderColor = derivedBadge?.border ?? STATUS_BORDER[p.status] ?? '#9CA3AF'

  return (
    <Link href={`/projects/${p.id}`} style={{ ...cardS.root, borderLeft: `4px solid ${borderColor}` }}>
      <div style={cardS.thumb}>
        {thumbUrl ? (
          <img src={thumbUrl} alt="" style={cardS.thumbImg} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="#BDD1C3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        )}
      </div>
      <div style={cardS.body}>
        <div style={cardS.name}>{p.name}</div>
        <div style={cardS.meta}>
          {p.customer_name && (
            <span style={cardS.metaChip}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8AA491" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              {p.customer_name}
            </span>
          )}
          {p.site_address && (
            <span style={cardS.metaChip}>
              <svg width="10" height="12" viewBox="0 0 10 12" fill="#BDD1C3">
                <path d="M5 0C2.79 0 1 1.79 1 4c0 3 4 8 4 8s4-5 4-8c0-2.21-1.79-4-4-4zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
              </svg>
              {p.site_address}
            </span>
          )}
        </div>
      </div>
      <div style={cardS.right}>
        <span style={{ ...cardS.badge, color: cfg.color, background: cfg.bg }}>{cfg.label}</span>
        <span style={cardS.date}>{relativeDate(p.updated_at)}</span>
      </div>
      <svg width="6" height="11" viewBox="0 0 6 11" fill="none" style={{ flexShrink: 0, marginLeft: 4 }}>
        <path d="M1 1l4 4.5L1 10" stroke="#BDD1C3" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </Link>
  )
}

// ── 新規案件モーダル ──────────────────────────────────────

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), customer_name: customerName.trim() || null }),
    })
    if (res.ok) {
      const { id } = await res.json()
      router.push(`/projects/${id}`)
    } else {
      setSaving(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#192C1F', margin: '0 0 24px' }}>新規案件を作成</h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={modal.label}>案件名 <span style={{ color: '#E53E3E' }}>*</span></label>
            <input
              ref={inputRef}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例：田中様邸 外壁塗装"
              required
              style={modal.input}
            />
          </div>
          <div>
            <label style={modal.label}>顧客名（任意）</label>
            <input
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="例：田中 太郎"
              style={modal.input}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button type="button" onClick={onClose} style={modal.cancelBtn}>キャンセル</button>
            <button type="submit" disabled={saving || !name.trim()} style={{ ...modal.submitBtn, opacity: saving || !name.trim() ? 0.6 : 1 }}>
              {saving ? '作成中…' : '作成する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const modal = {
  label: { fontSize: 12, fontWeight: 600, color: '#5E8A6E', display: 'block', marginBottom: 6 } as React.CSSProperties,
  input: { width: '100%', border: '1.5px solid #C8D8CA', borderRadius: 8, padding: '9px 12px', fontSize: 14, color: '#192C1F', outline: 'none', boxSizing: 'border-box' } as React.CSSProperties,
  cancelBtn: { flex: 1, padding: '10px', borderRadius: 8, border: '1.5px solid #C8D8CA', background: '#fff', color: '#6B7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' } as React.CSSProperties,
  submitBtn: { flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: '#2B5E40', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' } as React.CSSProperties,
}

// ── 空状態 ────────────────────────────────────────────────

function EmptyState({ tab }: { tab: FilterTab }) {
  const msg = tab === 'done' ? '完了した案件はありません' : '案件が見つかりません'
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#E3EFE7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6CB382" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: '#8AA491', fontWeight: 500 }}>{msg}</p>
    </div>
  )
}

// ── メインコンポーネント ──────────────────────────────────

export function ProjectListClient({ projects, thumbMap, statusConfig, derivedBadgeMap }: Props) {
  const [tab, setTab] = useState<FilterTab>('active')
  const [showModal, setShowModal] = useState(false)

  const active   = projects.filter(p => p.status !== 'done')
  const finished = projects.filter(p => p.status === 'done')
  const shown    = tab === 'all' ? projects : tab === 'active' ? active : finished

  const tabs: [FilterTab, string, number][] = [
    ['active', '進行中', active.length],
    ['done',   '完了',   finished.length],
    ['all',    'すべて', projects.length],
  ]

  return (
    <div style={{ padding: '0 32px 80px' }}>
      {showModal && <NewProjectModal onClose={() => setShowModal(false)} />}

      {/* ── フィルタ + 新規ボタン ── */}
      <div style={s.filterRow}>
        <div style={s.filterTabs}>
          {tabs.map(([id, label, count]) => (
            <button
              key={id}
              style={{ ...s.filterTab, ...(tab === id ? s.filterTabActive : {}) }}
              onClick={() => setTab(id)}
            >
              {label}
              {count > 0 && (
                <span style={{ ...s.badge, ...(tab === id ? s.badgeActive : {}) }}>{count}</span>
              )}
            </button>
          ))}
        </div>
        <button onClick={() => setShowModal(true)} style={s.newBtn}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          新規案件
        </button>
      </div>

      {/* ── 案件リスト ── */}
      <div style={s.list}>
        {shown.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          shown.map(p => (
            <ProjectCard key={p.id} project={p} thumbUrl={thumbMap[p.id]} statusConfig={statusConfig} derivedBadge={derivedBadgeMap[p.id]} />
          ))
        )}
      </div>

    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────

const s = {
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 20,
    gap: 12,
  } as React.CSSProperties,
  filterTabs: {
    display: 'flex',
    gap: 4,
    background: '#E3EFE7',
    borderRadius: 10,
    padding: 5,
  } as React.CSSProperties,
  filterTab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 500,
    color: '#5E8A6E',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.15s',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  filterTabActive: {
    background: '#FFFFFF',
    color: '#2B5E40',
    fontWeight: 700,
    boxShadow: '0 1px 3px rgba(43,94,64,0.12)',
  } as React.CSSProperties,
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 16,
    padding: '0 4px',
    borderRadius: 8,
    fontSize: 10,
    fontWeight: 700,
    background: '#BDD1C3',
    color: '#2B5E40',
  } as React.CSSProperties,
  badgeActive: {
    background: '#D3E8D8',
    color: '#1E5432',
  } as React.CSSProperties,
  newBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 15px',
    borderRadius: 8,
    background: '#2B5E40',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    textDecoration: 'none',
    flexShrink: 0,
    minHeight: 36,
  } as React.CSSProperties,
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
}

const cardS = {
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '16px 20px',
    background: '#FFFFFF',
    borderRadius: 12,
    border: '1px solid #E5EDE7',
    borderLeftWidth: 4,
    boxShadow: '0 0.5px 0 rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.05)',
    textDecoration: 'none',
  } as React.CSSProperties,
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 10,
    background: '#E3EFE7',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' as const },
  body: { flex: 1, minWidth: 0 } as React.CSSProperties,
  name: {
    fontSize: 14,
    fontWeight: 700,
    color: '#192C1F',
    letterSpacing: '-0.2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    marginBottom: 4,
  } as React.CSSProperties,
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  metaChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#8AA491',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  right: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-end',
    gap: 5,
    flexShrink: 0,
  } as React.CSSProperties,
  badge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 20,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  date: { fontSize: 11, color: '#BDD1C3' } as React.CSSProperties,
}
