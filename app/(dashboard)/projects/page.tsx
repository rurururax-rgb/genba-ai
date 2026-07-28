import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'

// ── ステータス定義 ──────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  collecting: { label: '情報収集中', bg: '#F3F4F6', text: '#374151', dot: '#9CA3AF' },
  reviewing:  { label: '確認中',     bg: '#FFFBEB', text: '#92400E', dot: '#D97706' },
  estimating: { label: '見積作成中', bg: '#FFF7ED', text: '#9A3412', dot: '#EA580C' },
  scheduled:  { label: '工程作成済', bg: '#EFF6FF', text: '#1E40AF', dot: '#2563EB' },
  done:       { label: '完了',       bg: '#F0FDF4', text: '#166534', dot: '#16A34A' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 6,
      fontSize: 11, fontWeight: 600, lineHeight: 1.4,
      background: cfg.bg, color: cfg.text,
      whiteSpace: 'nowrap' as const,
    }}>
      {cfg.label}
    </span>
  )
}

// ── ページ ─────────────────────────────────────────────────

export default async function ProjectsPage() {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, customer_name, site_address, status, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  // 各案件の最初の写真サムネイルを取得
  const projectIds = projects?.map(p => p.id) ?? []
  const thumbMap: Record<string, string> = {}

  if (projectIds.length > 0) {
    const { data: photos } = await supabase
      .from('project_files')
      .select('project_id, thumb_path')
      .in('project_id', projectIds)
      .eq('file_type', 'photo')
      .not('thumb_path', 'is', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    // project_id ごとに最初の1枚だけ抽出
    const firstPhotos = new Map<string, string>()
    for (const f of photos ?? []) {
      if (!firstPhotos.has(f.project_id) && f.thumb_path) {
        firstPhotos.set(f.project_id, f.thumb_path)
      }
    }

    // signed URL を並列生成（5分有効）
    await Promise.all([...firstPhotos.entries()].map(async ([pid, path]) => {
      const { data } = await supabase.storage.from('genba-ai').createSignedUrl(path, 300)
      if (data?.signedUrl) thumbMap[pid] = data.signedUrl
    }))
  }

  const active   = projects?.filter(p => p.status !== 'done') ?? []
  const finished = projects?.filter(p => p.status === 'done') ?? []

  return (
    <div style={page.container}>

      {/* ── ページヘッダー ── */}
      <div style={page.header}>
        <h1 style={page.title}>案件一覧</h1>
        <LogoutForm />
      </div>

      {/* ── 案件リスト ── */}
      {!projects?.length ? (
        <div style={page.emptyWrap}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏗</div>
          <p style={page.emptyText}>案件がありません</p>
          <p style={page.emptySubtext}>
            LINEから現場情報を送ると、ここに案件が表示されます
          </p>
        </div>
      ) : (
        <>
          {/* 進行中 */}
          {active.length > 0 && (
            <section>
              <div style={page.sectionLabel}>進行中 ({active.length})</div>
              <div style={page.list}>
                {active.map(p => <ProjectCard key={p.id} project={p} thumbUrl={thumbMap[p.id]} />)}
              </div>
            </section>
          )}

          {/* 完了 */}
          {finished.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <div style={page.sectionLabel}>完了 ({finished.length})</div>
              <div style={page.list}>
                {finished.map(p => <ProjectCard key={p.id} project={p} thumbUrl={thumbMap[p.id]} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ── カードコンポーネント ────────────────────────────────────

type Project = {
  id: string
  name: string
  customer_name: string | null
  site_address: string | null
  status: string
  updated_at: string
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return '今日'
  if (days === 1) return '昨日'
  if (days < 7)  return `${days}日前`
  return new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
}

/* eslint-disable @next/next/no-img-element */
function ProjectCard({ project: p, thumbUrl }: { project: Project; thumbUrl?: string }) {
  const cfg = STATUS_CONFIG[p.status] ?? { label: p.status, bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF' }

  return (
    <Link href={`/projects/${p.id}`} style={card.root}>
      {/* 左: サムネイル or アイコン */}
      <div style={card.icon}>
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }}
          />
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="#9CA3AF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        )}
      </div>

      {/* 中: 情報 */}
      <div style={card.body}>
        <div style={card.name}>{p.name}</div>

        {/* 住所（1行目） */}
        {p.site_address && (
          <div style={card.subRow}>
            <svg width="8" height="10" viewBox="0 0 8 10" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
              <path d="M4 0C2.07 0 .5 1.57.5 3.5c0 2.625 3.5 6.5 3.5 6.5s3.5-3.875 3.5-6.5C7.5 1.57 5.93 0 4 0zm0 4.75a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" fill="#C9D0DC"/>
            </svg>
            <span style={card.sub}>{p.site_address}</span>
          </div>
        )}

        {/* 顧客名（住所がない場合のみ2行目に表示） */}
        {!p.site_address && p.customer_name && (
          <div style={card.subRow}>
            <span style={card.sub}>{p.customer_name}</span>
          </div>
        )}

        {/* ステータス + 更新日 */}
        <div style={card.meta}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: cfg.dot, flexShrink: 0, display: 'inline-block',
            }} />
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '2px 6px', borderRadius: 5,
              fontSize: 11, fontWeight: 600, lineHeight: 1.4,
              background: cfg.bg, color: cfg.text,
              whiteSpace: 'nowrap' as const,
            }}>
              {cfg.label}
            </span>
          </span>
          <span style={card.date}>{relativeDate(p.updated_at)}</span>
        </div>
      </div>

      {/* 右: シェブロン */}
      <div style={card.chevron}>
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M1 1l5 5-5 5" stroke="#C9D0DC" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </Link>
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
  container:    { maxWidth: 680, margin: '0 auto', padding: '0 0 32px' },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 16px 16px',
  },
  title: {
    fontSize: 22, fontWeight: 700, color: '#0D1117',
    letterSpacing: '-0.5px', margin: 0,
  },
  logoutBtn: {
    fontSize: 13, color: '#9CA3AF', background: 'none',
    border: 'none', cursor: 'pointer', padding: '4px 0',
  },
  sectionLabel: {
    fontSize: 11, fontWeight: 500, textTransform: 'uppercase' as const,
    letterSpacing: '0.5px', color: '#9CA3AF',
    padding: '0 16px', marginBottom: 8,
  },
  list:         { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '0 16px' },
  emptyWrap:    { padding: '60px 16px', textAlign: 'center' as const },
  emptyText:    { margin: 0, color: '#6B7280', fontSize: 15 },
  emptySubtext: { margin: '8px 0 0', color: '#9CA3AF', fontSize: 13 },
} as const

const card = {
  root: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '14px 16px',
    background: '#FFFFFF', borderRadius: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04)',
    textDecoration: 'none',
  },
  icon: {
    width: 44, height: 44, borderRadius: 12,
    background: '#F5F7FA',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  body:  { flex: 1, minWidth: 0 },
  name:  {
    fontSize: 15, fontWeight: 600, color: '#0D1117',
    letterSpacing: '-0.2px', marginBottom: 3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  subRow: {
    display: 'flex', alignItems: 'flex-start', gap: 4, marginBottom: 5,
  },
  sub:   {
    fontSize: 12, color: '#9CA3AF',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  meta:  { display: 'flex', alignItems: 'center', gap: 8 },
  date:  { fontSize: 11, color: '#C9D0DC' },
  chevron: { flexShrink: 0, paddingLeft: 4 },
} as const
