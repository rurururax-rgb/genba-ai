/**
 * lib/services/schedule-slots.ts
 *
 * 工程表の日付・スロット計算ユーティリティ（純粋関数）
 *
 * "1 slot = 半日（AM or PM）" のモデルで統一する。
 */

// ── 型 ─────────────────────────────────────────────────────────

export type SchedulePeriod = 'am' | 'pm'

export type SlotInfo = {
  date:   string        // YYYY-MM-DD
  period: SchedulePeriod
}

export type ItemDates = {
  start_date:   string
  start_period: SchedulePeriod
  end_date:     string
  end_period:   SchedulePeriod
}

export type ScheduleCalendarOptions = {
  nonWorkingWeekdays: number[]   // 0=日, 1=月 … 6=土
  nonWorkingDates:    string[]   // 個別休業日 YYYY-MM-DD
  isHoliday?:         (date: string) => boolean
}

export const DEFAULT_CALENDAR: ScheduleCalendarOptions = {
  nonWorkingWeekdays: [0],   // 日曜のみ休業
  nonWorkingDates:    [],
}

// ── 日付算術（JST安全 — T12:00:00Z でずれを防ぐ） ────────────────

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function dayDiff(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00Z').getTime()
  const db = new Date(b + 'T12:00:00Z').getTime()
  return Math.round((da - db) / 86400000)
}

export function todayJST(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000)
  return jst.toISOString().slice(0, 10)
}

export function formatDateShort(date: string): string {
  return date.slice(5).replace('-', '/')
}

export function formatSlotInfo(slot: SlotInfo): string {
  return `${formatDateShort(slot.date)} ${slot.period.toUpperCase()}`
}

// ── 稼働日判定 ──────────────────────────────────────────────────

export function isWorkingDay(date: string, options: ScheduleCalendarOptions): boolean {
  const dow = new Date(date + 'T12:00:00Z').getUTCDay()
  if (options.nonWorkingWeekdays.includes(dow)) return false
  if (options.nonWorkingDates.includes(date)) return false
  if (options.isHoliday?.(date)) return false
  return true
}

export function isWorkingSlot(slot: SlotInfo, options: ScheduleCalendarOptions): boolean {
  return isWorkingDay(slot.date, options)
}

// ── スロットナビゲーション ─────────────────────────────────────────

export function advanceOneSlot(slot: SlotInfo): SlotInfo {
  if (slot.period === 'am') return { date: slot.date,            period: 'pm' }
  return                          { date: addDays(slot.date, 1), period: 'am' }
}

export function decrementOneSlot(slot: SlotInfo): SlotInfo {
  if (slot.period === 'pm') return { date: slot.date,             period: 'am' }
  return                          { date: addDays(slot.date, -1), period: 'pm' }
}

export function nextWorkingSlot(
  start: SlotInfo,
  options: ScheduleCalendarOptions,
): SlotInfo {
  let s      = start
  let safety = 0
  while (!isWorkingSlot(s, options)) {
    s = advanceOneSlot(s)
    if (++safety > 56) break
  }
  return s
}

export function previousWorkingSlot(
  start: SlotInfo,
  options: ScheduleCalendarOptions,
): SlotInfo {
  let s      = start
  let safety = 0
  while (!isWorkingSlot(s, options)) {
    s = decrementOneSlot(s)
    if (++safety > 56) break
  }
  return s
}

// ── 稼働スロット計算 ─────────────────────────────────────────────

/** 2スロット間の稼働スロット数を数える（start〜end 両端含む） */
export function countWorkingSlots(
  startDate:   string,
  startPeriod: SchedulePeriod,
  endDate:     string,
  endPeriod:   SchedulePeriod,
  options:     ScheduleCalendarOptions,
): number {
  let count  = 0
  let cursor: SlotInfo = { date: startDate, period: startPeriod }
  const endAbs = datePeriodToAbsSlot(endDate, endPeriod, startDate)

  for (let safety = 0; safety < 1000; safety++) {
    const curAbs = datePeriodToAbsSlot(cursor.date, cursor.period, startDate)
    if (curAbs > endAbs) break
    if (isWorkingSlot(cursor, options)) count++
    cursor = advanceOneSlot(cursor)
  }
  return Math.max(1, count)
}

