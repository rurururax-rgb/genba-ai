'use client'

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 22px',
        borderRadius: 8,
        background: '#FFFFFF',
        color: '#2B5E40',
        fontSize: 14,
        fontWeight: 700,
        border: '1.5px solid #6CB382',
        cursor: 'pointer',
        minHeight: 40,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 6 2 18 2 18 9"/>
        <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
        <rect x="6" y="14" width="12" height="8"/>
      </svg>
      印刷 / PDF保存
    </button>
  )
}
