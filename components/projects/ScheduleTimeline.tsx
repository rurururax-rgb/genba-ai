'use client'

import { useState, useMemo, useCallback, Fragment } from 'react'
import type { ScheduleItem } from '@/lib/services/schedule'

// ── 定数 ──────────────────────────────────────────────────

const NUM_DAYS   = 14
const SLOT_WIDTH = 30   // px（AM / PM 各列の幅）
const LEFT_WIDTH = 188  // px（左固定列）

// ── 日付ユーティリティ ─────────────────────────────────────

function todayJST(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000)
  return jst.toISOString().slice(0, 10)
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dayDiff(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00Z').getTime()
  const db = new Date(b + 'T12:00:00Z').getTime()
  return Math.round((da - db) / 86400000)
}

function buildDates(viewStart: string): string[] {
  return Array.from({ length: NUM_DAYS }, (_, i) => addDays(viewStart, i))
}

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土']

function formatDateHeader(dateStr: string): { md: string; dow: string; isWeekend: boolean } {
  const d = new Date(dateStr + 'T12:00:00Z')
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  const dow = DOW_JA[d.getUTCDay()]
  return { md: `${m}/${day}`, dow, isWeekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 }
}

// ── バーのスロット計算 ─────────────────────────────────────

type SlotRange = {
  clippedStart:  number
  clippedEnd:    number
  hasLeftClip:   boolean
  hasRightClip:  boolean
}

function getItemSlotRange(item: ScheduleItem, viewStart: string): SlotRange | null {
  if (!item.start_date || !item.end_date) return null
  if (item.start_date > item.end_date) return null

  const totalSlots = NUM_DAYS * 2
  const startDiff  = dayDiff(item.start_date, viewStart)
  const endDiff    = dayDiff(item.end_date, viewStart)
  const absStart   = startDiff * 2 + (item.start_period === 'pm' ? 1 : 0)
  const absEnd     = endDiff   * 2 + (item.end_period   === 'am' ? 0 : 1)

  if (absStart >= totalSlots || absEnd < 0) return null

  const clippedStart = Math.max(0, absStart)
  const clippedEnd   = Math.min(totalSlots - 1, absEnd)
  if (clippedStart > clippedEnd) return null

  return {
    clippedStart,
    clippedEnd,
    hasLeftClip:  absStart < 0,
    hasRightClip: absEnd >= totalSlots,
  }
}

// ── ステータス色 ───────────────────────────────────────────

const BAR_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  planned:    { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
  confirmed:  { bg: '#D1FAE5', border: '#6EE7B7', text: '#065F46' },
  in_progress:{ bg: '#DBEAFE', border: '#93C5FD', text: '#1D4ED8' },
  done:       { bg: '#DCFCE7', border: '#86EFAC', text: '#166534' },
  delayed:    { bg: '#FEE2E2', border: '#FCA5A5', text: '#991B1B' },
}
const STATUS_LABELS: Record<string, string> = {
  planned: '予定', confirmed: '確定', in_progress: '施工中', done: '完了', delayed: '遅延',
}

// ── コンポーネント ─────────────────────────────────────────

type Props = {
  items:        ScheduleItem[]
  conflictedIds: Set<string>
  onItemClick:  (item: ScheduleItem) => void
}

