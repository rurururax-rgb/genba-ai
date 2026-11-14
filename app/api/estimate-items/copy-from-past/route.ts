/**
 * POST /api/estimate-items/copy-from-past
 *
 * 自社の過去案件の見積明細を、開いている案件の工種の末尾へコピーする。
 * body: {
 *   project_id: コピー先の案件,
 *   group_id:   コピー先の工種（null = 未分類「その他」）,
 *   items: [{ source_item_id, fingerprint }],   // 利用者が選んだ順。fingerprint は検索結果の copy_preview.fingerprint
 *   include_memo?: boolean, include_internal_memo?: boolean   // 省略時はコピーしない
 * }
 *
 * - getServerClient()（RLS 有効）だけを使う。admin.ts は使わない
 * - 登録内容（売価・原価・会社・並び順など）はクライアントから受け取らない。コピー元はサーバーで読み直す
 * - コピー元は自社・未削除の明細・未削除の案件・明細行（row_type が NULL / item）・コピー先以外の案件に限る。
 *   1 件でも該当しなければ 1 行も登録せず 404（他社・削除済み・存在しないは区別しない）
 * - プレビュー後にコピー元の明細やコピー先の掛け率が変わっていたら（fingerprint 不一致）、1 行も登録せず 409。
 *   最新の copy_preview を返すので、利用者が確認し直してから送り直す
 * - コピー先の案件・工種は lib/estimate/ownership.ts で確かめる
 * - 工種の末尾に、指定された順で追加する。既存行の並べ替え・工種の作成はしない
 * - 複数行は 1 回の INSERT で登録する（全件成功か全件失敗）
 * - 行の組み立て・売価は lib/estimate/past-copy.ts（buildPastItemCopy）。retail_price・line_event_id・
 *   コピー元の工種・個別掛け率は引き継がない
 * - DB のエラー文は返さない（サーバーログのみ）
 *
 * DB を変えずには保証できないこと（PR に記載）:
 * - 同じリクエストの再送・連打による二重登録（冪等キーを保存する列が無い）
 * - 同時に末尾へ追加したときの sort_order の重複（並び順が不定になる）
 * - fingerprint の確認と INSERT の間（同じリクエスト内の数ミリ秒）のコピー元の変更
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { checkOptionalGroup, isActiveProject } from '@/lib/estimate/ownership'
import {
  buildPastItemCopy,
  parsePastCopyRequest,
  pastItemFingerprint,
  planAppendSortOrders,
  planPastItemPrice,
  type PastItemSource,
} from '@/lib/estimate/past-copy'
import type { SellingPriceMode } from '@/lib/estimate/pricing'

/** estimate_items → projects は外部キーが 2 本あるため、単独の外部キー名をヒントにする（search-past と同じ） */
const PROJECT_EMBED = 'projects!estimate_items_project_id_fkey!inner ( id, company_id, deleted_at )'
const SOURCE_COLUMNS = 'id, project_id, name, quantity, unit, cost_price, selling_price, selling_price_mode, vendor_name, category, row_type'

type SourceRow = PastItemSource & { id: string; project_id: string }

