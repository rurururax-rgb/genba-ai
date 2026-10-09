import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import {
  findSimilarInvoices, isUuid, parseInvoiceRequest,
  type ExistingInvoice, type InvoiceRequest,
} from '@/lib/cost-ledger/invoice-dedupe'

type ServerClient = Awaited<ReturnType<typeof getServerClient>>

type Params = { params: Promise<{ id: string }> }

// ─────────────────────────────────────────────
// GET /api/cost-ledger/[id]/invoices
// 指定アイテムの内訳一覧を返す
// ─────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('cost_ledger_invoices')
    .select(INVOICE_COLUMNS)
    .eq('cost_ledger_item_id', id)
    .order('created_at')

  if (error) return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// ─────────────────────────────────────────────
// POST /api/cost-ledger/[id]/invoices
// 内訳を1件追加し、親の actual_cost を再集計する
//
// 二重登録の防止（DB 制約は migration 20261010000001）:
//   - idempotency_key … 同じ登録操作の再送（連打・通信エラー後の再試行）は1行だけ。
//       既に保存済みなら新しい行も actual_cost の再集計もせず、保存済みの結果を返す（replayed）
//   - document_sha256 … 同じ案件に同じ画像の OCR 登録は1件まで（別の台帳項目でも拒否）
//   - OCR 登録で請求書番号・業者名・金額・請求日が以前の請求書と似ている場合は確認を求める
//       （confirm_similar: true で登録できる。ハッシュの一意制約はすり抜けられない）
// project_id は本文から受け取らず、親の台帳項目から取得する。
// 応答に DB のエラー文は含めない。
// ─────────────────────────────────────────────

const INVOICE_COLUMNS =
  'id, cost_ledger_item_id, amount, invoice_date, payment_date, note, source, vendor_name, invoice_number, created_at'

const IN_CHUNK = 100

type ExistingRow = {
  id: string
  cost_ledger_item_id: string
  amount: number
  source: string | null
  document_sha256: string | null
}

function sameOperation(row: ExistingRow, itemId: string, req: InvoiceRequest) {
  return row.cost_ledger_item_id === itemId
    && Number(row.amount) === req.amount
    && (row.source ?? 'manual') === req.source
    && (row.document_sha256 ?? null) === req.document_sha256
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: itemId } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── 入力検証（ここまで DB を読まない・書かない） ──
  if (!isUuid(itemId)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const parsed = parseInvoiceRequest(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const body = parsed.value

  // ── 対象の確認（RLS: 自社の台帳項目・案件だけが見える） ──
  const notFound = () => NextResponse.json({ error: 'Item not found or no access' }, { status: 404 })
  const { data: item } = await supabase
    .from('cost_ledger_items')
    .select('id, project_id, actual_cost')
    .eq('id', itemId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!item) return notFound()
  const projectId = item.project_id as string

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!project) return notFound()

  // ── 同じ登録操作の再送 ──
  const findByKey = async (key: string) => {
    const { data } = await supabase
      .from('cost_ledger_invoices')
      .select(`${INVOICE_COLUMNS}, document_sha256`)
      .eq('idempotency_key', key)
      .maybeSingle()
    return data as (ExistingRow & Record<string, unknown>) | null
  }
  const replay = (row: ExistingRow & Record<string, unknown>) => {
    if (!sameOperation(row, itemId, body)) {
      return NextResponse.json(
        { error: '同じ登録操作で別の内容が送られました。画面を再読み込みしてください。', code: 'idempotency_conflict' },
        { status: 409 },
      )
    }
    // 既に保存済み。新しい行は作らず、actual_cost も再集計しない（DB の現在値を返す）
    const invoice = Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'document_sha256'))
    return NextResponse.json({ invoice, newActualCost: item.actual_cost ?? null, replayed: true, synced: true })
  }

  if (body.idempotency_key) {
    const existing = await findByKey(body.idempotency_key)
    if (existing) return replay(existing)
  }

  // ── 同じ案件に同じ画像 ──
  const findByDocument = async (sha: string) => {
    const { data } = await supabase
      .from('cost_ledger_invoices')
      .select('id, cost_ledger_item_id, amount, invoice_date, created_at')
      .eq('project_id', projectId)
      .eq('source', 'ocr')
      .eq('document_sha256', sha)
      .maybeSingle()
    return data as { id: string; cost_ledger_item_id: string; amount: number; invoice_date: string | null; created_at: string } | null
  }
  const duplicateDocument = async (row: { cost_ledger_item_id: string; amount: number; invoice_date: string | null; created_at: string }) => {
    const { data: target } = await supabase
      .from('cost_ledger_items').select('name').eq('id', row.cost_ledger_item_id).maybeSingle()
    return NextResponse.json({
      error: 'この請求書は登録済みです',
      code: 'duplicate_document',
      existing: {
        cost_ledger_item_id: row.cost_ledger_item_id,
        item_name: (target?.name as string | undefined) ?? null,
        amount: row.amount,
        invoice_date: row.invoice_date,
        created_at: row.created_at,
      },
    }, { status: 409 })
  }

  if (body.source === 'ocr' && body.document_sha256) {
    const dup = await findByDocument(body.document_sha256)
    if (dup) return duplicateDocument(dup)

    // ── 以前の請求書と似ている（確認後は登録できる） ──
    if (!body.confirm_similar) {
      const similar = await findSimilarInProject(supabase, projectId, body)
      if (similar === null) return NextResponse.json({ error: '登録できませんでした。もう一度お試しください。' }, { status: 500 })
      if (similar.length > 0) {
        return NextResponse.json({ error: '以前の請求書と似ています', code: 'similar_invoice', similar }, { status: 409 })
      }
    }
  }

  // ── 書き込み ──
  const { data: invoice, error } = await supabase
    .from('cost_ledger_invoices')
    .insert({
      cost_ledger_item_id: itemId,
      project_id:      projectId,
      amount:          body.amount,
      invoice_date:    body.invoice_date,
      payment_date:    body.payment_date,
      note:            body.note,
      source:          body.source,
      vendor_name:     body.vendor_name,
      invoice_number:  body.invoice_number,
      document_sha256: body.document_sha256,
      idempotency_key: body.idempotency_key,
    })
    .select(INVOICE_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      // 同時送信などで事前確認をすり抜けた一意制約違反。見える範囲で既存行を探して分類する
      if (body.idempotency_key) {
        const existing = await findByKey(body.idempotency_key)
        if (existing) return replay(existing)
      }
      if (body.source === 'ocr' && body.document_sha256) {
        const dup = await findByDocument(body.document_sha256)
        if (dup) return duplicateDocument(dup)
      }
      // 既存行が見えない（他社のキーと衝突した等）。中身は返さない
      return NextResponse.json({ error: '登録できませんでした。画面を再読み込みしてください。', code: 'conflict' }, { status: 409 })
    }
    console.error('[cost-ledger invoices POST]', error.code)
    if (error.code === '23514') return NextResponse.json({ error: '入力内容を確認してください' }, { status: 400 })
    return NextResponse.json({ error: '登録できませんでした。もう一度お試しください。' }, { status: 500 })
  }

  // 親の actual_cost を再集計。失敗しても請求は保存済みなので「登録失敗」にはしない
  const sync = await recalcActualCost(supabase, itemId)
  return NextResponse.json({
    invoice,
    newActualCost: sync.ok ? sync.total : null,
    replayed: false,
    synced: sync.ok,
  })
}

