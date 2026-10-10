'use client'

import { useSyncExternalStore } from 'react'
import { InvoiceTab } from '@/components/projects/InvoiceTab'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'
import {
  INVOICE_FIXTURE_PROJECT_ID, installInvoiceFixtureBackend, isInvoiceFixtureBackendActive, resetInvoiceFixture,
} from '@/lib/qa/invoice-fixture-backend'

function subscribeFixtureBackend(onChange: () => void) {
  const uninstall = installInvoiceFixtureBackend()
  if (!uninstall) return () => {}
  onChange()
  return uninstall
}

/** 架空の発行者情報（実在の会社・口座ではない） */
const QA_ISSUER: InvoiceIssuerProfile = {
  companyName: 'QA工務店',
  bank: { branch: 'QA銀行 / テスト支店', accountType: '普通', accountNumber: '0000000', holder: 'QA工務店', holderKana: 'キューエーコウムテン' },
  registrationNumber: 'T0000000000000',
  postalCode: '000-0000',
  address: 'QA県テスト市1-1',
  tel: '000-0000-0000',
  email: 'qa@example.com',
  license: 'QA-000000',
  logoPath: '/favicon.ico',
}

export function InvoiceFixture() {
  // fetch はこのページのマウント中だけ差し替え、離れたら元に戻す（subscribe で差し替え、unsubscribe で戻す）。
  // 子の effect は親より先に走るため、差し替えが済むまで InvoiceTab を描画しない
  // （InvoiceTab の最初の通信が実サーバーへ出ないようにする）
  const ready = useSyncExternalStore(subscribeFixtureBackend, isInvoiceFixtureBackendActive, () => false)

  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#FEF3C7', color: '#92400E', fontSize: 12 }}>
        <strong>QA FIXTURE</strong>
        <span>本番DBには接続しません（請求書の書き込みは sessionStorage 上の Fixture に対して行われます）</span>
        <button
          type="button"
          onClick={() => { resetInvoiceFixture(); window.location.reload() }}
          style={{ marginLeft: 'auto', border: '1px solid #92400E', borderRadius: 6, padding: '2px 10px', background: '#fff', cursor: 'pointer' }}
        >
          初期データに戻す
        </button>
      </div>
      {ready && (
        <InvoiceTab
          projectId={INVOICE_FIXTURE_PROJECT_ID}
          projectInfo={{
            id: INVOICE_FIXTURE_PROJECT_ID, name: 'QA-請求書 金額入力', customer_name: 'QA顧客',
            payment_contract_pct: 30, payment_start_pct: 40, payment_completion_pct: 30,
          }}
          issuer={QA_ISSUER}
        />
      )}
    </div>
  )
}
