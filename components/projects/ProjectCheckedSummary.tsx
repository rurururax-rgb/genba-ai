'use client'

import { useEffect, useState } from 'react'
import { formatScheduleDate, type ScheduleFact } from '@/lib/project/checked-summary'

/**
 * 案件画面ヘッダー直下の「RAGZが確認しました」。
 * 確定した事実（見積・請求・工程）を表示するだけ。操作・判断・AI 推測は持たない。
 * 値が取れなかった項目は「—」で、0円や未作成に読み替えない。
 */

type Props = {
  /** サーバーで共有計算（calculateEstimateTotals）した税込合計。取得失敗時は null */
  estimateTotal: number | null
  /** 見積明細の行数。0 なら「見積なし」。取得失敗時は null */
  estimateItemCount: number | null
  /** 請求の表示文言（formatBillingFact の結果）。取得失敗時は null */
  billing:       string | null
  /** 施工期間中の工程、なければ次の工程 */
  schedule:      ScheduleFact | null
}

export function ProjectCheckedSummary({ estimateTotal, estimateItemCount, billing, schedule }: Props) {
  // 見積エディタが読み込み完了後に通知する合計（genba:total）と行数（genba:estimate-count）。
  // 編集後もエディタと同じ値に追従する
  const [liveTotal, setLiveTotal] = useState<number | null>(null)
  const [liveCount, setLiveCount] = useState<number | null>(null)

  useEffect(() => {
    const onTotal = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail === 'number' && Number.isFinite(detail)) setLiveTotal(detail)
    }
    const onCount = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail === 'number' && Number.isInteger(detail) && detail >= 0) setLiveCount(detail)
    }
    window.addEventListener('genba:total', onTotal)
    window.addEventListener('genba:estimate-count', onCount)
    return () => {
      window.removeEventListener('genba:total', onTotal)
      window.removeEventListener('genba:estimate-count', onCount)
    }
  }, [])

  const total = liveTotal ?? estimateTotal
  const count = liveCount ?? estimateItemCount

  const estimateValue =
    count === 0 ? '見積なし'
    : total != null ? `${total.toLocaleString('ja-JP')}円（税込）`
    : '—'

  return (
    <section aria-label="RAGZが確認しました" style={s.wrap}>
      <span style={s.title}>RAGZが確認しました</span>
      <Fact label="見積" value={estimateValue} />
      <Fact label="請求" value={billing ?? '—'} />
      {schedule?.kind === 'current' ? (
        <Fact
          label="施工中"
          value={`${formatScheduleDate(schedule.start_date)}〜${formatScheduleDate(schedule.end_date)} ${schedule.name}${schedule.others > 0 ? ` ほか${schedule.others}件` : ''}`}
        />
      ) : (
        <Fact
          label="次の工程"
          value={schedule ? `${formatScheduleDate(schedule.start_date)} ${schedule.name}` : '—'}
        />
      )}
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
