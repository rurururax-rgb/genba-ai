'use client'

import { CostLedgerTab } from '@/components/projects/CostLedgerTab'
import { useSyncExternalStore } from 'react'
import {
  COST_FIXTURE_PROJECT_ID, FIXTURE_SCENARIOS, armCostFixtureFault, getFixtureScenario, installCostLedgerFixtureBackend,
  resetCostFixture, setFixtureScenario, subscribeFixtureScenario, type FixtureScenario,
} from '@/lib/qa/cost-ledger-fixture-backend'

// CostLedgerTab が最初の通信を行う前に fetch を差し替える（モジュール評価時）
installCostLedgerFixtureBackend()

export function CostLedgerFixture() {
  const scenario = useSyncExternalStore(subscribeFixtureScenario, getFixtureScenario, (): FixtureScenario => 'standard')
  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#FEF3C7', color: '#92400E', fontSize: 12 }}>
        <strong>QA FIXTURE</strong>
        <span>本番DBには接続しません（原価台帳の書き込みは sessionStorage 上の Fixture に対して行われます）</span>
        {/* 次の AI 読み取りで返す架空の請求書 */}
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          読み取り結果:
          <select
            aria-label="QA: 読み取り結果のシナリオ"
            value={scenario}
            onChange={e => setFixtureScenario(e.target.value as FixtureScenario)}
            style={{ border: '1px solid #92400E', borderRadius: 6, padding: '1px 4px', background: '#fff' }}
          >
            {(Object.keys(FIXTURE_SCENARIOS) as FixtureScenario[]).map(k => <option key={k} value={k}>{FIXTURE_SCENARIOS[k].label}</option>)}
          </select>
        </label>
        {/* 次の請求の書き込み1回だけ障害を起こす（保存後に応答が届かない・RPC が失敗して何も保存されない） */}
        <button
          type="button"
          onClick={() => armCostFixtureFault('lose_next_response')}
          style={{ border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
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
