import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ProjectListClient } from '@/components/projects/ProjectListClient'
import { DashboardSummarySection } from '@/components/projects/DashboardSummarySection'
import { getCompanyProjectSummary } from '@/lib/services/company-summary'
import { getDailyBriefingItems } from '@/lib/services/daily-briefing'

// ── ステータス定義 ──────────────────────────────────────────

export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  collecting: { label: '情報収集中', color: '#6B7280', bg: '#F3F4F6' },
  reviewing:  { label: '確認中',     color: '#92400E', bg: '#FEF3C7' },
  estimating: { label: '見積作成中', color: '#9A3412', bg: '#FFEDD5' },
  scheduled:  { label: '工程作成済', color: '#1E40AF', bg: '#DBEAFE' },
  done:       { label: '完了',       color: '#166534', bg: '#DCFCE7' },
}

type BadgeInfo = { label: string; color: string; bg: string; border: string }

// ── ページ ─────────────────────────────────────────────────

export default async function ProjectsPage() {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 会社全体サマリー・今日やること・案件一覧を並列取得
  const [summaryResult, actionItemsResult, projectsResult] = await Promise.all([
    getCompanyProjectSummary(supabase),
    getDailyBriefingItems(supabase),
    supabase
      .from('projects')
      .select('id, name, customer_name, site_address, status, updated_at')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false }),
  ])

  const summary     = summaryResult
  const actionItems = actionItemsResult

  // 案件一覧
  const { data: projects } = projectsResult

  const projectIds = projects?.map(p => p.id) ?? []

  // ── サムネイル・請求書・見積 を並列取得 ─────────────────

  const [photosRes, invoicesRes, estimatesRes] = await Promise.all([
    projectIds.length > 0
      ? supabase
          .from('project_files')
          .select('project_id, thumb_path')
          .in('project_id', projectIds)
          .eq('file_type', 'photo')
          .not('thumb_path', 'is', null)
          .is('deleted_at', null)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [] }),

    projectIds.length > 0
      ? supabase
          .from('invoice_documents')
          .select('project_id, status, printed_at')
          .in('project_id', projectIds)
          .order('updated_at', { ascending: false })
      : Promise.resolve({ data: [] }),

    projectIds.length > 0
      ? supabase
          .from('estimate_items')
          .select('project_id')
          .in('project_id', projectIds)
          .is('deleted_at', null)
          .limit(1000)
      : Promise.resolve({ data: [] }),
  ])

  // ── サムネイル signed URL ──────────────────────────────

  const thumbMap: Record<string, string> = {}
  const firstPhotos = new Map<string, string>()
  for (const f of photosRes.data ?? []) {
    if (!firstPhotos.has(f.project_id) && f.thumb_path) {
      firstPhotos.set(f.project_id, f.thumb_path)
    }
  }
  await Promise.all([...firstPhotos.entries()].map(async ([pid, path]) => {
    const { data } = await supabase.storage.from('genba-ai').createSignedUrl(path, 300)
    if (data?.signedUrl) thumbMap[pid] = data.signedUrl
  }))

  // ── 請求書マップ（案件ごとに最新1件） ─────────────────

  const invoiceMap: Record<string, { status: string; printed_at: string | null }> = {}
  for (const inv of invoicesRes.data ?? []) {
    if (!invoiceMap[inv.project_id]) {
      invoiceMap[inv.project_id] = { status: inv.status, printed_at: inv.printed_at }
    }
  }

  // ── 見積あり案件セット ─────────────────────────────────

  const hasEstimate = new Set((estimatesRes.data ?? []).map((e: { project_id: string }) => e.project_id))

  // ── 実績ステータス導出 ─────────────────────────────────
  // projects.status は手動設定のため、実際の作業データから自動導出する。
  // フォールバック時のみ projects.status を使う。

  const derivedBadgeMap: Record<string, BadgeInfo> = {}

  for (const pid of projectIds) {
    const inv = invoiceMap[pid]
    if (inv) {
      if (inv.printed_at) {
        derivedBadgeMap[pid] = { label: '請求書出力済み', color: '#5B21B6', bg: '#EDE9FE', border: '#8B5CF6' }
      } else if (inv.status === 'paid') {
        derivedBadgeMap[pid] = { label: '入金済み',       color: '#166534', bg: '#DCFCE7', border: '#22C55E' }
      } else if (inv.status === 'issued') {
        derivedBadgeMap[pid] = { label: '請求書発行済み', color: '#1E40AF', bg: '#DBEAFE', border: '#3B82F6' }
      } else {
        derivedBadgeMap[pid] = { label: '請求書作成中',   color: '#92400E', bg: '#FEF3C7', border: '#F59E0B' }
      }
    } else if (hasEstimate.has(pid)) {
      derivedBadgeMap[pid] = { label: '見積作成中',       color: '#9A3412', bg: '#FFEDD5', border: '#FB923C' }
    }
    // それ以外は ProjectListClient 側で projects.status を使う
  }

  return (
    <div style={{ background: '#F3F7F4', minHeight: '100vh' }}>
      <div style={page.inner}>

        {/* ── ページヘッダー ── */}
        <div style={page.header}>
          <div>
            <p style={page.eyebrow}>DASHBOARD</p>
            <h1 style={page.title}>案件一覧</h1>
          </div>
          <LogoutForm />
        </div>

        {/* ── 今日やること（決定論的判定。AIに生成させない） ── */}
        <DashboardSummarySection summary={summary} actionItems={actionItems} />

        {/* ── クライアントリスト ── */}
        <ProjectListClient
          projects={projects ?? []}
          thumbMap={thumbMap}
          statusConfig={STATUS_CONFIG}
          derivedBadgeMap={derivedBadgeMap}
        />

      </div>
    </div>
  )
}

// ── ログアウト ─────────────────────────────────────────────

function LogoutForm() {
  async function logout() {
    'use server'
    const supabase = await getServerClient()
    await supabase.auth.signOut()
    redirect('/login')
  }
  return (
    <form action={logout}>
      <button type="submit" style={page.logoutBtn}>ログアウト</button>
    </form>
  )
}

// ── スタイル ───────────────────────────────────────────────

const page = {
  inner: { maxWidth: 1100, margin: '0 auto', padding: '0 0 80px' },
  header: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    padding: '40px 32px 28px',
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: 700,
    color: '#6CB382',
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    margin: '0 0 4px',
  },
  title: {
    fontSize: 28,
    fontWeight: 900,
    color: '#192C1F',
    letterSpacing: '-0.6px',
    margin: 0,
  },
  logoutBtn: {
    fontSize: 13,
    color: '#8AA491',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px 0',
  },
} as const
