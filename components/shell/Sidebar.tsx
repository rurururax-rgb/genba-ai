'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ── 型 ────────────────────────────────────────────────────

type TooltipPos = { top: number; left: number }

// ── pathname からプロジェクトIDを抽出 ────────────────────────

function getProjectId(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)/)
  return m ? m[1] : null
}

// ── SVGアイコン ─────────────────────────────────────────────

const Icons = {
  home: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  back: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6"/>
    </svg>
  ),
  estimate: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M9 21V9"/>
    </svg>
  ),
  import: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  ),
  spec: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  ),
  ledger: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
      <line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  ),
  info: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
  invoice: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="15" x2="15" y2="15"/>
      <line x1="9" y1="11" x2="15" y2="11"/>
    </svg>
  ),
  materials: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <path d="M8 21h8M12 17v4"/>
      <line x1="7" y1="8" x2="17" y2="8"/>
      <line x1="7" y1="12" x2="14" y2="12"/>
    </svg>
  ),
  vendorInvoice: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2 3-2V8z"/>
      <line x1="8" y1="10" x2="16" y2="10"/>
      <line x1="8" y1="14" x2="16" y2="14"/>
    </svg>
  ),
  chat: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
    </svg>
  ),
  schedule: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <line x1="8" y1="14" x2="16" y2="14"/>
      <line x1="8" y1="18" x2="14" y2="18"/>
    </svg>
  ),
} as const

// ── プロジェクトタブ定義 ──────────────────────────────────────

const PROJECT_TABS = [
  { id: 'info',        label: '基本情報',           icon: Icons.info },
  { id: 'estimate',    label: '見積エディタ',       icon: Icons.estimate },
  { id: 'invoice',     label: '請求書',             icon: Icons.invoice },
  { id: 'cost-ledger', label: '原価台帳',           icon: Icons.ledger },
  { id: 'spec-import', label: '仕様書等の取り込み', icon: Icons.spec },
  { id: 'schedule',    label: '工程表',             icon: Icons.schedule },
] as const

// ── フローティングツールチップ（position: fixed） ─────────────

function Tooltip({ label, pos }: { label: string; pos: TooltipPos }) {
  return (
    <div style={{
      position: 'fixed',
      top: pos.top,
      left: pos.left,
      transform: 'translateY(-50%)',
      background: 'linear-gradient(135deg, #253F2D 0%, #1A2E22 100%)',
      color: '#E8F4EB',
      padding: '7px 14px',
      borderRadius: 10,
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      zIndex: 9999,
      pointerEvents: 'none',
      border: '1px solid rgba(108,179,130,0.22)',
    }}>
      {/* 左向き三角 */}
      <span style={{
        position: 'absolute',
        left: -4,
        top: '50%',
        transform: 'translateY(-50%) rotate(45deg)',
        width: 8,
        height: 8,
        background: '#253F2D',
        borderLeft: '1px solid rgba(108,179,130,0.22)',
        borderBottom: '1px solid rgba(108,179,130,0.22)',
      }} />
      {label}
    </div>
  )
}

// ── アイコンボタン ───────────────────────────────────────────

function IconBtn({
  icon, label, active, onClick, href,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
  href?: string
}) {
  const [tooltip, setTooltip] = useState<TooltipPos | null>(null)
  const ref = useRef<HTMLElement>(null)

  const onEnter = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setTooltip({ top: r.top + r.height / 2, left: r.right + 14 })
    }
  }
  const onLeave = () => setTooltip(null)

  const style: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: active
      ? 'linear-gradient(135deg, #2B5E40, #1D4530)'
      : 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: active ? '#FFFFFF' : '#5E8A6E',
    boxShadow: active ? '0 4px 14px rgba(43,94,64,0.5)' : 'none',
    transition: 'all 0.18s',
    position: 'relative',
    textDecoration: 'none',
  }

  const indicator = active ? (
    <span style={{
      position: 'absolute',
      left: -1,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 3,
      height: 20,
      borderRadius: '0 2px 2px 0',
      background: '#6CB382',
      boxShadow: '0 0 7px rgba(108,179,130,0.8)',
    }} />
  ) : null

  const inner = (
    <>
      {indicator}
      {icon}
      {tooltip && <Tooltip label={label} pos={tooltip} />}
    </>
  )

  if (href) {
    return (
      <Link
        ref={ref as React.RefObject<HTMLAnchorElement>}
        href={href}
        style={style}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {inner}
      </Link>
    )
  }

  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      style={style}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {inner}
    </button>
  )
}

