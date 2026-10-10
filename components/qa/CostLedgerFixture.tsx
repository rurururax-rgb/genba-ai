'use client'

import { CostLedgerTab } from '@/components/projects/CostLedgerTab'
import {
  COST_FIXTURE_PROJECT_ID, armCostFixtureFault, installCostLedgerFixtureBackend, resetCostFixture,
} from '@/lib/qa/cost-ledger-fixture-backend'

// CostLedgerTab が最初の通信を行う前に fetch を差し替える（モジュール評価時）
installCostLedgerFixtureBackend()

export function CostLedgerFixture() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#FEF3C7', color: '#92400E', fontSize: 12 }}>
        <strong>QA FIXTURE</strong>
        <span>本番DBには接続しません（原価台帳の書き込みは sessionStorage 上の Fixture に対して行われます）</span>
        {/* 次の請求の書き込み1回だけ障害を起こす（保存後に応答が届かない・RPC が失敗して何も保存されない） */}
        <button
          type="button"
          onClick={() => armCostFixtureFault('lose_next_response')}
          style={{ marginLeft: 'auto', border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          次の登録: 応答を失う
        </button>
        <button
          type="button"
          onClick={() => armCostFixtureFault('fail_next_rpc')}
          style={{ border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          次の書き込み: 失敗（503）
        </button>
        <button
          type="button"
          onClick={() => { resetCostFixture(); window.location.reload() }}
          style={{ border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          初期データに戻す
        </button>
      </div>
      <CostLedgerTab projectId={COST_FIXTURE_PROJECT_ID} />
    </div>
  )
}
