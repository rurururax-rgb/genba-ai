'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/projects', label: '案件一覧', icon: BuildingIcon },
  { href: '/settings', label: '設定',     icon: SettingsIcon },
] as const

export function Sidebar() {
  const pathname = usePathname()

  function isActive(href: string) {
    if (href === '/projects') return pathname.startsWith('/projects')
    return pathname === href
  }

  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        background: '#0D2540',
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        overflowY: 'auto',
      }}
    >
      {/* ロゴ */}
      <div style={{ padding: '20px 20px 16px' }}>
        <span style={{
          fontSize: 17, fontWeight: 700, color: '#FFFFFF',
          letterSpacing: '-0.3px',
        }}>
          現場AI
        </span>
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', marginInline: 12 }} />

      {/* ナビゲーション */}
      <nav style={{ padding: '12px 8px', flex: 1 }}>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(href)
          return (
            <Link
              key={href}
              href={href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                marginBottom: 2,
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                color: active ? '#FFFFFF' : 'rgba(255,255,255,0.55)',
                background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                textDecoration: 'none',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              <Icon active={active} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* フッター（将来のユーザー情報欄） */}
      <div style={{ padding: '12px 12px 24px' }}>
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', marginBottom: 12 }} />
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.04em' }}>
          現場AI v1.0
        </div>
      </div>
    </aside>
  )
}

// ──────────────────────────────────────────────────────────
// アイコン（SVG inline）
// ──────────────────────────────────────────────────────────

function BuildingIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#FFFFFF' : 'rgba(255,255,255,0.55)'}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  )
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#FFFFFF' : 'rgba(255,255,255,0.55)'}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
