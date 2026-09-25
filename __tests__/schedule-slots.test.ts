/**
 * Tests A-T (Phase 2.5) — schedule-slots.ts 純粋関数テスト
 *
 * 命名規則: "TEST A" など仕様上のラベルをコメントで保持する
 */

import { describe, it, expect } from 'vitest'
import {
  addDays,
  dayDiff,
  todayJST,
  isWorkingDay,
  isWorkingSlot,
  advanceOneSlot,
  nextWorkingSlot,
  datePeriodToAbsSlot,
  absSlotToDatePeriod,
  shiftItemBySlots,
  resizeItemStart,
  resizeItemEnd,
  buildScheduleDates,
  getViewSlotRange,
  detectConflictIds,
  DEFAULT_CALENDAR,
  type ScheduleCalendarOptions,
  type ItemDates,
} from '@/lib/services/schedule-slots'

// ── 基本日付ユーティリティ ─────────────────────────────────────

describe('addDays', () => {
  it('正数・負数の加算', () => {
    expect(addDays('2026-09-01', 3)).toBe('2026-09-04')
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31')
  })
  it('月をまたぐ', () => {
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02')
  })
  it('JST 境界: T12:00:00Z で計算するためズレない', () => {
    // UTC+9 の時刻で日付が変わらないことを確認
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('dayDiff', () => {
  it('a - b の日数差を返す', () => {
    expect(dayDiff('2026-09-05', '2026-09-01')).toBe(4)
    expect(dayDiff('2026-09-01', '2026-09-05')).toBe(-4)
    expect(dayDiff('2026-09-01', '2026-09-01')).toBe(0)
  })
})

// ── 稼働日判定 ─────────────────────────────────────────────────

describe('isWorkingDay', () => {
  // 2026-09-07 = 月曜, 2026-09-12 = 土曜, 2026-09-13 = 日曜 (実測済み)
  const MON = '2026-09-07'
  const SAT = '2026-09-12'
  const SUN = '2026-09-13'

  it('平日は常に稼働日', () => {
    expect(isWorkingDay(MON, DEFAULT_CALENDAR)).toBe(true)
    expect(isWorkingDay(MON, { nonWorkingWeekdays: [0, 6], nonWorkingDates: [] })).toBe(true)
  })

  // TEST N: 土曜を非稼働にする
  it('TEST N: nonWorkingWeekdays に土曜(6)を含めると非稼働日になる', () => {
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0, 6], nonWorkingDates: [] }
    expect(isWorkingDay(SAT, opts)).toBe(false)
    expect(isWorkingDay(SAT, DEFAULT_CALENDAR)).toBe(true) // DEFAULT は土曜稼働
  })

  // TEST O: 日曜を非稼働にする
  it('TEST O: nonWorkingWeekdays に日曜(0)を含めると非稼働日になる', () => {
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0], nonWorkingDates: [] }
    expect(isWorkingDay(SUN, opts)).toBe(false)
    expect(isWorkingDay(SUN, { nonWorkingWeekdays: [], nonWorkingDates: [] })).toBe(true)
  })

  it('isHoliday フック: 任意の日付を非稼働に', () => {
    const opts: ScheduleCalendarOptions = {
      nonWorkingWeekdays: [],
      nonWorkingDates:    [],
      isHoliday: (d) => d === MON,
    }
    expect(isWorkingDay(MON, opts)).toBe(false)
  })
})

// ── スロットナビゲーション ────────────────────────────────────

describe('advanceOneSlot', () => {
  it('AM → PM（同日）', () => {
    const next = advanceOneSlot({ date: '2026-09-01', period: 'am' })
    expect(next).toEqual({ date: '2026-09-01', period: 'pm' })
  })
  it('PM → AM（翌日）', () => {
    const next = advanceOneSlot({ date: '2026-09-01', period: 'pm' })
    expect(next).toEqual({ date: '2026-09-02', period: 'am' })
  })
})

