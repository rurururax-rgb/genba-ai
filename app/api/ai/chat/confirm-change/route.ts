/**
 * POST /api/ai/chat/confirm-change
 *
 * チャットエージェントが提案した「未確定の変更」をユーザーが確定したとき呼ばれる。
 * - getServerClient()（RLS有効）のみ使用。admin.ts は不使用
 * - project_id / company_id はリクエストボディに含まれても、
 *   セッションから取得した値で上書きするか RLS で検証する
 * - 書き込み可能フィールドをホワイトリスト制御し SQL injection / 不正書き込みを防ぐ
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import type { ConfirmableChange } from '@/lib/ai/chat/types'

// ── 書き込み許可フィールドのホワイトリスト ────────────────────────────────

const ESTIMATE_ITEM_ALLOWED: ReadonlySet<string> = new Set([
  'name', 'quantity', 'unit', 'selling_price', 'memo',
  'cost_price', 'vendor_name', 'group_id',
])

const COST_LEDGER_ALLOWED: ReadonlySet<string> = new Set([
  'budget_cost', 'actual_cost', 'vendor_name', 'note',
])

const MATERIAL_MASTER_ALLOWED: ReadonlySet<string> = new Set([
  'name', 'spec', 'unit', 'selling_price', 'cost_price', 'url', 'category',
])

function pickAllowed(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => allowed.has(k)),
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json() as { change: ConfirmableChange }
  const { change } = body
  if (!change) return NextResponse.json({ error: 'change required' }, { status: 400 })

  const { target_table, change_type, proposed, original } = change

  // ──────────────────────────────────────────────────────────────────────────
  // estimate_items
  // ──────────────────────────────────────────────────────────────────────────

  if (target_table === 'estimate_items') {

    if (change_type === 'create') {
      // project_id は proposed に含まれている（executor が ctx.projectId を注入済み）
      const rawProjectId = proposed.project_id as string | undefined
      if (!rawProjectId) return NextResponse.json({ error: 'project_id missing in proposed' }, { status: 400 })

      // ユーザーがこの project に属する company_id を持つかを RLS が検証する
      const safeFields = pickAllowed(proposed, ESTIMATE_ITEM_ALLOWED)

      // 原価があるのに単価が未設定(null/0)の場合は cost_price × 1.45 で自動計算
      const rawSelling   = safeFields.selling_price as number | null | undefined
      const rawCost      = safeFields.cost_price    as number | null | undefined
      const autoSelling  =
        (rawSelling == null || rawSelling === 0) && rawCost != null && rawCost > 0
          ? Math.round(rawCost * 1.45)
          : rawSelling

      const { data, error } = await supabase
        .from('estimate_items')
        .insert({
          ...safeFields,
          selling_price: autoSelling ?? null,
          project_id: rawProjectId,
          company_id: membership.company_id,
          source:     'manual',
          sort_order: 9999,
        })
        .select('id, name, quantity, unit, selling_price, amount, cost_price, vendor_name, memo, group_id')
        .single()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }

    if (change_type === 'bulk_create') {
      // copy_items_from_project 用: items 配列を一括 INSERT
      const rawProjectId  = proposed.project_id  as string | undefined
      const targetGroupId = proposed.target_group_id as string | null | undefined
      const srcItems      = proposed.items as Record<string, unknown>[] | undefined

      if (!rawProjectId) return NextResponse.json({ error: 'project_id missing' }, { status: 400 })
      if (!Array.isArray(srcItems) || srcItems.length === 0) {
        return NextResponse.json({ error: 'items is empty' }, { status: 400 })
      }

      const rows = srcItems.map((item, idx) => {
        const safe        = pickAllowed(item, ESTIMATE_ITEM_ALLOWED)
        const rawSelling  = safe.selling_price as number | null | undefined
        const rawCost     = safe.cost_price    as number | null | undefined
        const autoSelling =
          (rawSelling == null || rawSelling === 0) && rawCost != null && rawCost > 0
            ? Math.round(rawCost * 1.45)
            : rawSelling
        return {
          ...safe,
          selling_price: autoSelling ?? null,
          project_id: rawProjectId,
          company_id: membership.company_id,
          group_id:   targetGroupId ?? null,
          source:     'manual',
          sort_order: (idx + 1) * 100,
        }
      })

      const { data, error } = await supabase
        .from('estimate_items')
        .insert(rows)
        .select('id, name, quantity, unit, selling_price, amount')

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, change_id: change.id, inserted_count: data?.length ?? 0, data })
    }

    if (change_type === 'update') {
      const itemId = proposed.id as string | undefined
      if (!itemId) return NextResponse.json({ error: 'proposed.id required for update' }, { status: 400 })

      const safeFields = pickAllowed(proposed, ESTIMATE_ITEM_ALLOWED)
      if (Object.keys(safeFields).length === 0) {
        return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('estimate_items')
        .update({ ...safeFields, updated_at: new Date().toISOString() })
        .eq('id', itemId)
        .is('deleted_at', null)
        .select('id, name, quantity, unit, selling_price, amount, cost_price, vendor_name, memo, group_id')
        .single()

      // RLS が弾いた場合は data が null になる
      if (error || !data) return NextResponse.json({ error: error?.message ?? 'Not found or unauthorized' }, { status: error ? 500 : 404 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }

    if (change_type === 'delete') {
      const itemId = proposed.id as string | undefined
      if (!itemId) return NextResponse.json({ error: 'proposed.id required for delete' }, { status: 400 })

      // 論理削除（estimate_items/[id]/route.ts の DELETE と同パターン）
      const { data: item } = await supabase
        .from('estimate_items')
        .select('id, line_event_id')
        .eq('id', itemId)
        .is('deleted_at', null)
        .single()
      if (!item) return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 })

      const { error } = await supabase
        .from('estimate_items')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', itemId)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      const itemName = (original?.name ?? '項目') as string
      return NextResponse.json({ ok: true, change_id: change.id, deleted_name: itemName })
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // cost_ledger_items
  // ──────────────────────────────────────────────────────────────────────────

  if (target_table === 'cost_ledger_items') {

    if (change_type === 'update') {
      const itemId = proposed.id as string | undefined
      if (!itemId) return NextResponse.json({ error: 'proposed.id required for update' }, { status: 400 })

      const safeFields = pickAllowed(proposed, COST_LEDGER_ALLOWED)
      if (Object.keys(safeFields).length === 0) {
        return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('cost_ledger_items')
        .update({ ...safeFields, updated_at: new Date().toISOString() })
        .eq('id', itemId)
        .is('deleted_at', null)
        .select('id, name, budget_cost, actual_cost, vendor_name, note')
        .single()

      if (error || !data) return NextResponse.json({ error: error?.message ?? 'Not found or unauthorized' }, { status: error ? 500 : 404 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // company_estimate_items（資材マスター）
  // ──────────────────────────────────────────────────────────────────────────

  if (target_table === 'company_estimate_items') {

    if (change_type === 'create') {
      const safeFields = pickAllowed(proposed, MATERIAL_MASTER_ALLOWED)

      const { data, error } = await supabase
        .from('company_estimate_items')
        .insert({
          ...safeFields,
          company_id:  membership.company_id,
          usage_count: 1,
          last_used_at: new Date().toISOString(),
        })
        .select('id, name, spec, unit, selling_price, cost_price, url, category, created_at')
        .single()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }

    if (change_type === 'update') {
      const itemId = proposed.id as string | undefined
      if (!itemId) return NextResponse.json({ error: 'proposed.id required for update' }, { status: 400 })

      const safeFields = pickAllowed(proposed, MATERIAL_MASTER_ALLOWED)
      if (Object.keys(safeFields).length === 0) {
        return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('company_estimate_items')
        .update({ ...safeFields, updated_at: new Date().toISOString() })
        .eq('id', itemId)
        .eq('company_id', membership.company_id)
        .select('id, name, spec, unit, selling_price, cost_price, url, category')
        .single()

      if (error || !data) return NextResponse.json({ error: error?.message ?? 'Not found or unauthorized' }, { status: error ? 500 : 404 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }

    if (change_type === 'delete') {
      const itemId = proposed.id as string | undefined
      if (!itemId) return NextResponse.json({ error: 'proposed.id required for delete' }, { status: 400 })

      const { error } = await supabase
        .from('company_estimate_items')
        .delete()
        .eq('id', itemId)
        .eq('company_id', membership.company_id)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, change_id: change.id })
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // invoice_documents（請求書下書き作成）
  //
  // 安全性:
  //   - project_id の自社所属は RLS で担保
  //   - サーバー側で二重作成防止チェック（draft/issued が既存なら拒否）
  //   - change_type は 'create' のみ許可（発行・削除は別 API）
  // ──────────────────────────────────────────────────────────────────────────

  if (target_table === 'invoice_documents') {

    if (change_type === 'create') {
      const rawProjectId = proposed.project_id as string | undefined
      if (!rawProjectId) return NextResponse.json({ error: 'project_id missing in proposed' }, { status: 400 })

      // 案件が自社のものか確認（RLS に加えて明示的に検証）
      const { data: projectCheck } = await supabase
        .from('projects')
        .select('id, name')
        .eq('id', rawProjectId)
        .is('deleted_at', null)
        .single()
      if (!projectCheck) return NextResponse.json({ error: '案件が見つかりません' }, { status: 404 })

      // サーバー側二重作成防止チェック（draft/issued が既存なら拒否）
      const { data: existingInvoice } = await supabase
        .from('invoice_documents')
        .select('id, status')
        .eq('project_id', rawProjectId)
        .in('status', ['draft', 'issued'])
        .limit(1)

      if (existingInvoice && existingInvoice.length > 0) {
        return NextResponse.json({
          error: `案件「${projectCheck.name}」には既に請求書（${existingInvoice[0].status}）が存在します。二重作成はできません。`,
        }, { status: 409 })
      }

      // 下書き作成（status = 'draft'）
      const memo = (proposed.memo ?? proposed.note) as string | null | undefined
      const { data, error } = await supabase
        .from('invoice_documents')
        .insert({
          project_id: rawProjectId,
          company_id: membership.company_id,
          status:     'draft',
          memo:       memo ?? null,
        })
        .select('id, project_id, status, memo, created_at')
        .single()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, change_id: change.id, data })
    }
  }

  return NextResponse.json({ error: `未対応の操作: ${target_table} / ${change_type}` }, { status: 400 })
}
