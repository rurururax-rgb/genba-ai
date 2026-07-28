'use client'

import { useState } from 'react'
import { AiMemoPanel }  from './AiMemoPanel'
import { EstimateTab }  from './EstimateTab'
import { PhotoMemoTab } from './PhotoMemoTab'

type Tab = '写真・メモ' | 'AI整理' | '見積'
const TABS: Tab[] = ['写真・メモ', 'AI整理', '見積']

export function ProjectTabs({ projectId }: { projectId: string }) {
  const [active, setActive] = useState<Tab>('AI整理')

  return (
    <>
      {/* タブバー */}
      <div style={tabBarStyle}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActive(tab)}
            style={{ ...tabStyle, ...(active === tab ? tabActiveStyle : {}) }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {active === 'AI整理'   && <AiMemoPanel  projectId={projectId} />}
      {active === '見積'     && <EstimateTab   projectId={projectId} />}
      {active === '写真・メモ' && <PhotoMemoTab  projectId={projectId} />}
    </>
  )
}

// ──────────────────────────────────────────────────────────
// タブバースタイル（3タブ共通・統一デザイン）
// ──────────────────────────────────────────────────────────

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  background: '#FFFFFF',
  borderBottom: '1px solid #E4E8EE',
  margin: '0 0 0',
  padding: '0 16px',
  gap: 0,
}

const tabStyle: React.CSSProperties = {
  flex: 1,
  padding: '12px 0',
  fontSize: 14,
  fontWeight: 400,
  color: '#9CA3AF',
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  cursor: 'pointer',
  letterSpacing: '-0.1px',
  transition: 'color 0.15s, border-color 0.15s',
}

const tabActiveStyle: React.CSSProperties = {
  color: '#0A84FF',
  fontWeight: 600,
  borderBottom: '2px solid #0A84FF',
}
