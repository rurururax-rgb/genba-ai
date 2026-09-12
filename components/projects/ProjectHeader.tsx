'use client'

import { useEffect, useState } from 'react'

type Props = {
  projectName: string
  badgeLabel: string
  badgeColor: string
  badgeBg: string
  customerName: string | null
  siteAddress: string | null
}

export function ProjectHeader({
  projectName, badgeLabel, badgeColor, badgeBg, customerName, siteAddress,
}: Props) {
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: Event) => setTotal((e as CustomEvent<number>).detail)
    window.addEventListener('genba:total', handler)
    return () => window.removeEventListener('genba:total', handler)
  }, [])

  const fmt = (n: number) => n.toLocaleString('ja-JP')

  return (
    <div style={{
      background: '#FFFFFF', borderBottom: '1px solid #E8ECF6',
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 16px', height: 48, flexShrink: 0,
    }}>
      {/* 戻るボタン */}
      <a href="/projects" style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 7, background: '#E3EFE7', textDecoration: 'none', flexShrink: 0,
      }}>
        <svg width="8" height="13" viewBox="0 0 9 15" fill="none">
          <path d="M7.5 1.5L2 7.5l5.5 6" stroke="#3D7A55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </a>

      {/* ステータスバッジ */}
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
        color: badgeColor, background: badgeBg,
        flexShrink: 0, letterSpacing: '0.02em',
      }}>
        {badgeLabel}
      </span>

      {/* 案件名 */}
      <h1 style={{
        fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0,
        letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {projectName}
      </h1>

      <div style={{ flex: 1 }} />

      {/* メタ情報 */}
      {customerName && (
        <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {customerName}
        </span>
      )}
      {siteAddress && (
        <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {siteAddress}
        </span>
      )}
    </div>
  )
}
