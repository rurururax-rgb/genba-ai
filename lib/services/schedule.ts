/**
 * lib/services/schedule.ts
 *
 * 工程表 CRUD サービス。
 * Phase 2（AI工程案生成）でも再利用できるように関数を分離。
 *
 * 将来の AI Tool候補:
 *   get_schedule / create_schedule_draft / update_schedule_item / detect_schedule_conflicts
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ── 型定義 ───────────────────────────────────────────────────────────

export type ScheduleStatus = 'planned' | 'confirmed' | 'in_progress' | 'done' | 'delayed'

export type SchedulePeriod = 'am' | 'pm'

export type ScheduleItem = {
  id:                string
  project_id:        string
  company_id:        string
  name:              string
  category:          string | null
  vendor_name:       string | null
  assignee:          string | null
  start_date:        string | null  // YYYY-MM-DD
  end_date:          string | null  // YYYY-MM-DD
  start_period:      SchedulePeriod
  end_period:        SchedulePeriod
  status:            ScheduleStatus
  memo:              string | null
  sort_order:        number
  source:            string
  estimate_group_id: string | null
  created_at:        string
  updated_at:        string
}

export type ScheduleConflict = {
  itemA: ScheduleItem
  itemB: ScheduleItem
  vendorName: string
}

// ── 取得 ─────────────────────────────────────────────────────────────

/**
 * 案件の工程一覧を sort_order 昇順で取得する。
 * RLS が有効なクライアントでは自社データのみ返される。
 */
export async function getProjectSchedule(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ScheduleItem[]> {
  const { data, error } = await supabase
    .from('schedule_items')
    .select('id, project_id, company_id, name, category, vendor_name, assignee, start_date, end_date, start_period, end_period, status, memo, sort_order, source, estimate_group_id, created_at, updated_at')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })

  if (error) throw new Error(`getProjectSchedule: ${error.message}`)
  return (data ?? []) as ScheduleItem[]
}

// ── 作成 ─────────────────────────────────────────────────────────────

export type CreateScheduleItemInput = {
  name:              string
  category?:         string | null
  vendor_name?:      string | null
  assignee?:         string | null
  start_date?:       string | null
  end_date?:         string | null
  start_period?:     SchedulePeriod
  end_period?:       SchedulePeriod
  status?:           ScheduleStatus
  memo?:             string | null
  estimate_group_id?: string | null
  sort_order?:       number
}

export async function createScheduleItem(
  supabase: SupabaseClient,
  projectId: string,
  companyId: string,
  input: CreateScheduleItemInput,
): Promise<ScheduleItem> {
  // sort_order が未指定なら末尾に追加
  let sortOrder = input.sort_order ?? 0
  if (input.sort_order === undefined) {
    const { data: maxRow } = await supabase
      .from('schedule_items')
      .select('sort_order')
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('sort_order', { ascending: false })
      .limit(1)
    sortOrder = ((maxRow?.[0]?.sort_order as number | undefined) ?? -1) + 1
  }

  const { data, error } = await supabase
    .from('schedule_items')
    .insert({
      project_id:        projectId,
      company_id:        companyId,
      name:              input.name.trim(),
      category:          input.category ?? null,
      vendor_name:       input.vendor_name ?? null,
      assignee:          input.assignee ?? null,
      start_date:        input.start_date ?? null,
      end_date:          input.end_date ?? null,
      start_period:      input.start_period ?? 'am',
      end_period:        input.end_period ?? 'pm',
      status:            input.status ?? 'planned',
      memo:              input.memo ?? null,
      estimate_group_id: input.estimate_group_id ?? null,
      sort_order:        sortOrder,
      source:            'manual',
    })
    .select('id, project_id, company_id, name, category, vendor_name, assignee, start_date, end_date, start_period, end_period, status, memo, sort_order, source, estimate_group_id, created_at, updated_at')
    .single()

  if (error) throw new Error(`createScheduleItem: ${error.message}`)
  return data as ScheduleItem
}

// ── 更新 ─────────────────────────────────────────────────────────────

export type UpdateScheduleItemInput = Partial<Omit<CreateScheduleItemInput, 'sort_order'>>

export async function updateScheduleItem(
  supabase: SupabaseClient,
  itemId: string,
  input: UpdateScheduleItemInput,
): Promise<ScheduleItem> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (input.name              !== undefined) patch.name              = input.name?.trim()
  if (input.category          !== undefined) patch.category          = input.category
  if (input.vendor_name       !== undefined) patch.vendor_name       = input.vendor_name
  if (input.assignee          !== undefined) patch.assignee          = input.assignee
  if (input.start_date        !== undefined) patch.start_date        = input.start_date
  if (input.end_date          !== undefined) patch.end_date          = input.end_date
  if (input.start_period      !== undefined) patch.start_period      = input.start_period
  if (input.end_period        !== undefined) patch.end_period        = input.end_period
  if (input.status            !== undefined) patch.status            = input.status
  if (input.memo              !== undefined) patch.memo              = input.memo
  if (input.estimate_group_id !== undefined) patch.estimate_group_id = input.estimate_group_id

  const { data, error } = await supabase
    .from('schedule_items')
    .update(patch)
    .eq('id', itemId)
    .is('deleted_at', null)
    .select('id, project_id, company_id, name, category, vendor_name, assignee, start_date, end_date, start_period, end_period, status, memo, sort_order, source, estimate_group_id, created_at, updated_at')
    .single()

  if (error) throw new Error(`updateScheduleItem: ${error.message}`)
  return data as ScheduleItem
}

// ── 削除 ─────────────────────────────────────────────────────────────

export async function deleteScheduleItem(
  supabase: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await supabase
    .from('schedule_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', itemId)
    .is('deleted_at', null)

  if (error) throw new Error(`deleteScheduleItem: ${error.message}`)
}

// ── 並び替え ──────────────────────────────────────────────────────────

/**
 * 工程の並び順を一括更新する。
 * orderedIds: 新しい表示順の ID 配列
 */
export async function reorderScheduleItems(
  supabase: SupabaseClient,
  orderedIds: string[],
): Promise<void> {
  const updates = orderedIds.map((id, i) =>
    supabase
      .from('schedule_items')
      .update({ sort_order: i, updated_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
  )
  const results = await Promise.all(updates)
  const firstError = results.find(r => r.error)
  if (firstError?.error) throw new Error(`reorderScheduleItems: ${firstError.error.message}`)
}

// ── 重複チェック ──────────────────────────────────────────────────────

/**
 * 同一業者・同一期間の重複を検出する。
 * 両者とも start_date / end_date が設定されている場合のみ判定。
 */
export function detectScheduleConflicts(items: ScheduleItem[]): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = []

  // 業者ごとにグループ化（vendor_name がない行は除外）
  const byVendor = new Map<string, ScheduleItem[]>()
  for (const item of items) {
    if (!item.vendor_name || !item.start_date || !item.end_date) continue
    const key = item.vendor_name
    if (!byVendor.has(key)) byVendor.set(key, [])
    byVendor.get(key)!.push(item)
  }

  for (const [vendorName, vendorItems] of byVendor) {
    for (let i = 0; i < vendorItems.length; i++) {
      for (let j = i + 1; j < vendorItems.length; j++) {
        const a = vendorItems[i]
        const b = vendorItems[j]
        // 重複判定: a.start <= b.end && a.end >= b.start
        if (a.start_date! <= b.end_date! && a.end_date! >= b.start_date!) {
          conflicts.push({ itemA: a, itemB: b, vendorName })
        }
      }
    }
  }

  return conflicts
}
