'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ScheduleItem } from '@/lib/services/schedule'
import type { AIScheduleDraftItem } from '@/lib/ai/schedule/generate-schedule'
import {
  addDays, todayJST,
  shiftItemByWorkingSlots, resizeItemStartByWorking, resizeItemEndByWorking,
  snapMoveToWorking, snapResizeEndToWorking, snapResizeStartToWorking,
  detectConflictIds,
  getTimelineColumns, getTimelineTotalWidth,
  buildColumnLayout, pointerXToSlot,
  DEFAULT_CALENDAR,
  type ItemDates, type TimelineColumn, type ScheduleCalendarOptions,
  type ColumnLayout,
  SLOT_WIDTH, NON_WORKING_WIDTH,
} from '@/lib/services/schedule-slots'

// ── 定数 ─────────────────────────────────────────────────────

const LEFT_WIDTH    = 188
const INIT_NUM_DAYS = 60   // 初期表示日数
const AUTO_PAN_ZONE = 80   // エッジゾーン(px)
const AUTO_PAN_SPEE = 7    // スクロール速度(px/frame)

// ── 型 ──────────────────────────────────────────────────────

type DragType = 'move' | 'resize-start' | 'resize-end'

type DragState = {
  itemId:            string
  isDraft:           boolean
  type:              DragType
  // clientX at drag start — used only for the didMove pixel threshold
  startPointerX:          number
  currentPointerX:        number
  currentPointerY:        number
  originalDates:          ItemDates
  viewStart:              string
  // Working slot ORDINAL under the pointer at drag start.
  // Delta = curWorkingSlotIndex - startWorkingSlotIndex (excludes non-working days).
  // This is the single source of truth for drag/resize distance.
  startWorkingSlotIndex:  number | null
  currentDeltaSlots:      number
  didMove:                boolean
}

type Props = {
  items:                 ScheduleItem[]
  conflictedIds:         Set<string>
  calendarOptions?:      ScheduleCalendarOptions
  onItemClick:           (item: ScheduleItem) => void
  draftItems?:           AIScheduleDraftItem[]
  onDraftClick?:         (item: AIScheduleDraftItem) => void
  onItemDragComplete?:   (itemId: string, dates: ItemDates) => Promise<void>
  onDraftDragComplete?:  (draftId: string, dates: ItemDates) => void
}

// ── バー色 ─────────────────────────────────────────────────

const BAR_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  planned:     { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
  confirmed:   { bg: '#D1FAE5', border: '#6EE7B7', text: '#065F46' },
  in_progress: { bg: '#DBEAFE', border: '#93C5FD', text: '#1D4ED8' },
  done:        { bg: '#DCFCE7', border: '#86EFAC', text: '#166534' },
  delayed:     { bg: '#FEE2E2', border: '#FCA5A5', text: '#991B1B' },
}
const STATUS_LABELS: Record<string, string> = {
  planned: '予定', confirmed: '確定', in_progress: '施工中', done: '完了', delayed: '遅延',
}
const DRAFT_BAR = { bg: '#F0F9FF', border: '#7DD3FC', text: '#0369A1' }

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土']

// ── 純粋ヘルパー ─────────────────────────────────────────────

function makeDates(item: ScheduleItem): ItemDates {
  return {
    start_date:   item.start_date   ?? '',
    start_period: item.start_period ?? 'am',
    end_date:     item.end_date     ?? '',
    end_period:   item.end_period   ?? 'pm',
  }
}
function makeDraftDates(d: AIScheduleDraftItem): ItemDates {
  return {
    start_date:   d.start_date   ?? '',
    start_period: d.start_period ?? 'am',
    end_date:     d.end_date     ?? '',
    end_period:   d.end_period   ?? 'pm',
  }
}

