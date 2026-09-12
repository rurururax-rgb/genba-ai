import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

const TEXT_FIELDS = [
  'name', 'customer_name', 'site_address', 'status',
  'person_in_charge', 'construction_period', 'payment_terms',
  'construction_overview', 'project_memo',
] as const

const NUM_FIELDS = [
  'misc_expense_override', 'rounding_discount',
  'estimate_valid_months',
  'payment_contract_pct', 'payment_start_pct', 'payment_completion_pct',
] as const

const DATE_FIELDS = ['estimate_valid_from'] as const

type ProjectPatch = {
  [K in typeof TEXT_FIELDS[number]]?: string | null
} & {
  [K in typeof NUM_FIELDS[number]]?: number | null
} & {
  [K in typeof DATE_FIELDS[number]]?: string | null
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>

  const patch: ProjectPatch = {}

  for (const key of TEXT_FIELDS) {
    if (key in body) {
      const v = body[key]
      patch[key] = v === null ? null : String(v)
    }
  }
  for (const key of NUM_FIELDS) {
    if (key in body) {
      const v = body[key]
      patch[key] = v === null ? null : Number(v)
    }
  }
  for (const key of DATE_FIELDS) {
    if (key in body) {
      const v = body[key]
      patch[key] = v === null ? null : String(v)
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid fields' }, { status: 400 })
  }

  const supabase = await getServerClient()

  // status が 'done' に変わる場合はマスター還元の準備
  let shouldReflect = false
  let companyId: string | null = null
  if (patch.status === 'done') {
    const { data: current } = await supabase
      .from('projects')
      .select('status, company_id')
      .eq('id', id)
      .single()
    if (current && current.status !== 'done') {
      shouldReflect = true
      companyId = current.company_id as string
    }
  }

  const { data, error } = await supabase
    .from('projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id,name,customer_name,site_address,status,person_in_charge,construction_period,payment_terms,estimate_valid_from,estimate_valid_months,construction_overview,project_memo,payment_contract_pct,payment_start_pct,payment_completion_pct,misc_expense_override,rounding_discount')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 完了ステータスへの変更 → 見積項目をマスターに還元（非同期・失敗しても本体は成功扱い）
  if (shouldReflect && companyId) {
    reflectToMaster(id, companyId, supabase).catch(err =>
      console.error('[reflectToMaster] failed:', err)
    )
  }

  return NextResponse.json(data)
}

// ── マスター自動還元 ──────────────────────────────────────────────────────────
async function reflectToMaster(
  projectId: string,
  companyId: string,
  supabase: SupabaseClient,
) {
  // 対象の見積項目を取得（itemタイプ・単価あり・削除なし）
  const { data: items } = await supabase
    .from('estimate_items')
    .select('name, category, unit, selling_price, cost_price, memo')
    .eq('project_id', projectId)
    .eq('row_type', 'item')
    .not('selling_price', 'is', null)
    .is('deleted_at', null)

  if (!items || items.length === 0) return

  // 既存マスターの中で名前が一致するものを取得
  const names = [...new Set(items.map(i => i.name as string))]
  const { data: existing } = await supabase
    .from('company_estimate_items')
    .select('id, name, usage_count')
    .eq('company_id', companyId)
    .in('name', names)

  // name → 既存レコードのマップ（同名複数の場合は最初の1件を採用）
  const existingMap = new Map(
    (existing ?? []).map(e => [e.name as string, e])
  )

  const now = new Date().toISOString()
  const updates: PromiseLike<unknown>[] = []
  const inserts: Record<string, unknown>[] = []

  for (const item of items) {
    const name = item.name as string
    const ex   = existingMap.get(name)
    if (ex) {
      // 既存：usage_count をインクリメント、単価・単位を最新値で上書き
      updates.push(
        supabase
          .from('company_estimate_items')
          .update({
            selling_price: item.selling_price,
            cost_price:    item.cost_price,
            unit:          item.unit,
            category:      item.category,
            usage_count:   (ex.usage_count as number ?? 0) + 1,
            last_used_at:  now,
            updated_at:    now,
          })
          .eq('id', ex.id)
          .then()
      )
    } else {
      // 新規：マスターに追加
      inserts.push({
        company_id:    companyId,
        name,
        category:      item.category,
        unit:          item.unit,
        selling_price: item.selling_price,
        cost_price:    item.cost_price,
        memo:          item.memo,
        usage_count:   1,
        last_used_at:  now,
      })
      existingMap.set(name, { id: '', name, usage_count: 1 }) // 重複挿入防止
    }
  }

  await Promise.all(updates)
  if (inserts.length > 0) {
    await supabase.from('company_estimate_items').insert(inserts)
  }
}
