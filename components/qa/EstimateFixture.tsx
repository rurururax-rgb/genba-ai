'use client'

import { EstimateTab } from '@/components/projects/EstimateTab'
import { FIXTURE_PROJECT_ID, installEstimateFixtureBackend, resetFixture } from '@/lib/qa/estimate-fixture-backend'

// EstimateTab が最初の通信を行う前に fetch を差し替える（モジュール評価時）
installEstimateFixtureBackend()

export function EstimateFixture() {
  return (
    // 本番の app/(dashboard)/layout.tsx と同じく、縦スクロールは #dashboard-main が受け持つ
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#FEF3C7', color: '#92400E', fontSize: 12 }}>
        <strong>QA FIXTURE</strong>
        <span>本番DBには接続しません（書き込みは sessionStorage 上の Fixture に対して行われます）</span>
        <a href="/qa/estimate/document" style={{ marginLeft: 'auto', color: '#92400E', textDecoration: 'underline' }}>
          見積書プレビュー（Fixture）
        </a>
        <button
          type="button"
          onClick={() => { resetFixture(); window.location.reload() }}
          style={{ border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          初期データに戻す
        </button>
      </div>
      <main id="dashboard-main" style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#F3F7F4' }}>
        {/* 案件ページと同じく高さ auto の親に置く（EstimateTab の height: 100% が効かず、表は内容の高さまで伸びる） */}
        <div>
          <EstimateTab projectId={FIXTURE_PROJECT_ID} />
        </div>
      </main>
    </div>
  )
}
