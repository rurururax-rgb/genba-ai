/**
 * POST /api/estimate-items/add-from-master
 *
 * 自社の資材マスターの商品を 1 件、開いている案件の工種の末尾へ見積明細として追加する。
 * body: {
 *   project_id, group_id（null = 未分類「その他」）,
 *   master_item_id, fingerprint（検索結果の preview.fingerprint）,
 *   quantity, cost_price, selling_price_mode（'auto' | 'manual'）, selling_price（manual のときだけ）
 * }
 *
 * - getServerClient()（RLS 有効）だけを使う。admin.ts は使わない
 * - 追加先の案件・工種は lib/estimate/ownership.ts で確かめる（存在しない・他社・削除済みは区別せず 404）
 * - マスターの商品は自社のものだけを読み直す（RLS に加えて company_id でも絞る）。他社・存在しないは区別せず 404
 * - 品名・単位・分類はマスターから、会社・並び順・source はサーバーが決める（クライアントから受け取らない）
 * - auto の売価は原価 × 案件の標準掛け率でサーバーが計算する（lib/estimate/master-copy.ts）
 * - 画面に出した後にマスターの内容か案件の掛け率が変わっていたら（fingerprint 不一致）、登録せず 409。
 *   いまの商品と初期値（preview）を返すので、利用者が確認し直してから送り直す
 * - 工種の末尾に追加する。既存行の並べ替え・工種の作成・資材マスターの更新はしない
 * - DB のエラー文は返さない（サーバーログのみ）
 *
 * DB を変えずには保証できないこと（PR に記載。copy-from-past と同じ）:
 * - 同じリクエストの再送による二重登録（冪等キーを保存する列が無い）。画面は自動で再送せず、
 *   結果が分からないときは見積明細を読み込み直して確かめるよう案内する
 * - 同時に末尾へ追加したときの sort_order の重複（並び順が不定になる）
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { checkOptionalGroup, isActiveProject } from '@/lib/estimate/ownership'
import { planAppendSortOrders } from '@/lib/estimate/past-copy'
import {
  buildMasterItemRow,
  masterItemFingerprint,
  parseMasterAddRequest,
  planMasterItemPrice,
  type MasterItemSource,
} from '@/lib/estimate/master-copy'

function dbError(tag: string, error: { code?: string | null; message?: string }): NextResponse {
  console.error(`[estimate-items/add-from-master ${tag}]`, error.code, error.message)
  const code = error.code ?? ''
  if (code === '23503') return NextResponse.json({ error: '追加先の案件または工種が見つかりません。画面を再読み込みしてください。' }, { status: 404 })
  if (code.startsWith('22') || code === '23502' || code === '23514') {
    return NextResponse.json({ error: '追加できない値が含まれています' }, { status: 400 })
  }
  return NextResponse.json({ error: '追加できませんでした。もう一度お試しください。' }, { status: 500 })
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

  const parsed = parseMasterAddRequest(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const input = parsed.value

  // ① 追加先の案件・工種
  if (!(await isActiveProject(supabase, input.projectId, companyId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const groupCheck = await checkOptionalGroup(supabase, input.groupId, input.projectId, companyId)
  if (groupCheck === 'invalid') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (groupCheck === 'not_found') return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .select('markup_rate')
    .eq('id', input.projectId)
    .single()
  if (projectErr) return dbError('project', projectErr)
  const markupRate = (project as { markup_rate?: number | null } | null)?.markup_rate

  // ② マスターの商品を読み直す（自社のものだけ）
  const { data: masterRow, error: masterErr } = await supabase
    .from('company_estimate_items')
    .select('id, name, spec, unit, cost_price, selling_price, category')
    .eq('id', input.masterItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (masterErr) return dbError('master', masterErr)
  if (!masterRow) {
    return NextResponse.json({ error: 'この資材は資材マスターから削除されたか、見つかりません。検索し直してください。', reason: 'master_not_found' }, { status: 404 })
  }
  const master = masterRow as MasterItemSource & { id: string }

  // ③ 画面に出した後の変更を確かめる
  const current = masterItemFingerprint(master, markupRate)
  if (current !== input.fingerprint) {
    return NextResponse.json({
      error: '資材マスターの内容か、案件の掛け率が変わりました。内容を確認してからもう一度追加してください。',
      item: {
        id: master.id, name: master.name, spec: master.spec, unit: master.unit,
        cost_price: master.cost_price, selling_price: master.selling_price, category: master.category,
        preview: { ...planMasterItemPrice(master, markupRate), fingerprint: current },
      },
    }, { status: 409 })
  }

  // ④ 工種の末尾の並び順（既存行は動かさない）
  let maxQ = supabase
    .from('estimate_items')
    .select('sort_order')
    .eq('project_id', input.projectId)
    .is('deleted_at', null)
  maxQ = input.groupId ? maxQ.eq('group_id', input.groupId) : maxQ.is('group_id', null)
  const { data: maxRows, error: maxErr } = await maxQ.order('sort_order', { ascending: false }).limit(1)
  if (maxErr) return dbError('sort_order', maxErr)
  const currentMax = (maxRows as Array<{ sort_order: number | null }> | null)?.[0]?.sort_order ?? null
  const orders = planAppendSortOrders(currentMax, 1)
  if (!orders) {
    return NextResponse.json({ error: 'この工種の並び順に空きがありません。行を並べ替えてからもう一度お試しください。' }, { status: 409 })
  }

  // ⑤ 登録
  const row = buildMasterItemRow(master, input, {
    projectId: input.projectId, companyId, groupId: input.groupId, sortOrder: orders[0], projectMarkupRate: markupRate,
  })
  const { data: inserted, error: insertErr } = await supabase
    .from('estimate_items')
    .insert(row)
    .select('id, name, quantity, unit, cost_price, selling_price, selling_price_mode, amount, group_id, sort_order, source, row_type')
    .single()
  if (insertErr) return dbError('insert', insertErr)

  return NextResponse.json({ item: inserted }, { status: 201 })
}
