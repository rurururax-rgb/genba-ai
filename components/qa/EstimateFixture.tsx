'use client'

import { EstimateTab } from '@/components/projects/EstimateTab'
import { FIXTURE_PROJECT_ID, installEstimateFixtureBackend, resetFixture } from '@/lib/qa/estimate-fixture-backend'

// EstimateTab が最初の通信を行う前に fetch を差し替える（モジュール評価時）
installEstimateFixtureBackend()

export function EstimateFixture() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#FEF3C7', color: '#92400E', fontSize: 12 }}>
        <strong>QA FIXTURE</strong>
        <span>本番DBには接続しません（書き込みは sessionStorage 上の Fixture に対して行われます）</span>
        <button
          type="button"
          onClick={() => { resetFixture(); window.location.reload() }}
          style={{ marginLeft: 'auto', border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          初期データに戻す
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <EstimateTab projectId={FIXTURE_PROJECT_ID} />
      </div>
    </div>
  )
}