function dbError(tag: string, error: { code?: string | null; message?: string }): NextResponse {
  console.error(`[estimate-items/copy-from-past ${tag}]`, error.code, error.message)
  const code = error.code ?? ''
  if (code === '42703') {
    return NextResponse.json({ error: 'データベースの更新が未適用のためコピーできません。管理者に連絡してください。' }, { status: 500 })
  }
  if (code === '23503') return NextResponse.json({ error: 'コピー先の案件または工種が見つかりません。画面を再読み込みしてください。' }, { status: 404 })
  if (code.startsWith('22') || code === '23502' || code === '23514') {
    return NextResponse.json({ error: 'コピーできない明細が含まれています' }, { status: 400 })
  }
  return NextResponse.json({ error: 'コピーできませんでした。もう一度お試しください。' }, { status: 500 })
}

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
  const companyId = membership.company_id as string

  const parsed = parsePastCopyRequest(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { projectId, groupId, items, includeMemo, includeInternalMemo } = parsed.value

  // ① コピー先の案件・工種（存在しない・他社・削除済みは区別せず 404）
  if (!(await isActiveProject(supabase, projectId, companyId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const groupCheck = await checkOptionalGroup(supabase, groupId, projectId, companyId)
  if (groupCheck === 'invalid') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (groupCheck === 'not_found') return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  const { data: target, error: targetErr } = await supabase
    .from('projects')
    .select('markup_rate')
    .eq('id', projectId)
    .single()
  if (targetErr) return dbError('target', targetErr)
  const markupRate = (target as { markup_rate?: number | null } | null)?.markup_rate

  // ② コピー元を読み直す（検索 API と同じ条件。クライアントから受け取った金額は使わない）
  const ids = items.map(i => i.sourceItemId)
  const columns = [SOURCE_COLUMNS, includeMemo ? 'memo' : null, includeInternalMemo ? 'internal_memo' : null, PROJECT_EMBED]
    .filter(Boolean).join(', ')
  const { data: rawSources, error: sourcesErr } = await supabase
    .from('estimate_items')
    .select(columns)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .eq('projects.company_id', companyId)
    .is('projects.deleted_at', null)
    .or('row_type.is.null,row_type.eq.item')
    .neq('project_id', projectId)
    .in('id', ids)
  if (sourcesErr) return dbError('sources', sourcesErr)

  const sourceMap = new Map(((rawSources ?? []) as unknown as SourceRow[]).map(s => [s.id, s]))
  const missing = ids.filter(id => !sourceMap.has(id))
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'コピーできない明細が含まれています。検索し直してください。', missing_source_item_ids: missing },
      { status: 404 },
    )
  }

  // ③ プレビュー後の変更を確かめる（1 件でも違えば登録しない）
  const changed = items.flatMap(({ sourceItemId, fingerprint }) => {
    const s = sourceMap.get(sourceItemId)!
    const current = pastItemFingerprint(s, markupRate)
    if (current === fingerprint) return []
    return [{
      source_item_id: sourceItemId,
      copy_preview: { ...planPastItemPrice(s, markupRate), fingerprint: current },
    }]
  })
  if (changed.length > 0) {
    return NextResponse.json(
      { error: '確認後に明細の内容または案件の掛け率が変わりました。金額を確認してからもう一度コピーしてください。', changed },
      { status: 409 },
    )
  }

  // ④ 工種の末尾の並び順（既存行は動かさない）
  let maxQ = supabase
    .from('estimate_items')
    .select('sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  maxQ = groupId ? maxQ.eq('group_id', groupId) : maxQ.is('group_id', null)
  const { data: maxRows, error: maxErr } = await maxQ.order('sort_order', { ascending: false }).limit(1)
  if (maxErr) return dbError('sort_order', maxErr)
  const currentMax = (maxRows as Array<{ sort_order: number | null }> | null)?.[0]?.sort_order ?? null
  const orders = planAppendSortOrders(currentMax, items.length)
  if (!orders) {
    return NextResponse.json({ error: 'この工種の並び順に空きがありません。行を並べ替えてからもう一度お試しください。' }, { status: 409 })
  }

  // ⑤ 利用者が指定した順で行を組み立て、1 回の INSERT で登録する
  const built = items.map(({ sourceItemId }, idx) => {
    const s = sourceMap.get(sourceItemId)!
    const source: PastItemSource = {
      ...s,
      selling_price_mode: (s.selling_price_mode === 'manual' ? 'manual' : 'auto') as SellingPriceMode,
      memo: includeMemo ? s.memo ?? null : null,
      internal_memo: includeInternalMemo ? s.internal_memo ?? null : null,
    }
    const { row, price } = buildPastItemCopy(
      source,
      { projectId, companyId, groupId, sortOrder: orders[idx], projectMarkupRate: markupRate },
      { includeMemo, includeInternalMemo },
    )
    return { sourceItemId, row, price }
  })

  const { data: inserted, error: insertErr } = await supabase
    .from('estimate_items')
    .insert(built.map(b => b.row))
    .select('id, name, quantity, unit, cost_price, selling_price, selling_price_mode, amount, group_id, sort_order, source, row_type')
  if (insertErr) return dbError('insert', insertErr)

  // 返り値の順に頼らず、この登録で一意な sort_order でコピー元と対応付ける
  const bySort = new Map(((inserted ?? []) as Array<Record<string, unknown> & { sort_order: number }>).map(r => [r.sort_order, r]))
  return NextResponse.json({
    inserted_count: inserted?.length ?? 0,
    items: built.map(b => ({
      source_item_id: b.sourceItemId,
      price_basis:    b.price.basis,
      ...(bySort.get(b.row.sort_order) ?? {}),
    })),
  }, { status: 201 })
}
