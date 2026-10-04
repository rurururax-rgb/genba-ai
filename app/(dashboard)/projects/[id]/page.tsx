import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ProjectTabs } from '@/components/projects/ProjectTabs'
import { ProjectHeader } from '@/components/projects/ProjectHeader'
import { ChatPanel } from '@/components/projects/ChatPanel'
import { getCurrentCompany } from '@/lib/company/current-company'
import { supportsLegacyRugsDocuments } from '@/lib/company/templates'
import { getInvoiceIssuerProfile } from '@/lib/company/rugs-invoice-issuer.server'
import { ProjectCheckedSummary } from '@/components/projects/ProjectCheckedSummary'
import { formatBillingFact, getEstimateAndSchedule, toBillingFact } from '@/lib/project/checked-summary'
import { CHAT_ENTRY_ENABLED } from '@/lib/trial-features'

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  collecting: { label: '情報収集中', color: '#6B7280', bg: '#F3F4F6' },
  reviewing:  { label: '確認中',     color: '#92400E', bg: '#FEF3C7' },
  estimating: { label: '見積作成中', color: '#9A3412', bg: '#FFEDD5' },
  scheduled:  { label: '工程作成済', color: '#1E40AF', bg: '#DBEAFE' },
  done:       { label: '完了',       color: '#166534', bg: '#DCFCE7' },
}

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}

export default async function ProjectDetailPage({ params, searchParams }: Props) {
  const { id: projectId } = await params
  const { tab: defaultTab } = await searchParams
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customer_name, site_address, status, person_in_charge, construction_period, payment_terms, estimate_valid_from, estimate_valid_months, construction_overview, project_memo, payment_contract_pct, payment_start_pct, payment_completion_pct')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single()

  if (!project) redirect('/projects')

  // ラグズ建築専用の legacy 帳票（請求書・挨拶状）を使える会社か（lib/company/templates.ts）
  const company = await getCurrentCompany(supabase, user.id)
  const legacyRugsDocuments = supportsLegacyRugsDocuments(company)
  // 請求書の発行者情報（振込先など）はサーバー専用。対象会社のときだけクライアントへ渡す（他社は null）
  const invoiceIssuer = getInvoiceIssuerProfile(company)

  // 請求書・見積データから実績ステータスを導出
  const [{ data: invoices, error: invoicesError }, { data: estimates }, checked] = await Promise.all([
    supabase
      .from('invoice_documents')
      .select('status, printed_at, payment_due_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(1),
    supabase
      .from('estimate_items')
      .select('id')
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .limit(1),
    // 「RAGZが確認しました」の見積合計（見積画面と同じ共有計算）・施工中／次の工程
    getEstimateAndSchedule(supabase, projectId),
  ])

  const latestInv = invoices?.[0]
  if (invoicesError) console.error('[project page] invoice query failed:', invoicesError.message)
  const billing = invoicesError ? null : toBillingFact(latestInv)
  const hasEstimate = (estimates?.length ?? 0) > 0

  let cfg: { label: string; color: string; bg: string }
  if (latestInv?.printed_at) {
    cfg = { label: '請求書出力済み', color: '#5B21B6', bg: '#EDE9FE' }
  } else if (latestInv?.status === 'paid') {
    cfg = { label: '入金済み',       color: '#166534', bg: '#DCFCE7' }
  } else if (latestInv?.status === 'issued') {
    cfg = { label: '請求書発行済み', color: '#1E40AF', bg: '#DBEAFE' }
  } else if (latestInv) {
    cfg = { label: '請求書作成中',   color: '#92400E', bg: '#FEF3C7' }
  } else if (hasEstimate) {
    cfg = { label: '見積作成中',     color: '#9A3412', bg: '#FFEDD5' }
  } else {
    cfg = STATUS_CONFIG[project.status] ?? { label: project.status, color: '#6B7280', bg: '#F3F4F6' }
  }

  return (
    <div style={{ background: '#F3F7F4', minHeight: '100vh' }}>

      {/* ── ヘッダー ── */}
      <ProjectHeader
        projectName={project.name}
        badgeLabel={cfg.label}
        badgeColor={cfg.color}
        badgeBg={cfg.bg}
        customerName={project.customer_name}
        siteAddress={project.site_address}
      />

      {/* ── RAGZが確認しました（確定した事実のみ・表示だけ） ── */}
      <ProjectCheckedSummary
        estimateTotal={checked.estimateTotal}
        estimateItemCount={checked.estimateItemCount}
        billing={formatBillingFact(billing, latestInv?.payment_due_at)}
        schedule={checked.schedule}
      />

      {/* ── タブコンテンツ ── */}
      <ProjectTabs
        projectId={projectId}
        projectInfo={{
          id: project.id,
          name: project.name,
          customer_name: project.customer_name,
          site_address: project.site_address,
          person_in_charge: (project as Record<string, unknown>).person_in_charge as string | null ?? null,
          construction_period: (project as Record<string, unknown>).construction_period as string | null ?? null,
          payment_terms: (project as Record<string, unknown>).payment_terms as string | null ?? null,
          estimate_valid_from: (project as Record<string, unknown>).estimate_valid_from as string | null ?? null,
          estimate_valid_months: (project as Record<string, unknown>).estimate_valid_months as number | null ?? null,
          construction_overview: (project as Record<string, unknown>).construction_overview as string | null ?? null,
          project_memo: (project as Record<string, unknown>).project_memo as string | null ?? null,
          payment_contract_pct: (project as Record<string, unknown>).payment_contract_pct as number | null ?? null,
          payment_start_pct: (project as Record<string, unknown>).payment_start_pct as number | null ?? null,
          payment_completion_pct: (project as Record<string, unknown>).payment_completion_pct as number | null ?? null,
        }}
        defaultTab={defaultTab}
        legacyRugsDocuments={legacyRugsDocuments}
        invoiceIssuer={invoiceIssuer}
      />

      {/* ── AIチャットパネル（Trial では入口を出さないため描画しない。lib/trial-features.ts） ── */}
      {CHAT_ENTRY_ENABLED && <ChatPanel projectId={projectId} />}

    </div>
  )
}

// ── スタイル ───────────────────────────────────────────────

const hdr = {
  wrap: {
    background: '#FFFFFF',
    padding: '16px 20px 20px',
    borderBottom: '1px solid #E8ECF6',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },

  back: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 8,
    background: '#E3EFE7',
    textDecoration: 'none',
  } as React.CSSProperties,

  badge: {
    display: 'inline-flex',
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 10px',
    borderRadius: 20,
    letterSpacing: '0.02em',
  } as React.CSSProperties,

  title: {
    fontSize: 22,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: '-0.4px',
    margin: 0,
    lineHeight: 1.3,
  } as React.CSSProperties,

  meta: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 12,
    marginTop: 2,
  },

  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  } as React.CSSProperties,

  metaText: {
    fontSize: 13,
    color: '#94A3B8',
  } as React.CSSProperties,
}
