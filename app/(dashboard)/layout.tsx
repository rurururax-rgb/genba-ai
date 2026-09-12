import { Sidebar }   from '@/components/shell/Sidebar'
import { BottomNav } from '@/components/shell/BottomNav'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    /*
     * lg 以上: サイドバー（240px固定）+ コンテンツエリア（flex-1）の横並び
     * lg 未満: コンテンツのみ full-width、下部に BottomNav を fixed 配置
     */
    <div id="dashboard-layout" className="flex h-dvh" style={{ overflow: 'hidden' }}>

      {/* ── デスクトップ サイドバー（lg 以上のみ表示） ── */}
      <div className="hidden lg:flex no-print">
        <Sidebar />
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