/**
 * 稼働スロットを n 個分前進する。n < 0 の場合は後退する。
 * start は稼働スロット上を前提とする。
 */
export function advanceWorkingSlots(
  start:   SlotInfo,
  n:       number,
  options: ScheduleCalendarOptions,
): SlotInfo {
  if (n === 0) return start
  let slot = start
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      slot = nextWorkingSlot(advanceOneSlot(slot), options)
    }
  } else {
    for (let i = 0; i > n; i--) {
      slot = previousWorkingSlot(decrementOneSlot(slot), options)
    }
  }
  return slot
}

// ── 絶対スロットインデックス ────────────────────────────────────

export function datePeriodToAbsSlot(
  date: string,
  period: SchedulePeriod,
  viewStart: string,
): number {
  const diff = dayDiff(date, viewStart)
  return diff * 2 + (period === 'pm' ? 1 : 0)
}

export function absSlotToDatePeriod(absSlot: number, viewStart: string): SlotInfo {
  const dayOffset = Math.floor(absSlot / 2)
  const periodBit = ((absSlot % 2) + 2) % 2
  return {
    date:   addDays(viewStart, dayOffset),
    period: periodBit === 0 ? 'am' : 'pm',
  }
}

// ── 工程のシフト / リサイズ（カレンダースロットベース） ────────────

export function shiftItemBySlots(
  item: ItemDates,
  deltaSlots: number,
  viewStart: string,
): ItemDates {
  const s    = datePeriodToAbsSlot(item.start_date, item.start_period, viewStart) + deltaSlots
  const e    = datePeriodToAbsSlot(item.end_date,   item.end_period,   viewStart) + deltaSlots
  const sSl  = absSlotToDatePeriod(s, viewStart)
  const eSl  = absSlotToDatePeriod(e, viewStart)
  return {
    start_date: sSl.date, start_period: sSl.period,
    end_date:   eSl.date, end_period:   eSl.period,
  }
}

export function resizeItemStart(
  item: ItemDates,
  deltaSlots: number,
  viewStart: string,
): ItemDates {
  const origStart = datePeriodToAbsSlot(item.start_date, item.start_period, viewStart)
  const origEnd   = datePeriodToAbsSlot(item.end_date,   item.end_period,   viewStart)
  const newStart  = Math.min(origStart + deltaSlots, origEnd)
  const sl        = absSlotToDatePeriod(newStart, viewStart)
  return {
    start_date: sl.date, start_period: sl.period,
    end_date: item.end_date, end_period: item.end_period,
  }
}

export function resizeItemEnd(
  item: ItemDates,
  deltaSlots: number,
  viewStart: string,
): ItemDates {
  const origStart = datePeriodToAbsSlot(item.start_date, item.start_period, viewStart)
  const origEnd   = datePeriodToAbsSlot(item.end_date,   item.end_period,   viewStart)
  const newEnd    = Math.max(origEnd + deltaSlots, origStart)
  const sl        = absSlotToDatePeriod(newEnd, viewStart)
  return {
    start_date: item.start_date, start_period: item.start_period,
    end_date: sl.date, end_period: sl.period,
  }
}

// ── 稼働スロットへスナップ ──────────────────────────────────────

/** 移動後: 開始を稼働スロットへスナップし、元の稼働スロット数を維持 */
export function snapMoveToWorking(
  origDates: ItemDates,
  newDates:  ItemDates,
  options:   ScheduleCalendarOptions,
): ItemDates {
  const duration = countWorkingSlots(
    origDates.start_date, origDates.start_period,
    origDates.end_date,   origDates.end_period,
    options,
  )
  const newStart = nextWorkingSlot({ date: newDates.start_date, period: newDates.start_period }, options)
  const newEnd   = duration <= 1 ? newStart : advanceWorkingSlots(newStart, duration - 1, options)
  return {
    start_date: newStart.date, start_period: newStart.period,
    end_date:   newEnd.date,   end_period:   newEnd.period,
  }
}