/** 同じ案件（削除されていない台帳項目）の請求書から、似ているものを探す。読み取り失敗は null */
async function findSimilarInProject(supabase: ServerClient, projectId: string, body: InvoiceRequest) {
  const { data: items, error: itemErr } = await supabase
    .from('cost_ledger_items')
    .select('id, name')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (itemErr) return null
  const names = new Map((items ?? []).map(i => [i.id as string, i.name as string]))
  const ids = [...names.keys()]

  const existing: ExistingInvoice[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('cost_ledger_invoices')
      .select('id, cost_ledger_item_id, amount, invoice_date, note, vendor_name, invoice_number, created_at')
      .in('cost_ledger_item_id', ids.slice(i, i + IN_CHUNK))
    if (error) return null
    existing.push(...((data ?? []) as ExistingInvoice[]))
  }

  return findSimilarInvoices(body, existing).map(s => ({
    id: s.id,
    cost_ledger_item_id: s.cost_ledger_item_id,
    item_name: names.get(s.cost_ledger_item_id) ?? null,
    amount: s.amount,
    invoice_date: s.invoice_date,
    vendor_name: s.vendor_name,
    invoice_number: s.invoice_number,
    created_at: s.created_at,
    reason: s.reason,
  }))
}

/** 内訳合計で actual_cost を更新する。読み取り・更新のどちらかが失敗したら ok: false */
async function recalcActualCost(supabase: ServerClient, itemId: string): Promise<{ ok: true; total: number } | { ok: false }> {
  const { data: rows, error } = await supabase
    .from('cost_ledger_invoices')
    .select('amount')
    .eq('cost_ledger_item_id', itemId)
  if (error) return { ok: false }
  const total = (rows ?? []).reduce((s: number, r: { amount: number | null }) => s + Number(r.amount ?? 0), 0)
  const { data: updated, error: upErr } = await supabase
    .from('cost_ledger_items')
    .update({ actual_cost: total, updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .select('id')
  if (upErr || updated?.length !== 1) return { ok: false }
  return { ok: true, total }
}

// ─────────────────────────────────────────────
// ヘルパー: 内訳合計を集計して actual_cost を更新
// ─────────────────────────────────────────────

export async function syncActualCost(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  itemId: string,
): Promise<number> {
  const { data: rows } = await supabase
    .from('cost_ledger_invoices')
    .select('amount')
    .eq('cost_ledger_item_id', itemId)

  const total = (rows ?? []).reduce((s: number, r: { amount: number }) => s + (r.amount ?? 0), 0)

  await supabase
    .from('cost_ledger_items')
    .update({ actual_cost: total, updated_at: new Date().toISOString() })
    .eq('id', itemId)

  return total
}
