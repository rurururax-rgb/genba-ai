import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ProjectTabs } from '@/components/projects/ProjectTabs'

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  collecting: { label: '情報収集中', bg: '#F3F4F6', text: '#374151', dot: '#9CA3AF' },
  reviewing:  { label: '確認中',     bg: '#FFFBEB', text: '#92400E', dot: '#D97706' },
  estimating: { label: '見積作成中', bg: '#FFF7ED', text: '#9A3412', dot: '#EA580C' },
  scheduled:  { label: '工程作成済', bg: '#EFF6FF', text: '#1E40AF', dot: '#2563EB' },
  done:       { label: '完了',       bg: '#F0FDF4', text: '#166534', dot: '#16A34A' },
}

type Props = {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: Props) {
  const { id: projectId } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customer_name, site_address, status')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single()

  if (!project) redirect('/projects')

  const cfg = STATUS_CONFIG[project.status] ?? {
    label: project.status, bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF',
  }

  // 住所・顧客名のどちらかを副情報として表示
  const subInfo = project.site_address ?? project.customer_name

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>

      {/* ── ヘッダー（3段構成） ── */}
      <div style={headerStyle}>

        {/* 1段目: 戻るリンク */}
        <a href="/projects" style={backLinkStyle}>
          <svg width="7" height="12" viewBox="0 0 7 12" fill="none" style={{ marginRight: 4, flexShrink: 0 }}>
            <path d="M6 1L1 6l5 5" stroke="#0A84FF" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          案件一覧
        </a>

        {/* 2段目: 案件名 */}
        <h1 style={titleStyle}>{project.name}</h1>

        {/* 3段目: ステータスバッジ + 住所 */}
        <div style={metaRowStyle}>
          {/* カラードット + バッジ */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: cfg.dot, flexShrink: 0,
              display: 'inline-block',
            }} />
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '2px 7px', borderRadius: 5,
              fontSize: 11, fontWeight: 600, lineHeight: 1.4,
              background: cfg.bg, color: cfg.text,
              whiteSpace: 'nowrap' as const,
            }}>
              {cfg.label}
            </span>
          </span>

          {/* 住所 or 顧客名 */}
          {subInfo && (
            <span style={subInfoStyle}>
              <svg width="9" height="11" viewBox="0 0 9 11" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d="M4.5 0C2.57 0 1 1.57 1 3.5c0 2.625 3.5 7 3.5 7S8 6.125 8 3.5C8 1.57 6.43 0 4.5 0zm0 4.75a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z"
                  fill="#C9D0DC"
                />
              </svg>
              {subInfo}
            </span>
          )}
        </div>

      </div>

      {/* ── タブ（Client Component） ── */}
      <ProjectTabs projectId={projectId} />
    </div>
  )
}

// ── スタイル ───────────────────────────────────────────────

const headerStyle: React.CSSProperties = {
  padding: '12px 16px 14px',
  background: '#FFFFFF',
  borderBottom: '1px solid #E4E8EE',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
}

const backLinkStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#0A84FF',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  fontWeight: 500,
  marginBottom: 2,
}

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: '#0D1117',
  letterSpacing: '-0.4px',
  margin: 0,
  lineHeight: 1.25,
}

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap' as const,
}

const subInfoStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  color: '#9CA3AF',
}