describe('nextWorkingSlot', () => {
  // 2026-09-13 = 日曜, 2026-09-14 = 月曜
  it('稼働日のスロットをそのまま返す', () => {
    const result = nextWorkingSlot({ date: '2026-09-07', period: 'am' }, DEFAULT_CALENDAR)
    expect(result).toEqual({ date: '2026-09-07', period: 'am' })
  })
  it('日曜が非稼働なら翌月曜にスキップ', () => {
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0], nonWorkingDates: [] }
    const result = nextWorkingSlot({ date: '2026-09-13', period: 'am' }, opts) // 2026-09-13=日
    expect(result.date).toBe('2026-09-14')
  })
  it('土日両方非稼働なら月曜にスキップ', () => {
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0, 6], nonWorkingDates: [] }
    // 2026-09-12 = 土曜 → 翌月曜 = 2026-09-14
    const result = nextWorkingSlot({ date: '2026-09-12', period: 'am' }, opts)
    expect(result.date).toBe('2026-09-14')
  })
})

// ── 絶対スロットインデックス ──────────────────────────────────

describe('datePeriodToAbsSlot / absSlotToDatePeriod', () => {
  const viewStart = '2026-09-01'

  it('viewStart AM = absSlot 0', () => {
    expect(datePeriodToAbsSlot('2026-09-01', 'am', viewStart)).toBe(0)
  })
  it('viewStart PM = absSlot 1', () => {
    expect(datePeriodToAbsSlot('2026-09-01', 'pm', viewStart)).toBe(1)
  })
  it('翌日 AM = absSlot 2', () => {
    expect(datePeriodToAbsSlot('2026-09-02', 'am', viewStart)).toBe(2)
  })
  it('負のスロット（viewStart以前）', () => {
    expect(datePeriodToAbsSlot('2026-08-31', 'pm', viewStart)).toBe(-1)
    expect(datePeriodToAbsSlot('2026-08-31', 'am', viewStart)).toBe(-2)
  })

  it('absSlotToDatePeriod は逆変換', () => {
    for (const slot of [0, 1, 2, 5, 27, -1, -2]) {
      const s = absSlotToDatePeriod(slot, viewStart)
      expect(datePeriodToAbsSlot(s.date, s.period, viewStart)).toBe(slot)
    }
  })
})

// ── shiftItemBySlots ──────────────────────────────────────────

const BASE_ITEM: ItemDates = {
  start_date: '2026-09-02', start_period: 'am',
  end_date:   '2026-09-03', end_period:   'pm',
}
const VIEW_START = '2026-09-01'

// TEST A: 正方向シフト
describe('shiftItemBySlots', () => {
  it('TEST A: +2 スロット（+1日）シフト', () => {
    const result = shiftItemBySlots(BASE_ITEM, 2, VIEW_START)
    expect(result.start_date).toBe('2026-09-03')
    expect(result.start_period).toBe('am')
    expect(result.end_date).toBe('2026-09-04')
    expect(result.end_period).toBe('pm')
  })

  // TEST B: 負方向シフト
  it('TEST B: -2 スロット（-1日）シフト', () => {
    const result = shiftItemBySlots(BASE_ITEM, -2, VIEW_START)
    expect(result.start_date).toBe('2026-09-01')
    expect(result.end_date).toBe('2026-09-02')
  })

  // TEST C: ゼロシフトで変化なし
  it('TEST C: 0 スロットで変化なし', () => {
    const result = shiftItemBySlots(BASE_ITEM, 0, VIEW_START)
    expect(result).toEqual(BASE_ITEM)
  })
})

// ── resizeItemEnd ─────────────────────────────────────────────

// TEST D: 終了リサイズ
describe('resizeItemEnd', () => {
  it('TEST D: +2 スロットで終了を延長', () => {
    const result = resizeItemEnd(BASE_ITEM, 2, VIEW_START)
    expect(result.start_date).toBe(BASE_ITEM.start_date)
    expect(result.start_period).toBe(BASE_ITEM.start_period)
    expect(result.end_date).toBe('2026-09-04')
    expect(result.end_period).toBe('pm')
  })

  it('end < start のとき最低1スロット保証（end = start に固定）', () => {
    const result = resizeItemEnd(BASE_ITEM, -100, VIEW_START)
    const startAbsSlot = datePeriodToAbsSlot(BASE_ITEM.start_date, BASE_ITEM.start_period, VIEW_START)
    const endAbsSlot   = datePeriodToAbsSlot(result.end_date, result.end_period, VIEW_START)
    expect(endAbsSlot).toBeGreaterThanOrEqual(startAbsSlot)
  })
})