// delta = working slot ordinal difference (non-working days excluded).
// Uses advanceWorkingSlots internally, so crossing weekends/holidays is correct.
function applyDrag(orig: ItemDates, ds: DragState, options: ScheduleCalendarOptions): ItemDates {
  if (ds.currentDeltaSlots === 0) return orig
  switch (ds.type) {
    case 'move':         return shiftItemByWorkingSlots(orig, ds.currentDeltaSlots, options)
    case 'resize-start': return resizeItemStartByWorking(orig, ds.currentDeltaSlots, options)
    case 'resize-end':   return resizeItemEndByWorking(orig, ds.currentDeltaSlots, options)
  }
}

function snapDates(
  newDates:  ItemDates,
  type:      DragType,
  origDates: ItemDates,
  options:   ScheduleCalendarOptions,
): ItemDates {
  switch (type) {
    case 'move':         return snapMoveToWorking(origDates, newDates, options)
    case 'resize-end':   return snapResizeEndToWorking(newDates, options)
    case 'resize-start': return snapResizeStartToWorking(newDates, options)
  }
}

function getEffectiveDates(orig: ItemDates, itemId: string, ds: DragState | null, options: ScheduleCalendarOptions): ItemDates {
  if (!ds || ds.itemId !== itemId || !ds.didMove) return orig
  return applyDrag(orig, ds, options)
}

// カラムがバーのアクティブ範囲内か
function isColActive(col: TimelineColumn, d: ItemDates): boolean {
  if (!d.start_date || !d.end_date || d.start_date > d.end_date) return false
  if (col.date < d.start_date || col.date > d.end_date) return false
  if (col.type === 'non-working') return true
  if (col.date === d.start_date && col.period === 'am' && d.start_period === 'pm') return false
  if (col.date === d.end_date   && col.period === 'pm' && d.end_period   === 'am') return false
  return true
}

function isColBarStart(col: TimelineColumn, d: ItemDates): boolean {
  return col.type === 'slot' && col.date === d.start_date && col.period === d.start_period
}

function isColBarEnd(col: TimelineColumn, d: ItemDates): boolean {
  return col.type === 'slot' && col.date === d.end_date && col.period === d.end_period
}

type BarInfo = {
  firstActiveIdx: number   // ビュー内最初のアクティブ列
  lastActiveIdx:  number   // ビュー内最後のアクティブ列
  hasLeftClip:    boolean
  hasRightClip:   boolean
  totalWidthPx:   number
}

function getBarInfo(d: ItemDates, columns: TimelineColumn[]): BarInfo | null {
  if (!d.start_date || !d.end_date || d.start_date > d.end_date) return null
  const first = columns[0]
  const last  = columns[columns.length - 1]
  if (!first || !last) return null
  if (d.end_date < first.date || d.start_date > last.date) return null

  let firstActive = -1
  let lastActive  = -1
  for (let i = 0; i < columns.length; i++) {
    if (isColActive(columns[i], d)) {
      if (firstActive < 0) firstActive = i
      lastActive = i
    }
  }
  if (firstActive < 0) return null

  const hasLeftClip  = d.start_date < first.date || (d.start_date === first.date && d.start_period === 'pm' && first.type === 'slot' && first.period === 'am' && firstActive === 1)
  const hasRightClip = d.end_date > last.date

  let totalWidthPx = 0
  for (let i = firstActive; i <= lastActive; i++) {
    totalWidthPx += columns[i].type === 'slot' ? SLOT_WIDTH : NON_WORKING_WIDTH
  }

  return { firstActiveIdx: firstActive, lastActiveIdx: lastActive, hasLeftClip, hasRightClip, totalWidthPx }
}

// ── メインコンポーネント ─────────────────────────────────────

