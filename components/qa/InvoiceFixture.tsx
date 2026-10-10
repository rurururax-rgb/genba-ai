'use client'

import { InvoiceTab } from '@/components/projects/InvoiceTab'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'
import {
  INVOICE_FIXTURE_PROJECT_ID, installInvoiceFixtureBackend, resetInvoiceFixture,
} from '@/lib/qa/invoice-fixture-backend'

// InvoiceTab が最初の通信を行う前に fetch を差し替える（モジュール評価時）
installInvoiceFixtureBackend()

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
      <InvoiceTab
        projectId={INVOICE_FIXTURE_PROJECT_ID}
        projectInfo={{
          id: INVOICE_FIXTURE_PROJECT_ID, name: 'QA-請求書 金額入力', customer_name: 'QA顧客',
          payment_contract_pct: 30, payment_start_pct: 40, payment_completion_pct: 30,
        }}
        issuer={QA_ISSUER}
      />
    </div>
  )
}