// ── resizeItemStart ───────────────────────────────────────────

// TEST E: 開始リサイズ
describe('resizeItemStart', () => {
  it('TEST E: +2 スロットで開始を後ろにずらす', () => {
    const result = resizeItemStart(BASE_ITEM, 2, VIEW_START)
    expect(result.start_date).toBe('2026-09-03')
    expect(result.start_period).toBe('am')
    expect(result.end_date).toBe(BASE_ITEM.end_date)
    expect(result.end_period).toBe(BASE_ITEM.end_period)
  })

  // TEST F: 最低1スロット保証
  it('TEST F: start > end のとき start を end 位置に固定', () => {
    const result = resizeItemStart(BASE_ITEM, 100, VIEW_START)
    const startAbsSlot = datePeriodToAbsSlot(result.start_date, result.start_period, VIEW_START)
    const endAbsSlot   = datePeriodToAbsSlot(BASE_ITEM.end_date,  BASE_ITEM.end_period,  VIEW_START)
    expect(startAbsSlot).toBeLessThanOrEqual(endAbsSlot)
  })
})

// ── buildScheduleDates ────────────────────────────────────────

describe('buildScheduleDates', () => {
  const START = '2026-09-07' // 月曜

  // TEST G: ドラフトのドラッグは DB を呼ばない（純粋関数テスト）
  it('TEST G: duration_slots から日付を順次配置する（休日なし）', () => {
    const items = [
      { duration_slots: 2, name: '工程A' },
      { duration_slots: 4, name: '工程B' },
    ]
    const result = buildScheduleDates(items, START)
    // 工程A: 月曜AM〜月曜PM (2 slots)
    expect(result[0].start_date).toBe('2026-09-07')
    expect(result[0].start_period).toBe('am')
    expect(result[0].end_date).toBe('2026-09-07')
    expect(result[0].end_period).toBe('pm')
    // 工程B: 火曜AM〜水曜PM (4 slots)
    expect(result[1].start_date).toBe('2026-09-08')
    expect(result[1].start_period).toBe('am')
    expect(result[1].end_date).toBe('2026-09-09')
    expect(result[1].end_period).toBe('pm')
  })

  // TEST H: 元のプロパティが保持される
  it('TEST H: 元アイテムのプロパティを保持する', () => {
    const items = [{ duration_slots: 2, name: '大工工事', vendor_name: '山田建設' }]
    const result = buildScheduleDates(items, START)
    expect(result[0].name).toBe('大工工事')
    expect(result[0].vendor_name).toBe('山田建設')
  })

  // TEST N: 土・日を非稼働にして土曜をスキップ
  it('TEST N: 土日を非稼働にすると土曜をスキップして日程を組む', () => {
    // 2026-09-12 (土), 2026-09-14 (月)
    const startFri = '2026-09-11' // 金曜
    const items    = [{ duration_slots: 4, name: '工程' }]
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0, 6], nonWorkingDates: [] }
    const result = buildScheduleDates(items, startFri, opts)
    // 金曜AM、金曜PM、→ 土・日スキップ → 月曜AM、月曜PM
    expect(result[0].start_date).toBe('2026-09-11')
    expect(result[0].start_period).toBe('am')
    expect(result[0].end_date).toBe('2026-09-14')  // 月曜
    expect(result[0].end_period).toBe('pm')
  })

  // TEST O: DEFAULT_CALENDAR（日曜のみ休業）で日曜をスキップ
  it('TEST O: DEFAULT_CALENDAR（日曜のみ休業）は日曜をスキップ', () => {
    const startSat = '2026-09-12' // 土曜（DEFAULT は土曜稼働）
    const items    = [{ duration_slots: 4, name: '工程' }]
    const result   = buildScheduleDates(items, startSat, DEFAULT_CALENDAR)
    // 土曜AM, 土曜PM → 日曜スキップ → 月曜AM, 月曜PM
    expect(result[0].start_date).toBe('2026-09-12')
    expect(result[0].start_period).toBe('am')
    expect(result[0].end_date).toBe('2026-09-14')
    expect(result[0].end_period).toBe('pm')
  })

  // TEST P: 開始日が非稼働日ならスキップして最初の稼働スロットから開始
  it('TEST P: 着工日が日曜なら翌月曜から開始', () => {
    const startSun = '2026-09-13' // 日曜
    const items    = [{ duration_slots: 2, name: '工程' }]
    const opts: ScheduleCalendarOptions = { nonWorkingWeekdays: [0], nonWorkingDates: [] }
    const result   = buildScheduleDates(items, startSun, opts)
    expect(result[0].start_date).toBe('2026-09-14')  // 月曜
    expect(result[0].start_period).toBe('am')
  })

  it('duration_slots=0 は最低 1 スロットとして扱う', () => {
    const items  = [{ duration_slots: 0, name: '工程' }]
    const result = buildScheduleDates(items, '2026-09-07')
    expect(result[0].start_date).toBe(result[0].end_date)
    expect(result[0].start_period).toBe(result[0].end_period)
  })
})