// ── Sidebar ─────────────────────────────────────────────────

export function Sidebar() {
  const pathname   = usePathname()
  const projectId  = getProjectId(pathname)
  const inProject  = Boolean(projectId)
  const [activeTab, setActiveTab] = useState('estimate')

  const dispatchTab = (id: string) => {
    setActiveTab(id)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('genba:tab', { detail: id }))
    }
  }

  return (
    <aside style={s.aside}>

      {/* ── ロゴアイコン ── */}
      <div style={s.logoWrap}>
        <div style={s.logoBox}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="#A3D9A5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
            <line x1="12" y1="2" x2="12" y2="22"/>
            <path d="M2 8.5l10 6.5 10-6.5"/>
          </svg>
        </div>
      </div>

      <div style={s.divider} />

      {/* ── メインナビ ── */}
      <nav style={s.nav}>

        {inProject ? (
          <>
            {/* プロジェクト内：戻るボタン */}
            <IconBtn icon={Icons.back} label="案件一覧に戻る" href="/projects" />

            {/* サブナビ仕切り */}
            <div style={s.subDivider} />

            {/* プロジェクトタブアイコン */}
            {PROJECT_TABS.map(t => (
              <IconBtn
                key={t.id}
                icon={t.icon}
                label={t.label}
                active={activeTab === t.id}
                onClick={() => dispatchTab(t.id)}
              />
            ))}

            <div style={{ flex: 1 }} />

            {/* AIチャット */}
            <IconBtn
              icon={Icons.chat}
              label="AIアシスタント"
              onClick={() => window.dispatchEvent(new CustomEvent('genba:open-chat'))}
            />
          </>
        ) : (
          <>
            <IconBtn
              icon={Icons.home}
              label="案件一覧"
              active={pathname.startsWith('/projects')}
              href="/projects"
            />
            <IconBtn
              icon={Icons.materials}
              label="資材マスター"
              active={pathname.startsWith('/materials')}
              href="/materials"
            />
            <div style={{ flex: 1 }} />
          </>
        )}

        <IconBtn
          icon={Icons.settings}
          label="設定"
          active={pathname === '/settings'}
          href="/settings"
        />
      </nav>

      {/* ── ステータスドット ── */}
      <div style={s.divider} />
      <div style={s.statusWrap}>
        <div style={s.statusDot} />
      </div>

    </aside>
  )
}

// ── スタイル ───────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  aside: {
    width: 68,
    flexShrink: 0,
    margin: '12px 0 12px 12px',
    height: 'calc(100dvh - 24px)',
    background: 'linear-gradient(160deg, #1B2F23 0%, #121D16 100%)',
    borderRadius: 20,
    boxShadow: '0 8px 40px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  logoWrap: {
    padding: '16px 0 14px',
    display: 'flex',
    justifyContent: 'center',
  },
  logoBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: 'linear-gradient(135deg, #2B5E40, #1A3D28)',
    border: '1px solid rgba(108,179,130,0.22)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
  },
  divider: {
    width: 36,
    height: 1,
    background: 'rgba(255,255,255,0.07)',
    borderRadius: 1,
  },
  subDivider: {
    width: 24,
    height: 1,
    background: 'rgba(108,179,130,0.18)',
    borderRadius: 1,
    margin: '6px 0',
  },
  nav: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '10px 0',
    width: '100%',
  },
  statusWrap: {
    display: 'flex',
    justifyContent: 'center',
    padding: '12px 0 16px',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#6CB382',
    boxShadow: '0 0 0 3px rgba(108,179,130,0.15)',
  },
}
