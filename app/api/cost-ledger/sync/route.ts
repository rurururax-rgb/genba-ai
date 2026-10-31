import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { isActiveProject } from '@/lib/estimate/ownership'
import {
  countInvoicesByItem, protectionReasons, softDeleteIfEmpty, type ProtectionReason,
} from '@/lib/cost-ledger/ledger-protection'

// POST /api/cost-ledger/sync
// estimate_items の差分を cost_ledger_items に反映する
// - 既存行 (estimate_item_id あり): name/quantity/unit/estimate_cost/vendor_name を上書き
//   budget_cost / actual_cost / note は触らない（手動入力値を保持）
// - 見積に追加された行: 新規 INSERT
// - 見積から削除された行: 請求書・実績原価・予算がなければ soft-delete。
//   あれば残し（案件の合計から消さない。KI-005）、kept として返す。画面は「見積から削除済み」と表示する
//
// 失敗の扱い:
//   各 DB 操作のエラーを必ず確かめ、失敗したらその場で止めて 500（code: sync_failed・どの段階か・そこまでの件数）を返す。
//   同期は何度やり直しても同じ結果に収束する（追加済みの行は既存行として扱い、削除済みの行は対象外）ので、
//   途中で止まっても「もう一度同期」で残りが反映される。保護対象の行は途中で止まっても消えない。
// 同時実行:
//   ・請求書の登録・実績や予算の入力と重なっても、論理削除は値が空のままの行にしか効かない（ledger-protection.ts）
//   ・同期が 2 つ同時に動いて同じ見積行の台帳項目を 2 つ作った場合は、最も古い 1 行を残し、
//     自分が作った余分な行（値が空のもの）だけを論理削除する。どちらの同期も同じ規則で判断するので 1 行に収束する

type SyncStep = 'read_estimates' | 'read_ledger' | 'update' | 'insert' | 'dedupe' | 'count_invoices' | 'remove'