export function ScheduleTimeline({
  items, conflictedIds, calendarOptions, onItemClick,
  draftItems, onDraftClick,
  onItemDragComplete, onDraftDragComplete,
}: Props) {
  const options = calendarOptions ?? DEFAULT_CALENDAR
  const today   = todayJST()

  const [viewStart, setViewStart] = useState<string>(() => {
    const allDates = [
      ...items.filter(i => i.start_date).map(i => i.start_date!),
      ...(draftItems ?? []).filter(i => i.start_date).map(i => i.start_date!),
    ].sort()
    const minDate = allDates[0]
    const base = minDate && minDate < addDays(today, 7) ? minDate : today
    return addDays(base, -3)
  })

  const [numDays, setNumDays]     = useState(INIT_NUM_DAYS)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const containerRef    = useRef<HTMLDivElement>(null)
  const dragRef         = useRef<DragState | null>(null)
  const didDragRef      = useRef(false)
  const rafRef          = useRef(0)
  const viewStartRef    = useRef(viewStart)
  const optionsRef      = useRef(options)
  const colLayoutRef    = useRef<ColumnLayout[]>([])
  const onItemDragCompleteRef  = useRef(onItemDragComplete)
  const onDraftDragCompleteRef = useRef(onDraftDragComplete)

  useEffect(() => { viewStartRef.current  = viewStart  }, [viewStart])
  useEffect(() => { optionsRef.current    = options    }, [options])
  useEffect(() => { onItemDragCompleteRef.current  = onItemDragComplete  }, [onItemDragComplete])
  useEffect(() => { onDraftDragCompleteRef.current = onDraftDragComplete }, [onDraftDragComplete])

  const columns = useMemo(
    () => getTimelineColumns(viewStart, numDays, options),
    [viewStart, numDays, options],
  )
  const totalWidth = useMemo(() => getTimelineTotalWidth(columns), [columns])

  // colLayoutRef はレンダーごとに同期更新（1フレーム遅延なし）
  // useEffect に移すとドラッグ中の座標計算に1フレームのズレが生じるため意図的な設計。
  // eslint-disable-next-line react-hooks/refs
  colLayoutRef.current = useMemo(() => buildColumnLayout(columns), [columns])

  // ResizeObserver でコンテナ幅に応じて numDays を拡大
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const avail = entry.contentRect.width - LEFT_WIDTH
      const needed = Math.ceil(avail / SLOT_WIDTH / 2) * 2 + 30
      setNumDays(n => Math.max(n, needed))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── 自動スクロール（drag中） ────────────────────────────────
  const stopAutoPan = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
  }, [])

  const startAutoPan = useCallback(() => {
    const pan = () => {
      const ds = dragRef.current
      const el = containerRef.current
      if (!ds || !el) return
      const rect     = el.getBoundingClientRect()
      const relLeft  = ds.currentPointerX - rect.left - LEFT_WIDTH
      const relRight = rect.right - ds.currentPointerX
      if (relLeft > 0 && relLeft < AUTO_PAN_ZONE) {
        el.scrollLeft -= AUTO_PAN_SPEE * (1 - relLeft / AUTO_PAN_ZONE)
      } else if (relRight < AUTO_PAN_ZONE) {
        el.scrollLeft += AUTO_PAN_SPEE * (1 - relRight / AUTO_PAN_ZONE)
        // 右端に近づいたら日数を増やす
        if (el.scrollLeft + el.clientWidth > el.scrollWidth - 300) {
          setNumDays(n => n + 30)
        }
      }
      rafRef.current = requestAnimationFrame(pan)
    }
    rafRef.current = requestAnimationFrame(pan)
  }, [])

  // ── Window ポインターハンドラ ─────────────────────────────────
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const ds = dragRef.current
      if (!ds) return

      // ── 正しい deltaSlots の計算 ──────────────────────────────
      // 旧: Math.round((clientX - startClientX) / SLOT_WIDTH)
      //   → scrollLeft 未考慮・12px 休業日列を跨ぐとズレる
      // 新: タイムライン絶対座標でスロットを特定し calender slot delta を求める
      //   → scroll 前後・休業日列横断・auto-pan すべてで正確
      const el = containerRef.current
      let deltaSlots = 0
      if (el && ds.startWorkingSlotIndex !== null) {
        const rect      = el.getBoundingClientRect()
        const timelineX = (e.clientX - rect.left - LEFT_WIDTH) + el.scrollLeft
        const curSlot   = pointerXToSlot(timelineX, colLayoutRef.current)
        if (curSlot) {
          deltaSlots = curSlot.workingSlotIndex - ds.startWorkingSlotIndex
        }
      }

      const didMove = Math.abs(e.clientX - ds.startPointerX) >= 4
      const changed = deltaSlots !== ds.currentDeltaSlots || didMove !== ds.didMove
      ds.currentDeltaSlots = deltaSlots
      ds.didMove           = didMove
      ds.currentPointerX   = e.clientX
      ds.currentPointerY   = e.clientY
      if (changed) setDragState({ ...ds })
    }

    const onPointerUp = () => {
      const ds = dragRef.current
      if (!ds) return
      stopAutoPan()
      dragRef.current = null
      setDragState(null)
      document.body.style.userSelect = ''

      if (!ds.didMove || ds.currentDeltaSlots === 0) return

      didDragRef.current = true
      setTimeout(() => { didDragRef.current = false }, 100)

      const rawDates     = applyDrag(ds.originalDates, ds, optionsRef.current)
      const snappedDates = snapDates(rawDates, ds.type, ds.originalDates, optionsRef.current)

      if (ds.isDraft) {
        onDraftDragCompleteRef.current?.(ds.itemId, snappedDates)
      } else {
        void onItemDragCompleteRef.current?.(ds.itemId, snappedDates)
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup',   onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup',   onPointerUp)
    }
  }, [stopAutoPan])

  const startDrag = useCallback((
    e: React.PointerEvent,
    itemId: string,
    isDraft: boolean,
    originalDates: ItemDates,
    type: DragType,
  ) => {
    e.preventDefault()
    document.body.style.userSelect = 'none'

    // drag 開始時のworking slot ordinalを記録（タイムライン絶対座標系）
    const el = containerRef.current
    let startWorkingSlotIndex: number | null = null
    if (el) {
      const rect = el.getBoundingClientRect()
      const timelineX = (e.clientX - rect.left - LEFT_WIDTH) + el.scrollLeft
      startWorkingSlotIndex = pointerXToSlot(timelineX, colLayoutRef.current)?.workingSlotIndex ?? null
    }

    const ds: DragState = {
      itemId, isDraft, type,
      startPointerX:        e.clientX,
      currentPointerX:      e.clientX,
      currentPointerY:      e.clientY,
      originalDates,
      viewStart:            viewStartRef.current,
      startWorkingSlotIndex,
      currentDeltaSlots:    0,
      didMove:              false,
    }
    dragRef.current = ds
    setDragState({ ...ds })
    startAutoPan()
  }, [startAutoPan])

  // ── ライブ重複チェック ────────────────────────────────────────
  const liveConflictIds: Set<string> = (() => {
    if (!dragState) return conflictedIds
    const ci = items.map(item => {
      const eff = getEffectiveDates(makeDates(item), item.id, dragState, options)
      return { id: item.id, vendor_name: item.vendor_name ?? null, start_date: eff.start_date, end_date: eff.end_date }
    })
    const cd = (draftItems ?? []).map(d => {
      const eff = getEffectiveDates(makeDraftDates(d), d._draft_id, dragState, options)
      return { id: d._draft_id, vendor_name: d.vendor_name ?? null, start_date: eff.start_date, end_date: eff.end_date }
    })
    return detectConflictIds([...ci, ...cd])
  })()

  const hasDraft = (draftItems ?? []).length > 0

  // ── 今日へスクロール ──────────────────────────────────────────
  const scrollToToday = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setViewStart(addDays(today, -3))
    el.scrollLeft = 0
  }, [today])

  if (items.length === 0 && !hasDraft) {
    return (
      <div style={{
        textAlign: 'center', padding: '48px 24px', color: '#94A3B8', fontSize: 14,
        border: '2px dashed #E2E8F0', borderRadius: 12, margin: '0 20px 20px',
      }}>
        <p style={{ margin: 0 }}>工程がまだありません</p>
        <p style={{ margin: '8px 0 0', fontSize: 13 }}>「工程を追加」または「✨ AIで工程案を作る」で工程を登録できます</p>
      </div>
    )
  }

  // ── ヘッダー日付グループ ─────────────────────────────────────
  const dateGroups: Array<{ date: string; colSpan: number; isNonWorking: boolean }> = []
  for (const col of columns) {
    const last = dateGroups[dateGroups.length - 1]
    if (last && last.date === col.date) {
      last.colSpan++
    } else {
      dateGroups.push({ date: col.date, colSpan: 1, isNonWorking: col.type === 'non-working' })
    }
  }

  const viewEnd = columns[columns.length - 1]?.date ?? viewStart

  return (
    <div style={{ padding: '0 20px 20px' }}>
      {/* ナビゲーション */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: '1px solid #E2E8F0', borderRadius: 6, overflow: 'hidden' }}>
          <button onClick={() => setViewStart(s => addDays(s, -7))} style={navBtnStyle}>← 前週</button>
          <button onClick={scrollToToday} style={{ ...navBtnStyle, borderLeft: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }}>今日</button>
          <button onClick={() => setViewStart(s => addDays(s,  7))} style={navBtnStyle}>次週 →</button>
        </div>
        <span style={{ fontSize: 12, color: '#64748B' }}>
          {viewStart.slice(5).replace('-', '/')} 〜 {viewEnd.slice(5).replace('-', '/')}
        </span>
        <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 4 }}>
          バーをドラッグして移動・両端で長さ変更
        </span>
      </div>

      {/* 工程表テーブル */}
      <div ref={containerRef} style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #E8ECF6' }}>
        <table style={{
          borderCollapse: 'collapse', tableLayout: 'fixed',
          width: LEFT_WIDTH + totalWidth,
          background: '#FFF', fontSize: 12,
        }}>
          <colgroup>
            <col style={{ width: LEFT_WIDTH }} />
            {columns.map((col, i) => (
              <col key={i} style={{ width: col.type === 'slot' ? SLOT_WIDTH : NON_WORKING_WIDTH }} />
            ))}
          </colgroup>

          <thead>
            {/* 日付ヘッダー行 */}
            <tr style={{ background: '#F8FAFC' }}>
              <th style={stickyTh}><span style={{ fontSize: 11, color: '#94A3B8' }}>工程 / 業者</span></th>
              {dateGroups.map(({ date, colSpan, isNonWorking }) => {
                const dt      = new Date(date + 'T12:00:00Z')
                const m       = dt.getUTCMonth() + 1
                const day     = dt.getUTCDate()
                const dow     = DOW_JA[dt.getUTCDay()]
                const isToday = date === today
                const isWeekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6

                return (
                  <th key={date} colSpan={colSpan} style={{
                    ...dateHeaderStyle,
                    background: isNonWorking ? '#F3F4F6'
                      : isToday  ? '#FFF7ED'
                      : isWeekend ? '#F9FAFB' : '#F8FAFC',
                    color: isNonWorking ? '#9CA3AF'
                      : isToday ? '#C2410C'
                      : isWeekend ? '#94A3B8' : '#374151',
                    fontWeight: isToday ? 700 : 500,
                    fontSize: isNonWorking ? 9 : 11,
                  }}>
                    {isNonWorking ? (
                      <span>休</span>
                    ) : (
                      <>
                        {isToday && <div style={{ fontSize: 9, color: '#F59E0B', marginBottom: 1, lineHeight: 1 }}>今日</div>}
                        <div>{m}/{day}</div>
                        <div style={{ fontSize: 10, opacity: 0.75 }}>({dow})</div>
                      </>
                    )}
                  </th>
                )
              })}
            </tr>

            {/* AM/PM サブヘッダー行 */}
            <tr style={{ background: '#F8FAFC' }}>
              <th style={stickySubTh}></th>
              {columns.map((col, i) => {
                if (col.type === 'non-working') {
                  return <th key={i} style={{ ...ampmStyle, background: '#F3F4F6', width: NON_WORKING_WIDTH }} />
                }
                const isToday   = col.date === today
                const dt        = new Date(col.date + 'T12:00:00Z')
                const isWeekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6
                const bg = isToday ? '#FFFBEB' : isWeekend ? '#F9FAFB' : '#FFF'
                return (
                  <th key={i} style={{
                    ...ampmStyle, background: bg, width: SLOT_WIDTH,
                    borderLeft: col.period === 'am' ? '1px solid #E8ECF6' : undefined,
                  }}>
                    {col.period.toUpperCase()}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {items.map(item => {
              const origDates  = makeDates(item)
              const effDates   = getEffectiveDates(origDates, item.id, dragState, options)
              const barInfo    = getBarInfo(effDates, columns)
              const bar        = BAR_COLORS[item.status] ?? BAR_COLORS.planned
              const isConflict = liveConflictIds.has(item.id)
              const isDragging = dragState?.itemId === item.id && !dragState.isDraft && dragState.didMove

              return (
                <tr key={item.id} style={{ borderBottom: '1px solid #F0F2F8' }}>
                  <td style={stickyTd} onClick={() => {
                    if (didDragRef.current) { didDragRef.current = false; return }
                    onItemClick(item)
                  }} title={`${item.name}${item.vendor_name ? ' / ' + item.vendor_name : ''}`}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
                      {isConflict && <span style={{ color: '#F59E0B', fontSize: 13, flexShrink: 0 }}>⚠</span>}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#1e3a5f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                        {item.vendor_name && <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.vendor_name}</div>}
                        <div style={{ display: 'inline-block', marginTop: 2, fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3, background: bar.bg, color: bar.text }}>
                          {STATUS_LABELS[item.status] ?? item.status}
                        </div>
                      </div>
                    </div>
                  </td>
                  <BarCells
                    columns={columns} today={today} effDates={effDates}
                    barInfo={barInfo} isDragging={isDragging} isDraft={false}
                    barColor={bar} isDashed={false}
                    label={item.name} subLabel={item.vendor_name}
                    conflicted={isConflict} itemId={item.id} originalDates={origDates}
                    didDragRef={didDragRef} startDragFn={startDrag}
                    onClickFn={() => onItemClick(item)}
                  />
                </tr>
              )
            })}

            {(draftItems ?? []).map(item => {
              const origDates  = makeDraftDates(item)
              const effDates   = getEffectiveDates(origDates, item._draft_id, dragState, options)
              const barInfo    = getBarInfo(effDates, columns)
              const isConflict = liveConflictIds.has(item._draft_id)
              const isDragging = dragState?.itemId === item._draft_id && dragState.isDraft && dragState.didMove

              return (
                <tr key={item._draft_id} style={{ borderBottom: '1px solid #F0F2F8', opacity: 0.9 }}>
                  <td style={{ ...stickyTd, background: '#F0F9FF' }} onClick={() => {
                    if (didDragRef.current) { didDragRef.current = false; return }
                    onDraftClick?.(item)
                  }} title={`[AI案] ${item.name}`}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#0369A1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                      {item.vendor_name && <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.vendor_name}</div>}
                      <div style={{ display: 'inline-block', marginTop: 2, fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3, background: '#E0F2FE', color: '#0369A1' }}>AI案</div>
                    </div>
                  </td>
                  <BarCells
                    columns={columns} today={today} effDates={effDates}
                    barInfo={barInfo} isDragging={isDragging} isDraft={true}
                    barColor={DRAFT_BAR} isDashed={true}
                    label={item.name} subLabel={item.vendor_name}
                    conflicted={isConflict} itemId={item._draft_id} originalDates={origDates}
                    didDragRef={didDragRef} startDragFn={startDrag}
                    onClickFn={() => onDraftClick?.(item)}
                  />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ドラッグ中ツールチップ */}
      {dragState?.didMove && (() => {
        const eff = applyDrag(dragState.originalDates, dragState, options)
        const typeLabel = dragState.type === 'move' ? '移動'
          : dragState.type === 'resize-start' ? '開始を変更' : '終了を変更'
        return (
          <div style={{
            position: 'fixed',
            left: dragState.currentPointerX + 14,
            top:  dragState.currentPointerY - 30,
            background: 'rgba(15,23,42,0.82)', color: '#FFF',
            fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
            pointerEvents: 'none', zIndex: 9999, whiteSpace: 'nowrap',
          }}>
            {typeLabel}: {eff.start_date.slice(5).replace('-', '/')} {eff.start_period.toUpperCase()} 〜 {eff.end_date.slice(5).replace('-', '/')} {eff.end_period.toUpperCase()}
          </div>
        )
      })()}
    </div>
  )
}

// ── BarCells コンポーネント ────────────────────────────────────

function BarCells({
  columns, today, effDates, barInfo, isDragging, isDraft,
  barColor, isDashed, label, subLabel, conflicted, itemId, originalDates,
  didDragRef, startDragFn, onClickFn,
}: {
  columns:       TimelineColumn[]
  today:         string
  effDates:      ItemDates
  barInfo:       BarInfo | null
  isDragging:    boolean
  isDraft:       boolean
  barColor:      { bg: string; border: string; text: string }
  isDashed:      boolean
  label:         string
  subLabel?:     string | null
  conflicted:    boolean
  itemId:        string
  originalDates: ItemDates
  didDragRef:    React.MutableRefObject<boolean>
  startDragFn:   (e: React.PointerEvent, id: string, isDraft: boolean, orig: ItemDates, type: DragType) => void
  onClickFn:     () => void
}) {
  return (
    <>
      {columns.map((col, colIdx) => {
        const active    = barInfo !== null && isColActive(col, effDates)
        const isStart   = barInfo !== null && colIdx === barInfo.firstActiveIdx
        const isEnd     = barInfo !== null && colIdx === barInfo.lastActiveIdx
        const isActualStart = isColBarStart(col, effDates) && !barInfo?.hasLeftClip
        const isActualEnd   = isColBarEnd(col, effDates)   && !barInfo?.hasRightClip

        const isToday   = col.date === today
        const dow       = new Date(col.date + 'T12:00:00Z').getUTCDay()
        const isWeekend = dow === 0 || dow === 6
        const bgCell    = col.type === 'non-working' ? '#F3F4F6'
          : isToday   ? '#FFFBEB'
          : isWeekend ? '#F9FAFB' : undefined
        const bs        = isDashed ? '1.5px dashed' : '1px solid'
        const colW      = col.type === 'slot' ? SLOT_WIDTH : NON_WORKING_WIDTH

        // 角丸
        const leftRound  = isStart && !barInfo?.hasLeftClip
        const rightRound = isEnd   && !barInfo?.hasRightClip
        const radius = leftRound && rightRound ? '4px'
          : leftRound  ? '4px 0 0 4px'
          : rightRound ? '0 4px 4px 0' : '0'

        return (
          <td
            key={colIdx}
            style={{
              padding: 0, height: 44,
              width: colW,
              background: bgCell,
              borderLeft: (col.type === 'slot' && col.period === 'am') ? '1px solid #E8ECF6' : undefined,
              position: 'relative',
            }}
          >
            {active && (
              <div
                onPointerDown={col.type === 'slot' ? e => {
                  if (didDragRef.current) return
                  startDragFn(e, itemId, isDraft, originalDates, 'move')
                } : undefined}
                onClick={col.type === 'slot' ? () => {
                  if (didDragRef.current) { didDragRef.current = false; return }
                  onClickFn()
                } : undefined}
                style={{
                  position: 'absolute', top: 4, bottom: 4,
                  left:  isStart ? 2 : 0,
                  right: isEnd   ? 2 : 0,
                  background: col.type === 'non-working'
                    ? barColor.bg.replace(')', ', 0.7)').replace('rgb', 'rgba').replace('#', '')
                    : barColor.bg,
                  borderTop:    `${bs} ${barColor.border}`,
                  borderBottom: `${bs} ${barColor.border}`,
                  borderLeft:   isStart ? `${bs} ${barColor.border}` : undefined,
                  borderRight:  isEnd   ? `${bs} ${barColor.border}` : undefined,
                  borderRadius: radius,
                  cursor: isDragging ? 'grabbing' : (col.type === 'slot' ? 'grab' : 'default'),
                  opacity: isDragging ? 0.75 : 1,
                  boxShadow: isDragging ? '0 3px 10px rgba(0,0,0,0.15)' : undefined,
                  overflow: 'visible',
                  touchAction: 'none',
                  userSelect: 'none',
                }}
              >
                {/* 左リサイズハンドル */}
                {isActualStart && col.type === 'slot' && (
                  <div
                    onPointerDown={e => {
                      e.stopPropagation()
                      if (didDragRef.current) return
                      startDragFn(e, itemId, isDraft, originalDates, 'resize-start')
                    }}
                    title="開始をリサイズ"
                    style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0, width: 7,
                      cursor: 'ew-resize', borderRadius: '4px 0 0 4px',
                      background: 'rgba(0,0,0,0.13)', zIndex: 1, touchAction: 'none',
                    }}
                  />
                )}

                {/* バーラベル（最初のアクティブ列に表示） */}
                {isStart && col.type === 'slot' && (
                  <span style={{
                    position: 'absolute', left: 10, top: 0, bottom: 0,
                    display: 'flex', alignItems: 'center',
                    fontSize: 10, fontWeight: 600, color: barColor.text,
                    whiteSpace: 'nowrap', overflow: 'hidden',
                    width: Math.max(barInfo!.totalWidthPx - 10, 0),
                    pointerEvents: 'none', zIndex: 1,
                  }}>
                    {isDraft ? '✨ ' : ''}{label}
                    {subLabel && <span style={{ opacity: 0.65, marginLeft: 4, fontWeight: 400 }}>{subLabel}</span>}
                    {conflicted && <span style={{ marginLeft: 4 }}>⚠</span>}
                  </span>
                )}

                {/* 右リサイズハンドル */}
                {isActualEnd && col.type === 'slot' && (
                  <div
                    onPointerDown={e => {
                      e.stopPropagation()
                      if (didDragRef.current) return
                      startDragFn(e, itemId, isDraft, originalDates, 'resize-end')
                    }}
                    title="終了をリサイズ"
                    style={{
                      position: 'absolute', right: 0, top: 0, bottom: 0, width: 7,
                      cursor: 'ew-resize', borderRadius: '0 4px 4px 0',
                      background: 'rgba(0,0,0,0.13)', zIndex: 1, touchAction: 'none',
                    }}
                  />
                )}
              </div>
            )}
          </td>
        )
      })}
    </>
  )
}

// ── スタイル定数 ─────────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  padding: '6px 12px', background: 'none', border: 'none',
  fontSize: 12, fontWeight: 500, color: '#374151', cursor: 'pointer',
}
const stickyTh: React.CSSProperties = {
  position: 'sticky', left: 0, zIndex: 3,
  width: LEFT_WIDTH, background: '#F8FAFC',
  borderRight: '2px solid #E8ECF6', borderBottom: '1px solid #E8ECF6',
  padding: '8px 10px', textAlign: 'left', fontWeight: 500,
}
const stickySubTh: React.CSSProperties = { ...stickyTh, borderBottom: '1px solid #E8ECF6' }
const stickyTd: React.CSSProperties = {
  position: 'sticky', left: 0, zIndex: 2,
  width: LEFT_WIDTH, background: '#FFF',
  borderRight: '2px solid #E8ECF6',
  padding: '8px 10px', cursor: 'pointer', verticalAlign: 'middle',
}
const dateHeaderStyle: React.CSSProperties = {
  textAlign: 'center', padding: '5px 2px',
  fontSize: 11, fontWeight: 500,
  borderLeft: '1px solid #E8ECF6', borderBottom: '1px solid #E8ECF6',
  verticalAlign: 'bottom', lineHeight: 1.3,
}
const ampmStyle: React.CSSProperties = {
  textAlign: 'center', fontSize: 9, fontWeight: 500,
  color: '#94A3B8', padding: '3px 0',
  borderBottom: '1px solid #E8ECF6', letterSpacing: '0.02em',
}
