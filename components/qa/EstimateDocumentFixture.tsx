'use client'

import { useEffect, useState } from 'react'
import { EstimateDocument } from '@/components/estimate/EstimateDocument'
import { toCustomerEstimateItems, type CustomerEstimateItem } from '@/lib/estimate/customer-output'
import { FIXTURE_PROJECT_ID, readFixture } from '@/lib/qa/estimate-fixture-backend'

// 本番の見積書ページと同じ描画（EstimateDocument）と同じ許可リスト変換（toCustomerEstimateItems）を通す
export function EstimateDocumentFixture() {
  const [data, setData] = useState<{ groups: Array<{ id: string; label: string; sort_order: number }>; items: CustomerEstimateItem[] } | null>(null)

  // sessionStorage はクライアントでのみ読めるため、マウント後に読み込む
  useEffect(() => {
    // requestAnimationFrame は非表示タブで止まるため setTimeout を使う
    const id = setTimeout(() => {
      const s = readFixture()
      setData({
        groups: s.groups.map(g => ({ id: g.id, label: g.label, sort_order: g.sort_order })),
        items:  toCustomerEstimateItems([...s.items].sort((a, b) => a.sort_order - b.sort_order) as unknown as Record<string, unknown>[]),
      })
    }, 0)
    return () => clearTimeout(id)
  }, [])

  if (!data) return null
  return (
    <EstimateDocument
      projectId={FIXTURE_PROJECT_ID}
      project={{
        id: FIXTURE_PROJECT_ID, name: 'QA 備考テスト工事', customer_name: 'QA 様', site_address: 'QA県QA市',
        misc_expense_override: null, rounding_discount: 0, project_memo: null,
      }}
      company={{ name: 'QA工務店', display_name: null, tax_rate: 0.10 }}
      groups={data.groups}
      items={data.items}
    />
  )
}