export function ScheduleTimeline({ items, conflictedIds, onItemClick }: Props) {
  const today = todayJST()

  const [viewStart, setViewStart] = useState<string>(() => {
    const minDate = items
      .filter(i => i.start_date)
      .map(i => i.start_date!)
      .sort()[0]
    const base = minDate && minDate < addDays(today, 7) ? minDate : today
    return addDays(base, -2)
  })

  const dates = useMemo(() => buildDates(viewStart), [viewStart])

  const itemRanges = useMemo(
    () => items.map(item => getItemSlotRange(item, viewStart)),
    [items, viewStart]
  )

  const prevWeek = useCallback(() => setViewStart(s => addDays(s, -7)), [])
  const nextWeek = useCallback(() => setViewStart(s => addDays(s,  7)), [])
  const goToday  = useCallback(() => setViewStart(addDays(today, -2)), [today])

  const viewEnd = dates[dates.length - 1]

  if (items.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '48px 24px',
        color: '#94A3B8', fontSize: 14,
        border: '2px dashed #E2E8F0', borderRadius: 12, margin: '0 20px 20px',
      }}>
        <p style={{ margin: 0 }}>工程がまだありません</p>
        <p style={{ margin: '8px 0 0', fontSize: 13 }}>「工程を追加」ボタンで工程を登録できます</p>
      </div>
    )
  }

  return (
    <div style={{ padding: '0 20px 20px' }}>
      {/* ナビゲーション */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: '1px solid #E2E8F0', borderRadius: 6, overflow: 'hidden' }}>
          <button onClick={prevWeek} style={navBtnStyle}>← 前週</button>
          <button onClick={goToday}  style={{ ...navBtnStyle, borderLeft: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }}>今週</button>
          <button onClick={nextWeek} style={navBtnStyle}>次週 →</button>
        </div>
        <span style={{ fontSize: 12, color: '#64748B' }}>
          {viewStart.slice(5).replace('-', '/')} 〜 {viewEnd.slice(5).replace('-', '/')}
        </span>
      </div>

      {/* 工程表テーブル */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #E8ECF6' }}>
        <table style={{
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
          width: LEFT_WIDTH + NUM_DAYS * 2 * SLOT_WIDTH + 'px',
          background: '#FFF',
          fontSize: 12,
        }}>
          <colgroup>
            <col style={{ width: LEFT_WIDTH + 'px' }} />
            {dates.flatMap(d => [
              <col key={d + '-am'} style={{ width: SLOT_WIDTH + 'px' }} />,
              <col key={d + '-pm'} style={{ width: SLOT_WIDTH + 'px' }} />,
            ])}
          </colgroup>

          <thead>
            {/* 日付行 */}
            <tr style={{ background: '#F8FAFC' }}>
              <th style={stickyTh}>
                <span style={{ fontSize: 11, color: '#94A3B8' }}>工程 / 業者</span>
              </th>
              {dates.map(d => {
                const { md, dow, isWeekend } = formatDateHeader(d)
                const isToday = d === today
                return (
                  <th
                    key={d}
                    colSpan={2}
                    style={{
                      ...dateHeaderStyle,
                      background: isToday ? '#FFF7ED' : isWeekend ? '#F9FAFB' : '#F8FAFC',
                      color: isToday ? '#C2410C' : isWeekend ? '#94A3B8' : '#374151',
                      fontWeight: isToday ? 700 : 500,
                    }}
                  >
                    {isToday && (
                      <div style={{ fontSize: 9, color: '#F59E0B', marginBottom: 1, lineHeight: 1 }}>今日</div>
                    )}
                    <div>{md}</div>
                    <div style={{ fontSize: 10, opacity: 0.75 }}>({dow})</div>
                  </th>
                )
              })}
            </tr>

            {/* AM/PM行 */}
            <tr style={{ background: '#F8FAFC' }}>
              <th style={stickySubTh}></th>
              {dates.flatMap(d => {
                const { isWeekend } = formatDateHeader(d)
                const isToday = d === today
                const base = isToday ? '#FFFBEB' : isWeekend ? '#F9FAFB' : '#FFF'
                return [
                  <th key={d + '-am'} style={{ ...ampmStyle, background: base, borderLeft: '1px solid #E8ECF6' }}>AM</th>,
                  <th key={d + '-pm'} style={{ ...ampmStyle, background: base }}>PM</th>,
                ]
              })}
            </tr>
          </thead>

          <tbody>
            {items.map((item, itemIdx) => {
              const range = itemRanges[itemIdx]
              const bar = BAR_COLORS[item.status] ?? BAR_COLORS.planned
              const isConflicted = conflictedIds.has(item.id)

              return (
                <tr key={item.id} style={{ borderBottom: '1px solid #F0F2F8' }}>
                  {/* 左固定列 */}
                  <td
                    style={stickyTd}
                    onClick={() => onItemClick(item)}
                    title={`${item.name}${item.vendor_name ? ' / ' + item.vendor_name : ''}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
                      {isConflicted && (
                        <span style={{ color: '#F59E0B', fontSize: 13, flexShrink: 0 }}>⚠</span>
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#1e3a5f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </div>
                        {item.vendor_name && (
                          <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.vendor_name}
                          </div>
                        )}
                        <div style={{
                          display: 'inline-block', marginTop: 2,
                          fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                          background: bar.bg, color: bar.text,
                        }}>
                          {STATUS_LABELS[item.status] ?? item.status}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* 日付スロット */}
                  {dates.flatMap((d, dayIdx) => {
                    const { isWeekend } = formatDateHeader(d)
                    const isToday = d === today
                    return (['am', 'pm'] as const).map(period => {
                      const slotIdx   = dayIdx * 2 + (period === 'am' ? 0 : 1)
                      const active    = range !== null && slotIdx >= range.clippedStart && slotIdx <= range.clippedEnd
                      const isBarStart = range !== null && slotIdx === range.clippedStart
                      const isBarEnd   = range !== null && slotIdx === range.clippedEnd
                      const isAmCol   = period === 'am'

                      const leftRound  = isBarStart && range !== null && !range.hasLeftClip
                      const rightRound = isBarEnd   && range !== null && !range.hasRightClip
                      const borderRadius = leftRound && rightRound ? '4px'
                        : leftRound  ? '4px 0 0 4px'
                        : rightRound ? '0 4px 4px 0'
                        : '0'

                      // バーのテキスト幅（全スロット数 × slot幅）
                      const barTextWidth = range
                        ? (range.clippedEnd - range.clippedStart + 1) * SLOT_WIDTH - 6
                        : 0

                      return (
                        <td
                          key={d + '-' + period}
                          style={{
                            padding: 0,
                            height: 44,
                            borderLeft: isAmCol ? '1px solid #E8ECF6' : undefined,
                            background: isToday ? '#FFFBEB' : isWeekend ? '#F9FAFB' : undefined,
                            position: 'relative',
                          }}
                        >
                          {active && (
                            <div
                              onClick={() => onItemClick(item)}
                              title={`${item.name}${item.vendor_name ? ' / ' + item.vendor_name : ''}${item.start_date ? ` (${item.start_date} ${item.start_period?.toUpperCase() ?? 'AM'} 〜 ${item.end_date} ${item.end_period?.toUpperCase() ?? 'PM'})` : ''}`}
                              style={{
                                position: 'absolute',
                                top: 4,
                                bottom: 4,
                                left: isBarStart ? 2 : 0,
                                right: isBarEnd ? 2 : 0,
                                background: bar.bg,
                                borderTop:    `1px solid ${bar.border}`,
                                borderBottom: `1px solid ${bar.border}`,
                                borderLeft:  isBarStart ? `1px solid ${bar.border}` : undefined,
                                borderRight: isBarEnd   ? `1px solid ${bar.border}` : undefined,
                                borderRadius,
                                cursor: 'pointer',
                                overflow: 'visible',
                              }}
                            >
                              {/* バー先頭にテキスト（絶対配置で全スロットにわたって表示） */}
                              {isBarStart && (
                                <span style={{
                                  position: 'absolute',
                                  left: 4,
                                  top: 0,
                                  bottom: 0,
                                  display: 'flex',
                                  alignItems: 'center',
                                  fontSize: 10,
                                  fontWeight: 600,
                                  color: bar.text,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  width: barTextWidth + 'px',
                                  pointerEvents: 'none',
                                  zIndex: 1,
                                }}>
                                  {item.name}
                                  {item.vendor_name && (
                                    <span style={{ opacity: 0.65, marginLeft: 4, fontWeight: 400 }}>
                                      {item.vendor_name}
                                    </span>
                                  )}
                                  {isConflicted && (
                                    <span style={{ marginLeft: 4 }}>⚠</span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      )
                    })
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── スタイル定数 ────────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'none',
  border: 'none',
  fontSize: 12,
  fontWeight: 500,
  color: '#374151',
  cursor: 'pointer',
}

const stickyTh: React.CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 3,
  width: LEFT_WIDTH,
  background: '#F8FAFC',
  borderRight: '2px solid #E8ECF6',
  borderBottom: '1px solid #E8ECF6',
  padding: '8px 10px',
  textAlign: 'left',
  fontWeight: 500,
}

const stickySubTh: React.CSSProperties = {
  ...stickyTh,
  borderBottom: '1px solid #E8ECF6',
}

const stickyTd: React.CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 2,
  width: LEFT_WIDTH,
  background: '#FFF',
  borderRight: '2px solid #E8ECF6',
  padding: '8px 10px',
  cursor: 'pointer',
  verticalAlign: 'middle',
}

const dateHeaderStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '5px 2px',
  fontSize: 11,
  fontWeight: 500,
  borderLeft: '1px solid #E8ECF6',
  borderBottom: '1px solid #E8ECF6',
  verticalAlign: 'bottom',
  lineHeight: 1.3,
}

const ampmStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: 9,
  fontWeight: 500,
  color: '#94A3B8',
  padding: '3px 0',
  borderBottom: '1px solid #E8ECF6',
  letterSpacing: '0.02em',
}
