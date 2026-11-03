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
//   各 DB 操作のエラーと、更新・追加した行数を必ず確かめる。
//     ・エラー → その場で止めて 500（code: sync_failed・どの段階か・そこまでの件数）
//     ・更新の対象行が同時に削除された（0 行） → その場で止めて 409（code: sync_conflict）
//   同期は何度やり直しても同じ結果に収束する（追加済みの行は既存行として扱い、削除済みの行は対象外）ので、
//   途中で止まっても「もう一度同期」で残りが反映される。保護対象の行は途中で止まっても消えない。
//
// 同じ見積行を指す未削除の台帳項目が複数あるとき（同期が同時に動いた・以前の不具合で残った）:
//   毎回の同期の最初と、自分が追加した直後に、次の規則で 1 行に揃える（resolveDuplicates）。
//     ・残す行: 保護対象（請求書・実績・予算あり）を優先し、次に作成時刻が古い行、次に id が小さい行
//     ・それ以外の行: 値が空で請求書もない行だけを論理削除する（どの同期が作った行でも同じ規則）
//     ・保護対象が 2 行以上ある: 自動では揃えない（どちらも残す）。duplicates として返し、人が確認する
//   作成時刻と確定（コミット）の順が違っても、2 つの同期のうち後で重複を確かめたほうは両方の行を見るので、
//   同じ規則で 1 行に揃う。揃えきれなかった重複（保護対象どうし・確かめた後に値が入った）は次の同期で再び扱う。
//   DB 制約がないため「同時に 2 行が存在する短い時間」は無くせない。DB 側の対策は PR 3（一意インデックス・1 トランザクション化）

type SyncStep = 'read_estimates' | 'read_ledger' | 'dedupe' | 'update' | 'insert' | 'count_invoices' | 'remove'

type KeptItem = { id: string; name: string; reasons: ProtectionReason[] }

type LedgerRow = {
  id: string
  estimate_item_id: string
  name: string
  quantity: number | null
  unit: string | null
  estimate_cost: number | null
  vendor_name: string | null
  sort_order: number | null
  actual_cost: number | null
  budget_cost: number | null
  completion_cost: number | null
  created_at: string
}

const LEDGER_COLUMNS =
  'id, estimate_item_id, name, quantity, unit, estimate_cost, vendor_name, sort_order, actual_cost, budget_cost, completion_cost, created_at'

type SupabaseLike = Awaited<ReturnType<typeof getServerClient>>

/**
 * 同じ見積行を指す未削除の台帳項目を 1 行に揃える。
 * rows は DB で created_at, id の順に並べたもの（作成時刻はマイクロ秒まであるので JS で比べ直さない）。
 * 戻り値: 見積行ごとに残った行・論理削除した行の id・揃えきれなかった見積行。読み取り・書き込みに失敗したら null
 */