/** リサイズ終了: 終了スロットを稼働スロットへスナップ（end >= start 保証） */
export function snapResizeEndToWorking(
  newDates: ItemDates,
  options:  ScheduleCalendarOptions,
): ItemDates {
  let newEnd = nextWorkingSlot({ date: newDates.end_date, period: newDates.end_period }, options)
  const startAbs = datePeriodToAbsSlot(newDates.start_date, newDates.start_period, newDates.start_date)
  const endAbs   = datePeriodToAbsSlot(newEnd.date, newEnd.period, newDates.start_date)
  if (endAbs < startAbs) {
    newEnd = nextWorkingSlot({ date: newDates.start_date, period: newDates.start_period }, options)
  }
  return { ...newDates, end_date: newEnd.date, end_period: newEnd.period }
}

/** リサイズ開始: 開始スロットを稼働スロットへスナップ（start <= end 保証） */
export function snapResizeStartToWorking(
  newDates: ItemDates,
  options:  ScheduleCalendarOptions,
): ItemDates {
  let newStart = nextWorkingSlot({ date: newDates.start_date, period: newDates.start_period }, options)
  const startAbs = datePeriodToAbsSlot(newStart.date, newStart.period, newDates.start_date)
  const endAbs   = datePeriodToAbsSlot(newDates.end_date, newDates.end_period, newDates.start_date)
  if (startAbs > endAbs) {
    newStart = previousWorkingSlot({ date: newDates.end_date, period: newDates.end_period }, options)
  }
  return { ...newDates, start_date: newStart.date, start_period: newStart.period }
}

// ── buildScheduleDates ──────────────────────────────────────────

export function buildScheduleDates<T extends { duration_slots: number }>(
  items: T[],
  startDate: string,
  options: ScheduleCalendarOptions = DEFAULT_CALENDAR,
  bufferSlotsBetweenItems = 0,
): (T & ItemDates)[] {
  let cursor = nextWorkingSlot({ date: startDate, period: 'am' }, options)

  return items.map(item => {
    const startSlot = cursor
    let endSlot     = cursor
    let remaining   = Math.max(1, item.duration_slots) - 1

    while (remaining > 0) {
      const next = advanceOneSlot(endSlot)
      endSlot = nextWorkingSlot(next, options)
      remaining--
    }

    let afterEnd = advanceOneSlot(endSlot)
    for (let b = 0; b < bufferSlotsBetweenItems; b++) {
      afterEnd = advanceOneSlot(afterEnd)
    }
    cursor = nextWorkingSlot(afterEnd, options)

    return {
      ...item,
      start_date:   startSlot.date,
      start_period: startSlot.period,
      end_date:     endSlot.date,
      end_period:   endSlot.period,
    }
  })
}

// ── タイムライン列型 ─────────────────────────────────────────────

export type TimelineColumn =
  | { type: 'slot';        date: string; period: 'am' | 'pm' }
  | { type: 'non-working'; date: string }

export const SLOT_WIDTH        = 30   // px: 稼働スロット（AM or PM）
export const NON_WORKING_WIDTH = 12   // px: 休業日カラム

/** viewStart から numDays 日分のタイムライン列を生成する */
export function getTimelineColumns(
  startDate: string,
  numDays:   number,
  options:   ScheduleCalendarOptions,
): TimelineColumn[] {
  const cols: TimelineColumn[] = []
  for (let i = 0; i < numDays; i++) {
    const date = addDays(startDate, i)
    if (isWorkingDay(date, options)) {
      cols.push({ type: 'slot', date, period: 'am' })
      cols.push({ type: 'slot', date, period: 'pm' })
    } else {
      cols.push({ type: 'non-working', date })
    }
  }
  return cols
}

/** 列配列の総幅（px） */
export function getTimelineTotalWidth(columns: TimelineColumn[]): number {
  return columns.reduce(
    (sum, c) => sum + (c.type === 'slot' ? SLOT_WIDTH : NON_WORKING_WIDTH),
    0,
  )
}

// ── ピクセル ↔ スロット座標変換 ──────────────────────────────────

