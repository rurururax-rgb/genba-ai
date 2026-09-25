import type { SupabaseClient } from '@supabase/supabase-js'

// ── 型 ──────────────────────────────────────────────────────

export type BatchDraftItem = {
  name:               string
  category?:          string | null
  vendor_name?:       string | null
  assignee?:          string | null
  start_date?:        string | null
  end_date?:          string | null
  start_period?:      string
  end_period?:        string
  memo?:              string | null
  estimate_group_id?: string | null
}

export type BatchAdoptInput = {
  project_id: string
  company_id: string
  draft_id:   string
  items:      BatchDraftItem[]
}

// ── バリデーション ────────────────────────────────────────────

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/
const PERIODS   = new Set(['am', 'pm'])
const MAX_ITEMS = 100

export type ValidationError = { index: number; field: string; message: string }

export function validateBatchItems(items: BatchDraftItem[]): ValidationError[] {
  const errors: ValidationError[] = []
  if (items.length > MAX_ITEMS) {
    errors.push({ index: -1, field: 'items', message: `最大 ${MAX_ITEMS} 件まで（${items.length} 件が指定されました）` })
    return errors
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it.name?.trim()) {
      errors.push({ index: i, field: 'name', message: '工程名は必須です' })
    }
    if (it.start_period && !PERIODS.has(it.start_period)) {
      errors.push({ index: i, field: 'start_period', message: "'am' または 'pm' である必要があります" })
    }
    if (it.end_period && !PERIODS.has(it.end_period)) {
      errors.push({ index: i, field: 'end_period', message: "'am' または 'pm' である必要があります" })
    }
    if (it.start_date && !DATE_RE.test(it.start_date)) {
      errors.push({ index: i, field: 'start_date', message: 'YYYY-MM-DD 形式である必要があります' })
    }
    if (it.end_date && !DATE_RE.test(it.end_date)) {
      errors.push({ index: i, field: 'end_date', message: 'YYYY-MM-DD 形式である必要があります' })
    }
    if (it.start_date && it.end_date && it.start_date > it.end_date) {
      errors.push({ index: i, field: 'end_date', message: '終了日は開始日以降である必要があります' })
    }
  }
  return errors
}

// ── バッチ採用（DB に書き込む中核ロジック） ──────────────────

export type BatchAdoptResult =
  | { ok: true;  inserted: number }
  | { ok: false; status: number; error: string }

export async function batchAdoptScheduleItems(
  supabase: SupabaseClient,
  input: BatchAdoptInput,
): Promise<BatchAdoptResult> {
  const { project_id, company_id, draft_id, items } = input

  // 1. 全件バリデーション
  const validationErrors = validateBatchItems(items)
  if (validationErrors.length > 0) {
    const first = validationErrors[0]
    const msg = first.index >= 0
      ? `items[${first.index}].${first.field}: ${first.message}`
      : first.message
    return { ok: false, status: 400, error: msg }
  }

  // 2. estimate_group_id の存在確認（グループ指定があるもののみ）
  const groupIds = [...new Set(items.map(i => i.estimate_group_id).filter(Boolean))]
  if (groupIds.length > 0) {
    const { data: groups } = await supabase
      .from('estimate_groups')
      .select('id')
      .eq('project_id', project_id)
      .in('id', groupIds as string[])
      .is('deleted_at', null)

    const validGroupIds = new Set((groups ?? []).map((g: { id: string }) => g.id))
    for (let i = 0; i < items.length; i++) {
      const gid = items[i].estimate_group_id
      if (gid && !validGroupIds.has(gid)) {
        return { ok: false, status: 400, error: `items[${i}].estimate_group_id が不正です` }
      }
    }
  }

  // 3. 二重採用防止: draft_id を先にINSERT（PRIMARY KEY 制約で一意性を担保）
  const { error: draftErr } = await supabase
    .from('schedule_draft_adoptions')
    .insert({ draft_id, project_id, company_id })

  if (draftErr) {
    if (draftErr.code === '23505') {
      return { ok: false, status: 409, error: 'この工程案はすでに採用済みです（二重採用防止）' }
    }
    return { ok: false, status: 500, error: draftErr.message }
  }

  // 4. 既存 sort_order の最大値を取得
  const { data: existing } = await supabase
    .from('schedule_items')
    .select('sort_order')
    .eq('project_id', project_id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)

  const baseOrder = (existing as Array<{ sort_order: number }> | null)?.[0]?.sort_order ?? -1

  // 5. 一括 INSERT（単一 SQL 文のため原子的。失敗時は全件ロールバック）
  const rows = items.map((item, i) => ({
    project_id,
    company_id,
    name:              item.name.trim(),
    category:          item.category          ?? null,
    vendor_name:       item.vendor_name       ?? null,
    assignee:          item.assignee          ?? null,
    start_date:        item.start_date        ?? null,
    end_date:          item.end_date          ?? null,
    start_period:      PERIODS.has(item.start_period ?? '') ? item.start_period : 'am',
    end_period:        PERIODS.has(item.end_period   ?? '') ? item.end_period   : 'pm',
    memo:              item.memo              ?? null,
    estimate_group_id: item.estimate_group_id ?? null,
    status:            'planned',
    source:            'ai',
    sort_order:        baseOrder + 1 + i,
  }))

  const { data: inserted, error: insertErr } = await supabase
    .from('schedule_items')
    .insert(rows)
    .select('id')

  if (insertErr) {
    // INSERT 失敗時は draft_id を削除してリトライを可能にする
    await supabase
      .from('schedule_draft_adoptions')
      .delete()
      .eq('draft_id', draft_id)
    return { ok: false, status: 500, error: insertErr.message }
  }

  return { ok: true, inserted: (inserted as Array<{ id: string }> | null)?.length ?? rows.length }
}