async function resolveDuplicates(supabase: SupabaseLike, rows: LedgerRow[]): Promise<{
  live: Map<string, LedgerRow[]>
  deletedIds: Set<string>
  unresolved: Array<{ estimate_item_id: string; ids: string[] }>
} | null> {
  const groups = new Map<string, LedgerRow[]>()
  for (const r of rows) groups.set(r.estimate_item_id, [...(groups.get(r.estimate_item_id) ?? []), r])

  const dupRows = [...groups.values()].filter(g => g.length > 1).flat()
  const deletedIds = new Set<string>()
  const unresolved: Array<{ estimate_item_id: string; ids: string[] }> = []
  if (dupRows.length === 0) return { live: groups, deletedIds, unresolved }

  const invoiceCounts = await countInvoicesByItem(supabase, dupRows.map(r => r.id))
  if (!invoiceCounts) return null

  for (const [estimateId, group] of groups) {
    if (group.length < 2) continue
    const isProtected = (r: LedgerRow) => protectionReasons(r, invoiceCounts.get(r.id) ?? 0).length > 0
    // 保護対象を優先し、同じなら DB の並び（作成時刻の古い順・id 順）。Array.prototype.sort は安定ソート
    const sorted = [...group].sort((a, b) => Number(isProtected(b)) - Number(isProtected(a)))
    const remaining = [sorted[0]]
    for (const r of sorted.slice(1)) {
      if (isProtected(r)) { remaining.push(r); continue }
      const result = await softDeleteIfEmpty(supabase, r.id)
      if (result === 'error') return null
      if (result === 'deleted') deletedIds.add(r.id)
      else remaining.push(r) // 確かめた直後に値が入った・既に削除済み（残っていれば次の同期で再び扱う）
    }
    groups.set(estimateId, remaining)
    if (remaining.length > 1) unresolved.push({ estimate_item_id: estimateId, ids: remaining.map(r => r.id) })
  }
  return { live: groups, deletedIds, unresolved }
}

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
  const conflict = (step: SyncStep) => {
    console.error('[cost-ledger sync] conflict at', step)
    return NextResponse.json({
      error: '同期の途中で、ほかの操作により原価台帳が変更されました。画面を読み込み直してから、もう一度「見積と同期」を押してください。',
      code: 'sync_conflict',
      step,
      applied: { added, updated, removed },
    }, { status: 409 })
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
  const { data: ledgerData, error: ledgerErr } = await supabase
    .from('cost_ledger_items')
    .select(LEDGER_COLUMNS)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .not('estimate_item_id', 'is', null)
    .order('created_at')
    .order('id')
  if (ledgerErr || !Array.isArray(ledgerData)) return fail('read_ledger')

  // 以前から残っている重複を先に揃える（前回の同時実行・以前の不具合で残った分）
  const before = await resolveDuplicates(supabase, ledgerData as LedgerRow[])
  if (!before) return fail('dedupe')
  deduplicated += before.deletedIds.size
  const ledgerByEstimate = before.live
  const unresolved = new Map(before.unresolved.map(u => [u.estimate_item_id, u.ids]))

  const estMap = new Map(estimateItems.map(e => [e.id as string, e]))
  const insertedIds = new Set<string>()
  const insertedEstimateIds: string[] = []

  // ── 追加 / 更新 ──────────────────────────────────────────
  for (const est of estimateItems) {
    const estimateCost = est.cost_price != null
      ? est.cost_price * (est.quantity ?? 1)
      : null

    const existingRows = ledgerByEstimate.get(est.id as string) ?? []

    if (existingRows.length > 0) {
      // 差分があれば更新（budget_cost / actual_cost / note は触らない）。揃えきれなかった重複はどの行も同じ内容にする
      for (const existing of existingRows) {
        const changed =
          existing.name          !== est.name           ||
          existing.quantity      !== (est.quantity ?? 1) ||
          existing.unit          !== (est.unit ?? '式')  ||
          existing.estimate_cost !== estimateCost        ||
          existing.vendor_name   !== (est.vendor_name ?? null)
        if (!changed) continue

        const { data: rows, error } = await supabase
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
          .select('id')
        if (error || !Array.isArray(rows)) return fail('update')
        // 読んだ後に削除された（手動の削除・同時の同期）。更新したことにしない
        if (rows.length !== 1) return conflict('update')
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

  // ── 自分が追加した見積行について、同時に動いた同期の行と 1 行に揃える ──
  for (let i = 0; i < insertedEstimateIds.length; i += 100) {
    const { data: rows, error } = await supabase
      .from('cost_ledger_items')
      .select(LEDGER_COLUMNS)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .in('estimate_item_id', insertedEstimateIds.slice(i, i + 100))
      .order('created_at')
      .order('id')
    if (error || !Array.isArray(rows)) return fail('dedupe')
    const after = await resolveDuplicates(supabase, rows as LedgerRow[])
    if (!after) return fail('dedupe')
    deduplicated += after.deletedIds.size
    for (const id of after.deletedIds) if (insertedIds.has(id)) added--
    for (const u of after.unresolved) unresolved.set(u.estimate_item_id, u.ids)
  }

  // ── 見積から削除された行 ─────────────────────────────────
  const orphaned = [...ledgerByEstimate.entries()]
    .filter(([estimateId]) => !estMap.has(estimateId))
    .flatMap(([, rows]) => rows)
  if (orphaned.length > 0) {
    const invoiceCounts = await countInvoicesByItem(supabase, orphaned.map(l => l.id))
    if (!invoiceCounts) return fail('count_invoices')

    for (const led of orphaned) {
      const reasons = protectionReasons(led, invoiceCounts.get(led.id) ?? 0)
      if (reasons.length > 0) {
        kept.push({ id: led.id, name: led.name, reasons })
        continue
      }
      // 確かめた後に請求書・実績・予算が入った行は、条件付き UPDATE が 0 行になって残る
      const result = await softDeleteIfEmpty(supabase, led.id)
      if (result === 'error') return fail('remove')
      if (result === 'deleted') removed++
      else kept.push({ id: led.id, name: led.name, reasons: [] })
    }
    // 見積から削除された見積行の重複は、削除・保護の判断で扱い終えた
    for (const [estimateId] of ledgerByEstimate) if (!estMap.has(estimateId)) unresolved.delete(estimateId)
  }

  const duplicates = [...unresolved.entries()].map(([estimate_item_id, ids]) => ({ estimate_item_id, ids }))
  return NextResponse.json({ added, updated, removed, kept, deduplicated, duplicates })
}
