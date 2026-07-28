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
    <div className="flex h-dvh overflow-hidden">

      {/* ── デスクトップ サイドバー（lg 以上のみ表示） ── */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* ── メインコンテンツ ── */}
      <main
        className="flex-1 overflow-y-auto"
        style={{
          background: '#F5F7FA',
          /* モバイルは下タブ分のパディングを確保 */
          paddingBottom: 'calc(49px + env(safe-area-inset-bottom))',
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
      <div className="lg:hidden">
        <BottomNav />
      </div>

    </div>
  )
}
