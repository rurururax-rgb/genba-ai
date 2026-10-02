import { Sidebar }   from '@/components/shell/Sidebar'
import { BottomNav } from '@/components/shell/BottomNav'
import { getServerClient } from '@/lib/supabase/server'
import { getCurrentCompany } from '@/lib/company/current-company'
import { supportsLegacyRugsDocuments } from '@/lib/company/templates'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // ラグズ建築専用の legacy 帳票（請求書など）への導線は、対象会社にだけ出す。
  // 未ログイン・会社情報が取れない場合は出さない（Fail Closed）
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const company = user ? await getCurrentCompany(supabase, user.id) : null
  const legacyRugsDocuments = supportsLegacyRugsDocuments(company)

  return (
    /*
     * lg 以上: サイドバー（240px固定）+ コンテンツエリア（flex-1）の横並び
     * lg 未満: コンテンツのみ full-width、下部に BottomNav を fixed 配置
     */
    <div id="dashboard-layout" className="flex h-dvh" style={{ overflow: 'hidden' }}>

      {/* ── デスクトップ サイドバー（lg 以上のみ表示） ── */}
      <div className="hidden lg:flex no-print">
        <Sidebar legacyRugsDocuments={legacyRugsDocuments} />
      </div>

      {/* ── メインコンテンツ ── */}
      <main
        id="dashboard-main"
        className="flex-1 overflow-y-auto"
        style={{
          background: '#F3F7F4',
          paddingBottom: 'calc(56px + env(safe-area-inset-bottom))',
        }}
      >
        {/* lg 以上はボトムタブのパディング不要 */}
        <style>{`
          @media (min-width: 1024px) {
            main { padding-bottom: 0 !important; }
          }
        `}</style>
        {children}
      </main>

      {/* ── モバイル 下タブ（lg 未満のみ表示） ── */}
      <div className="lg:hidden no-print">
        <BottomNav />
      </div>

    </div>
  )
}
