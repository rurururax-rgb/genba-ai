'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'
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
// ── タブ定義 ───────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'info',        label: '基本情報',           icon: <InfoIcon /> },
  { id: 'estimate',    label: '見積エディタ',       icon: <EstimateIcon /> },
  { id: 'invoice',     label: '請求書',             icon: <InvoiceIcon /> },
  { id: 'spec-import', label: '仕様書等の取り込み', icon: <SpecIcon /> },
  { id: 'cost-ledger', label: '原価台帳',           icon: <LedgerIcon /> },
]

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
  const tab: Tab = requestedTab === 'invoice' && !invoiceAvailable ? 'estimate' : requestedTab

  // グローバルサイドバーからのタブ切替イベントを受信
  useEffect(() => {
    const handler = (e: Event) => {
      const newTab = (e as CustomEvent<string>).detail as Tab
      setTab(newTab)
    }
    window.addEventListener('genba:tab', handler)
    return () => window.removeEventListener('genba:tab', handler)
  }, [])

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

  return content
}

// ── スタイル ───────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
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
    padding: '9px 12px',
    fontSize: 11,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    transition: 'color 0.15s',
  },
}