type KeptItem = { id: string; name: string; reasons: ProtectionReason[] }

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!member) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const body = await req.json().catch(() => null) as { project_id?: unknown } | null
  if (!body || typeof body.project_id !== 'string' || !body.project_id) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 })
  }

  const projectId = body.project_id
  const companyId = member.company_id
  if (!(await isActiveProject(supabase, projectId, companyId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  let added = 0, updated = 0, removed = 0, deduplicated = 0
  const kept: KeptItem[] = []
  const fail = (step: SyncStep) => {
    console.error('[cost-ledger sync] failed at', step)
    return NextResponse.json({
      error: '見積との同期が途中で失敗しました。もう一度「見積と同期」を押してください（やり直しても二重にはなりません。請求・実績・予算のある行は削除されていません）。',
      code: 'sync_failed',
      step,
      applied: { added, updated, removed },
    }, { status: 500 })
  }

  // 現在の見積項目
  const { data: estimateItems, error: estErr } = await supabase
    .from('estimate_items')
    .select('id, name, quantity, unit, cost_price, vendor_name, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')
  if (estErr || !Array.isArray(estimateItems)) return fail('read_estimates')

  // 現在の台帳項目（estimate_item_id ありのもの）
  const { data: ledgerItems, error: ledgerErr } = await supabase
    .from('cost_ledger_items')
    .select('id, estimate_item_id, name, quantity, unit, estimate_cost, vendor_name, sort_order, actual_cost, budget_cost, completion_cost')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .not('estimate_item_id', 'is', null)
  if (ledgerErr || !Array.isArray(ledgerItems)) return fail('read_ledger')

  const estMap  = new Map(estimateItems.map(e => [e.id as string, e]))
  const ledMap  = new Map(ledgerItems.map(l => [l.estimate_item_id as string, l]))
  const insertedIds = new Set<string>()
  const insertedEstimateIds: string[] = []

  // ── 追加 / 更新 ──────────────────────────────────────────
  for (const est of estimateItems) {
    const estimateCost = est.cost_price != null
      ? est.cost_price * (est.quantity ?? 1)
      : null

    const existing = ledMap.get(est.id as string)

    if (existing) {
      // 差分があれば更新（budget_cost / actual_cost / note は触らない）
      const changed =
        existing.name          !== est.name           ||
        existing.quantity      !== (est.quantity ?? 1) ||
        existing.unit          !== (est.unit ?? '式')  ||
        existing.estimate_cost !== estimateCost        ||
        existing.vendor_name   !== (est.vendor_name ?? null)

      if (changed) {
        const { error } = await supabase
          .from('cost_ledger_items')
          .update({
            name:          est.name,
            quantity:      est.quantity ?? 1,
            unit:          est.unit ?? '式',
            estimate_cost: estimateCost,
            vendor_name:   est.vendor_name ?? null,
            sort_order:    est.sort_order ?? 0,
          })
          .eq('id', existing.id)
          .is('deleted_at', null)
        if (error) return fail('update')
        updated++
      }
    } else {
      // 台帳に存在しない → 新規追加
      const { data: inserted, error } = await supabase
        .from('cost_ledger_items')
        .insert({
          project_id:       projectId,
          company_id:       companyId,
          estimate_item_id: est.id,
          name:             est.name,
          quantity:         est.quantity ?? 1,
          unit:             est.unit ?? '式',
          estimate_cost:    estimateCost,
          budget_cost:      null,
          actual_cost:      null,
          vendor_name:      est.vendor_name ?? null,
          sort_order:       est.sort_order ?? 0,
          source:           'from_estimate',
        })
        .select('id')
      if (error || !Array.isArray(inserted) || inserted.length !== 1) return fail('insert')
      insertedIds.add(inserted[0].id as string)
      insertedEstimateIds.push(est.id as string)
      added++
    }
  }

  // ── 同時に動いた同期が同じ見積行の項目を作っていたら、1 行に収束させる ──
  for (let i = 0; i < insertedEstimateIds.length; i += 100) {
    const { data: rows, error } = await supabase
      .from('cost_ledger_items')
      .select('id, estimate_item_id, created_at')
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .in('estimate_item_id', insertedEstimateIds.slice(i, i + 100))
    if (error || !Array.isArray(rows)) return fail('dedupe')
    const groups = new Map<string, Array<{ id: string; created_at: string }>>()
    for (const r of rows) {
      const list = groups.get(r.estimate_item_id as string) ?? []
      list.push({ id: r.id as string, created_at: r.created_at as string })
      groups.set(r.estimate_item_id as string, list)
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue
      // 残すのは最も古い行（同時刻なら id の小さい行）。どの同期から見ても同じ行になる
      const winner = [...list].sort((a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
      for (const row of list) {
        if (row.id === winner.id || !insertedIds.has(row.id)) continue
        const result = await softDeleteIfEmpty(supabase, row.id)
        if (result === 'error') return fail('dedupe')
        if (result === 'deleted') { deduplicated++; added-- }
      }
    }
  }

  // ── 見積から削除された行 ─────────────────────────────────
  const orphaned = ledgerItems.filter(led => !estMap.has(led.estimate_item_id as string))
  if (orphaned.length > 0) {
    const invoiceCounts = await countInvoicesByItem(supabase, orphaned.map(l => l.id as string))
    if (!invoiceCounts) return fail('count_invoices')

    for (const led of orphaned) {
      const reasons = protectionReasons(
        { actual_cost: led.actual_cost, budget_cost: led.budget_cost, completion_cost: led.completion_cost },
        invoiceCounts.get(led.id as string) ?? 0,
      )
      if (reasons.length > 0) {
        kept.push({ id: led.id as string, name: led.name as string, reasons })
        continue
      }
      // 確かめた後に請求書・実績・予算が入った行は、条件付き UPDATE が 0 行になって残る
      const result = await softDeleteIfEmpty(supabase, led.id as string)
      if (result === 'error') return fail('remove')
      if (result === 'deleted') removed++
      else kept.push({ id: led.id as string, name: led.name as string, reasons: [] })
    }
  }

  return NextResponse.json({ added, updated, removed, kept, deduplicated })
}
