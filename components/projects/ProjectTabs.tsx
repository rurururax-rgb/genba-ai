'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'
import { publishActiveProjectTab } from '@/lib/project/active-tab'
import { EstimateTab } from './EstimateTab'
import { SpecImportTab } from './SpecImportTab'
import { CostLedgerTab } from './CostLedgerTab'
import { ProjectInfoPanel } from './ProjectInfoPanel'

// 請求書はラグズ建築専用の legacy 帳票。対象会社で実際に開いたときだけ読み込む。
// 振込先・登録番号・住所などの発行者情報はこのコードには含まれず、サーバーが対象会社にだけ props で渡す
const InvoiceTab = dynamic(() => import('./InvoiceTab').then(m => m.InvoiceTab))
import { ScheduleTab } from './ScheduleTab'

type Tab = 'estimate' | 'spec-import' | 'cost-ledger' | 'info' | 'invoice' | 'schedule'

type ProjectInfo = {
  id: string
  name: string | null
  customer_name: string | null
  site_address: string | null
  person_in_charge: string | null
  construction_period: string | null
  payment_terms: string | null
  estimate_valid_from: string | null
  estimate_valid_months: number | null
  construction_overview: string | null
  project_memo: string | null
  payment_contract_pct: number | null
  payment_start_pct: number | null
  payment_completion_pct: number | null
}

// ── アイコン ────────────────────────────────────────────────

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}
function EstimateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M9 21V9"/>
    </svg>
  )
}
function SpecIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  )
}
function LedgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
      <line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  )
}
function InvoiceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="15" x2="15" y2="15"/>
      <line x1="9" y1="11" x2="15" y2="11"/>
    </svg>
  )
}
function ScheduleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  )
}
// ── タブ定義 ───────────────────────────────────────────────

// スマホ幅（サイドバー非表示の lg 未満）で使う案件内タブ。並びはサイドバー（components/shell/Sidebar.tsx）と同じ
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'info',        label: '基本情報', icon: <InfoIcon /> },
  { id: 'estimate',    label: '見積',     icon: <EstimateIcon /> },
  { id: 'invoice',     label: '請求書',   icon: <InvoiceIcon /> },
  { id: 'cost-ledger', label: '原価台帳', icon: <LedgerIcon /> },
  { id: 'spec-import', label: '取り込み', icon: <SpecIcon /> },
  { id: 'schedule',    label: '工程表',   icon: <ScheduleIcon /> },
]

/** 実際に表示するタブ。未知の ID は見積、請求書は対象会社以外では見積に戻す */
export function resolveProjectTab(requested: string | null | undefined, invoiceAvailable: boolean): Tab {
  const known = TABS.some(t => t.id === requested) ? (requested as Tab) : 'estimate'
  return known === 'invoice' && !invoiceAvailable ? 'estimate' : known
}

// ── コンポーネント ─────────────────────────────────────────

export function ProjectTabs({
  projectId,
  projectInfo,
  defaultTab,
  legacyRugsDocuments = false,
  invoiceIssuer = null,
}: {
  projectId: string
  projectInfo: ProjectInfo
  defaultTab?: string
  /** ラグズ建築専用の legacy 帳票（請求書・挨拶状）を使える会社か。既定は false */
  legacyRugsDocuments?: boolean
  /** 請求書の発行者情報（振込先など）。サーバーが対象会社のときだけ渡す。他社・未設定では null */
  invoiceIssuer?: InvoiceIssuerProfile | null
}) {
  const [requestedTab, setTab] = useState<Tab>((defaultTab as Tab) || 'estimate')
  // 請求書タブは対象会社のみ。URL（?tab=invoice）やイベントで指定されても、他社では見積タブに戻す
  const invoiceAvailable = legacyRugsDocuments && invoiceIssuer != null
  const tab = resolveProjectTab(requestedTab, invoiceAvailable)

  // グローバルサイドバーからのタブ切替イベントを受信
  useEffect(() => {
    const handler = (e: Event) => {
      const newTab = (e as CustomEvent<string>).detail as Tab
      setTab(newTab)
    }
    window.addEventListener('genba:tab', handler)
    return () => window.removeEventListener('genba:tab', handler)
  }, [])

  // 実際に表示しているタブをサイドバーへ伝える（サイドバーの active 表示の唯一の情報源）
  useEffect(() => {
    publishActiveProjectTab(tab)
  }, [tab])
  useEffect(() => () => publishActiveProjectTab(null), [])

  const content = (
    <>
      {tab === 'info'        && <ProjectInfoPanel project={projectInfo} legacyRugsDocuments={legacyRugsDocuments} />}
      {tab === 'estimate'    && <EstimateTab projectId={projectId} legacyRugsDocuments={legacyRugsDocuments} />}
      {tab === 'invoice'     && invoiceAvailable && invoiceIssuer && <InvoiceTab projectId={projectId} projectInfo={projectInfo} issuer={invoiceIssuer} />}
      {tab === 'spec-import' && <SpecImportTab projectId={projectId} />}
      {tab === 'cost-ledger' && <CostLedgerTab projectId={projectId} />}
      {tab === 'schedule'    && <ScheduleTab projectId={projectId} />}
    </>
  )

  // lg 以上はサイドバー（genba:tab）で切り替える。lg 未満はサイドバーが無いので同じタブをここに出す。
  // 請求書は legacy 帳票を使える会社だけ（上の invoiceAvailable と同じ条件）
  const mobileTabs = TABS.filter(t => t.id !== 'invoice' || invoiceAvailable)

  return (
    <>
      <nav aria-label="案件内の画面" className="flex lg:hidden no-print" style={s.tabBar}>
        {mobileTabs.map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              style={{
                ...s.tabItem,
                color: active ? '#1D4530' : '#64748B',
                fontWeight: active ? 700 : 500,
                borderBottom: active ? '2px solid #2B5E40' : '2px solid transparent',
              }}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </nav>
      {content}
    </>
  )
}

// ── スタイル ───────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  // display はクラス（flex lg:hidden）で切り替える。inline に書くと lg:hidden が効かない
  tabBar: {
    overflowX: 'auto',
    background: '#FFFFFF',
    borderBottom: '1px solid #E8ECF6',
    padding: '0 8px',
    WebkitOverflowScrolling: 'touch',
  },
  tabItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '6px 12px',
    minHeight: 48,
    fontSize: 11,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    transition: 'color 0.15s',
  },
}