// ── getViewSlotRange ──────────────────────────────────────────

describe('getViewSlotRange', () => {
  const vs    = '2026-09-01'
  const total = 28 // 14 days × 2

  it('範囲内のアイテムを正しくクリップ', () => {
    const dates: ItemDates = { start_date: '2026-09-02', start_period: 'am', end_date: '2026-09-02', end_period: 'pm' }
    const range = getViewSlotRange(dates, vs, total)
    expect(range).not.toBeNull()
    expect(range!.clippedStart).toBe(2)
    expect(range!.clippedEnd).toBe(3)
    expect(range!.hasLeftClip).toBe(false)
    expect(range!.hasRightClip).toBe(false)
  })

  it('範囲外のアイテムは null', () => {
    const dates: ItemDates = { start_date: '2026-10-01', start_period: 'am', end_date: '2026-10-01', end_period: 'pm' }
    expect(getViewSlotRange(dates, vs, total)).toBeNull()
  })

  it('左クリップ', () => {
    const dates: ItemDates = { start_date: '2026-08-31', start_period: 'am', end_date: '2026-09-01', end_period: 'am' }
    const range = getViewSlotRange(dates, vs, total)
    expect(range!.hasLeftClip).toBe(true)
    expect(range!.clippedStart).toBe(0)
  })

  it('start > end は null', () => {
    const dates: ItemDates = { start_date: '2026-09-05', start_period: 'am', end_date: '2026-09-01', end_period: 'pm' }
    expect(getViewSlotRange(dates, vs, total)).toBeNull()
  })
})

// ── detectConflictIds ─────────────────────────────────────────

// TEST M: 業者重複検出
describe('detectConflictIds', () => {
  it('TEST M: 同業者で日付が重なれば両方を返す', () => {
    const items = [
      { id: 'a', vendor_name: '山田建設', start_date: '2026-09-01', end_date: '2026-09-05' },
      { id: 'b', vendor_name: '山田建設', start_date: '2026-09-04', end_date: '2026-09-08' },
      { id: 'c', vendor_name: '田中電気', start_date: '2026-09-01', end_date: '2026-09-05' },
    ]
    const result = detectConflictIds(items)
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(true)
    expect(result.has('c')).toBe(false)
  })

  it('同業者でも日付が隣接（重複なし）は検出しない', () => {
    const items = [
      { id: 'a', vendor_name: '山田建設', start_date: '2026-09-01', end_date: '2026-09-03' },
      { id: 'b', vendor_name: '山田建設', start_date: '2026-09-04', end_date: '2026-09-06' },
    ]
    const result = detectConflictIds(items)
    expect(result.size).toBe(0)
  })

  it('vendor_name が null のアイテムはスキップ', () => {
    const items = [
      { id: 'a', vendor_name: null, start_date: '2026-09-01', end_date: '2026-09-10' },
      { id: 'b', vendor_name: null, start_date: '2026-09-01', end_date: '2026-09-10' },
    ]
    const result = detectConflictIds(items)
    expect(result.size).toBe(0)
  })

  it('正式工程と AI案（ドラフト）を混在してチェック', () => {
    const items = [
      { id: 'real-1',  vendor_name: '山田建設', start_date: '2026-09-01', end_date: '2026-09-05' },
      { id: 'draft-1', vendor_name: '山田建設', start_date: '2026-09-03', end_date: '2026-09-07' },
    ]
    const result = detectConflictIds(items)
    expect(result.has('real-1')).toBe(true)
    expect(result.has('draft-1')).toBe(true)
  })
})