/**
 * タイムライン列ごとの画面内ピクセル位置と稼働スロット順序を付加した型。
 * xStart = 左端(px), xEnd = 右端(px, exclusive)
 * workingSlotIndex = 稼働スロット列の通し番号（0,1,2,...）。休業日列は null。
 *
 * drag / resize の delta は必ずこの workingSlotIndex の差分で計算する。
 * カレンダー絶対スロット（datePeriodToAbsSlot）を使うと非稼働日分の余分な
 * delta が混入するため、drag 計算には使用しない。
 */
export type ColumnLayout = TimelineColumn & {
  xStart:           number
  xEnd:             number
  workingSlotIndex: number | null  // 稼働列のみ。休業日列は null
}

/**
 * TimelineColumn[] に累積ピクセル位置と workingSlotIndex を付加して返す。
 * 純粋関数・テスト可能。
 */
export function buildColumnLayout(columns: TimelineColumn[]): ColumnLayout[] {
  const result: ColumnLayout[] = []
  let x   = 0
  let wsi = 0
  for (const col of columns) {
    const w = col.type === 'slot' ? SLOT_WIDTH : NON_WORKING_WIDTH
    result.push({
      ...col,
      xStart:           x,
      xEnd:             x + w,
      workingSlotIndex: col.type === 'slot' ? wsi++ : null,
    })
    x += w
  }
  return result
}

/**
 * タイムライン内絶対X座標（列グリッド左端=0）から対応する稼働スロットを返す。
 * 休業日列上のポインターは最近傍の稼働スロットにスナップする。
 * 稼働列が存在しない場合は null。
 *
 * 戻り値の workingSlotIndex を drag / resize の delta 計算に使用することで、
 * 非稼働日（12px 列）を跨いでも座標ズレが発生しない single source of truth になる。
 *
 * delta = pointerXToSlot(curX).workingSlotIndex
 *       - pointerXToSlot(startX).workingSlotIndex
 *
 * - scrollLeft や LEFT_WIDTH の減算はこの関数の外（呼び出し側）で行う。
 * - drag・resize・auto-pan すべてで同じ関数を使うことで座標ズレを防ぐ。
 */
export function pointerXToSlot(
  timelineX: number,
  layout: ColumnLayout[],
): { date: string; period: 'am' | 'pm'; workingSlotIndex: number } | null {
  if (layout.length === 0) return null

  // グリッド範囲にクランプ
  const x = Math.max(
    layout[0].xStart,
    Math.min(timelineX, layout[layout.length - 1].xEnd - 0.001),
  )

  // 二分探索: layout[lo].xStart <= x < layout[lo].xEnd を満たす lo を求める
  let lo = 0, hi = layout.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layout[mid].xStart <= x) lo = mid
    else hi = mid - 1
  }
  const col = layout[lo]

  if (col.type === 'slot' && col.workingSlotIndex !== null) {
    return { date: col.date, period: col.period, workingSlotIndex: col.workingSlotIndex }
  }

  // 休業日列 → 最近傍の稼働スロットにスナップ
  let leftCol:  (typeof layout[0] & { type: 'slot'; workingSlotIndex: number }) | null = null
  let rightCol: (typeof layout[0] & { type: 'slot'; workingSlotIndex: number }) | null = null
  for (let i = lo - 1; i >= 0; i--) {
    const c = layout[i]
    if (c.type === 'slot' && c.workingSlotIndex !== null) {
      leftCol = c as typeof layout[0] & { type: 'slot'; workingSlotIndex: number }
      break
    }
  }
  for (let i = lo + 1; i < layout.length; i++) {
    const c = layout[i]
    if (c.type === 'slot' && c.workingSlotIndex !== null) {
      rightCol = c as typeof layout[0] & { type: 'slot'; workingSlotIndex: number }
      break
    }
  }

  const midX    = (col.xStart + col.xEnd) / 2
  const picked  = x <= midX ? (leftCol ?? rightCol) : (rightCol ?? leftCol)
  if (!picked) return null
  return { date: picked.date, period: picked.period, workingSlotIndex: picked.workingSlotIndex }
}

// ── working slot ベースのシフト / リサイズ ───────────────────────
//
// カレンダー絶対スロット（shiftItemBySlots 等）ではなく稼働スロット単位で操作する。
// drag delta = curWorkingSlotIndex - startWorkingSlotIndex を渡す。
// 非稼働日を跨いでも "1 working slot 列 = 1 delta" が保証される。

