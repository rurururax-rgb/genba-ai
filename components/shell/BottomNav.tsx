'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  {
    href: '/projects', label: '案件一覧',
    icon: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
        stroke={active ? '#6CB382' : '#4E7A5B'} strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
  },
  {
    href: '/materials', label: '資材マスター',
    icon: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
        stroke={active ? '#6CB382' : '#4E7A5B'} strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <path d="M8 21h8M12 17v4"/>
        <line x1="7" y1="8" x2="17" y2="8"/>
        <line x1="7" y1="12" x2="14" y2="12"/>
      </svg>
    ),
  },
] as const

export function BottomNav() {
  const pathname = usePathname()
  function isActive(href: string) {
    if (href === '/projects') return pathname.startsWith('/projects')
    if (href === '/materials') return pathname.startsWith('/materials')
    return pathname === href
  }

  return (
    <nav style={s.nav}>
      {TABS.map(({ href, label, icon }) => {
        const active = isActive(href)
        return (
          <Link key={href} href={href} style={{ ...s.tab, ...(active ? s.tabActive : {}) }}>
            {icon(active)}
            <span style={{
              fontSize: 10,
              fontWeight: active ? 700 : 400,
              color: active ? '#6CB382' : '#4E7A5B',
              letterSpacing: '0.01em',
              marginTop: 1,
            }}>
              {label}
            </span>
            {active && <span style={s.activePip} />}
          </Link>
        )
      })}
    </nav>
  )
}

const s: Record<string, React.CSSProperties> = {
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    height: 'calc(56px + env(safe-area-inset-bottom))',
    paddingBottom: 'env(safe-area-inset-bottom)',
    background: '#1A2E22',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    zIndex: 100,
  },
  tab: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    textDecoration: 'none',
    position: 'relative',
  },
  tabActive: {},
  activePip: {
    position: 'absolute',
    bottom: 0,
    width: 24,
    height: 2,
    borderRadius: '2px 2px 0 0',
    background: '#6CB382',
  },
}
