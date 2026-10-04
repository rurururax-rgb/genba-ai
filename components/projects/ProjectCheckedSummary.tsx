'use client'

import { useEffect, useState } from 'react'
import { formatScheduleDate, type BillingFact, type NextScheduleFact } from '@/lib/project/checked-summary'

/**
 * 案件画面ヘッダー直下の「RAGZが確認しました」。
 * 確定した事実（見積・請求・次の工程）を表示するだけ。操作・判断・AI 推測は持たない。
 * 値が取れなかった項目は「—」で、0円や未作成に読み替えない。
 */

type Props = {
  /** サーバーで共有計算（calculateEstimateTotals）した税込合計。取得失敗時は null */
  estimateTotal: number | null
  billing:       BillingFact | null
  nextSchedule:  NextScheduleFact | null
}

export function ProjectCheckedSummary({ estimateTotal, billing, nextSchedule }: Props) {
  // 見積エディタが読み込み完了後に通知する合計（genba:total）。編集後もエディタと同じ値に追従する
  const [liveTotal, setLiveTotal] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail === 'number' && Number.isFinite(detail)) setLiveTotal(detail)
    }
    window.addEventListener('genba:total', handler)
    return () => window.removeEventListener('genba:total', handler)
  }, [])

  const total = liveTotal ?? estimateTotal

  return (
    <section aria-label="RAGZが確認しました" style={s.wrap}>
      <span style={s.title}>RAGZが確認しました</span>
      <Fact label="見積" value={total != null ? `${total.toLocaleString('ja-JP')}円（税込）` : '—'} />
      <Fact label="請求" value={billing ?? '—'} />
      <Fact
        label="次の工程"
        value={nextSchedule ? `${formatScheduleDate(nextSchedule.start_date)} ${nextSchedule.name}` : '—'}
      />
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span style={s.fact}>
      <span style={s.label}>{label}</span>
      <span style={s.value}>{value}</span>
    </span>
  )
}

const s = {
  wrap: {
    background: '#FFFFFF', borderBottom: '1px solid #E8ECF6',
    display: 'flex', flexWrap: 'wrap', alignItems: 'baseline',
    columnGap: 20, rowGap: 4,
    padding: '6px 16px', minWidth: 0,
  },
  title: {
    fontSize: 11, fontWeight: 700, color: '#3D7A55', letterSpacing: '0.04em', whiteSpace: 'nowrap',
  },
  fact: {
    display: 'inline-flex', alignItems: 'baseline', gap: 6, minWidth: 0, maxWidth: '100%',
  },
  label: {
    fontSize: 11, color: '#94A3B8', whiteSpace: 'nowrap', flexShrink: 0,
  },
  value: {
    fontSize: 13, fontWeight: 600, color: '#0F172A',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
    fontVariantNumeric: 'tabular-nums',
  },
} satisfies Record<string, React.CSSProperties>