/**
 * 工程を workingDelta 稼働スロット分だけシフトする。
 * 開始・終了の両方を同数だけ前進/後退し、工程長（稼働スロット数）を保つ。
 */
export function shiftItemByWorkingSlots(
  item:         ItemDates,
  workingDelta: number,
  options:      ScheduleCalendarOptions,
): ItemDates {
  if (workingDelta === 0) return item
  const newStart = advanceWorkingSlots({ date: item.start_date, period: item.start_period }, workingDelta, options)
  const newEnd   = advanceWorkingSlots({ date: item.end_date,   period: item.end_period   }, workingDelta, options)
  return {
    start_date:   newStart.date,
    start_period: newStart.period,
    end_date:     newEnd.date,
    end_period:   newEnd.period,
  }
}

/**
 * 開始スロットを workingDelta 稼働スロット分だけ変更する（左端リサイズ）。
 * 最低1スロット長を保証する（start > end になる場合は start = end に固定）。
 */
export function resizeItemStartByWorking(
  item:         ItemDates,
  workingDelta: number,
  options:      ScheduleCalendarOptions,
): ItemDates {
  const newStart = advanceWorkingSlots({ date: item.start_date, period: item.start_period }, workingDelta, options)
  // start が end を超えた場合は end に固定
  const clampedStart = (
    newStart.date > item.end_date ||
    (newStart.date === item.end_date && newStart.period > item.end_period)
  ) ? { date: item.end_date, period: item.end_period } : newStart
  return {
    start_date:   clampedStart.date,
    start_period: clampedStart.period,
    end_date:     item.end_date,
    end_period:   item.end_period,
  }
}

/**
 * 終了スロットを workingDelta 稼働スロット分だけ変更する（右端リサイズ）。
 * 最低1スロット長を保証する（end < start になる場合は end = start に固定）。
 */
export function resizeItemEndByWorking(
  item:         ItemDates,
  workingDelta: number,
  options:      ScheduleCalendarOptions,
): ItemDates {
  const newEnd = advanceWorkingSlots({ date: item.end_date, period: item.end_period }, workingDelta, options)
  // end が start より前になった場合は start に固定
  const clampedEnd = (
    newEnd.date < item.start_date ||
    (newEnd.date === item.start_date && newEnd.period < item.start_period)
  ) ? { date: item.start_date, period: item.start_period } : newEnd
  return {
    start_date:   item.start_date,
    start_period: item.start_period,
    end_date:     clampedEnd.date,
    end_period:   clampedEnd.period,
  }
}

// ── ビュー内スロット範囲（後方互換 & テスト用）──────────────────

export type SlotRange = {
  clippedStart:  number
  clippedEnd:    number
  hasLeftClip:   boolean
  hasRightClip:  boolean
}

export function getViewSlotRange(
  dates: ItemDates,
  viewStart: string,
  totalSlots: number,
): SlotRange | null {
  if (!dates.start_date || !dates.end_date) return null
  if (dates.start_date > dates.end_date) return null

  const absStart = datePeriodToAbsSlot(dates.start_date, dates.start_period, viewStart)
  const absEnd   = datePeriodToAbsSlot(dates.end_date,   dates.end_period,   viewStart)

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

// ── 重複検出 ──────────────────────────────────────────────────

export type ConflictableItem = {
  id:          string
  vendor_name: string | null
  start_date:  string | null
  end_date:    string | null
}

export function detectConflictIds(items: ConflictableItem[]): Set<string> {
  const conflictedIds = new Set<string>()
  const byVendor      = new Map<string, ConflictableItem[]>()

  for (const item of items) {
    if (!item.vendor_name || !item.start_date || !item.end_date) continue
    const group = byVendor.get(item.vendor_name) ?? []
    group.push(item)
    byVendor.set(item.vendor_name, group)
  }

  for (const group of byVendor.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j]
        if (a.start_date! <= b.end_date! && a.end_date! >= b.start_date!) {
          conflictedIds.add(a.id)
          conflictedIds.add(b.id)
        }
      }
    }
  }
  return conflictedIds
}
