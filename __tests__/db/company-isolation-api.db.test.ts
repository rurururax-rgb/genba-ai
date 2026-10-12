/**
 * KI-002 PR-1: 他社の案件 ID を使った書き込みを API で拒否し、朝のブリーフィングから他社の案件名を出さないことの DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用し、
 *   実際の API ルート・サービスを「ログイン済みユーザー（authenticated + RLS）」または「admin（RLS を通らない）」として動かす。
 *   本番・Preview の DB には接続しない。
 *
 * 前提: RLS は行の company_id しか見ないため、DB 側の制約（PR-3: 20261014000001）が無い DB では
 *   company_id = 自社・project_id = 他社の案件 という行を直接作れる。API 側の確認はそれとは別に守りとして残す。
 *   ブリーフィングの検証では、制約導入前に紛れ込んだ行を想定し、外部キーを一時的に無効化して作る。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { pgSupabase } from './helpers/pg-supabase'

let server: LocalPostgres
let admin: Client
let currentUser: string | undefined

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => pgSupabase(admin, currentUser),
}))

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const PROJECT_A = randomUUID()
const PROJECT_A_EMPTY = randomUUID()   // 見積項目なし・原価台帳なし（init / sync の正常系用）
const PROJECT_A_INIT = randomUUID()    // 見積項目あり・原価台帳なし（init の正常系用）
const PROJECT_A_DELETED = randomUUID()
const PROJECT_B = randomUUID()
const PROJECT_MISSING = randomUUID()
const EVENT_A = randomUUID()
const EVENT_B = randomUUID()
const SECRET_B = 'B社の秘密案件'

const today = new Date().toISOString().slice(0, 10)
const longAgo = '2026-01-05'

/** ログイン済みユーザーとして（RLS 有効）SQL を直接実行する */
async function asUser(user: string, sql: string, params: unknown[] = []) {
  await admin.query('BEGIN')
  try {
    await admin.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user])
    await admin.query('SET LOCAL ROLE authenticated')
    const r = await admin.query(sql, params)
    await admin.query('COMMIT')
    return r
  } catch (e) {
    await admin.query('ROLLBACK')
    throw e
  }
}

async function count(table: string): Promise<number> {
  return Number((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
}

function jsonReq(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function noteReq(projectId: string | null) {
  const fd = new FormData()
  fd.append('note_type', 'text')
  fd.append('content', '追記')
  if (projectId) fd.append('project_id', projectId)
  return new NextRequest('http://localhost/api/line-events/x/notes', { method: 'POST', body: fd })
}

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await admin.query(
    `INSERT INTO projects (id, company_id, name, status, deleted_at) VALUES
       ($1, $5, 'A社の案件', 'collecting', NULL),
       ($2, $5, 'A社の空の案件', 'collecting', NULL),
       ($3, $5, 'A社の削除済み案件', 'collecting', now()),
       ($4, $6, $7, 'collecting', NULL),
       ($8, $5, 'A社の台帳初期化前の案件', 'collecting', NULL)`,
    [PROJECT_A, PROJECT_A_EMPTY, PROJECT_A_DELETED, PROJECT_B, COMPANY_A, COMPANY_B, SECRET_B, PROJECT_A_INIT],
  )
  await admin.query(
    `INSERT INTO line_events (id, company_id, line_user_id, line_event_id, event_type, raw_content) VALUES
       ($1, $3, 'U-A', 'ev-a', 'text', 'A'), ($2, $4, 'U-B', 'ev-b', 'text', 'B')`,
    [EVENT_A, EVENT_B, COMPANY_A, COMPANY_B],
  )
  await admin.query(
    `INSERT INTO estimate_items (company_id, project_id, name, quantity, unit, cost_price, selling_price)
     VALUES ($1, $2, '解体工事', 1, '式', 100000, 150000), ($1, $3, '内装工事', 1, '式', 200000, 300000)`,
    [COMPANY_A, PROJECT_A, PROJECT_A_INIT],
  )
}, 180_000)

afterAll(async () => {
  await server?.stop()
})

// ─────────────────────────────────────────────────────────────────────────────
// API: 案件 ID の所属確認
// ─────────────────────────────────────────────────────────────────────────────

type Case = {
  name: string
  table: string
  call: (projectId: string) => Promise<Response>
  okStatus: number
  okProject?: string
}

const cases: Case[] = [
  {
    name: 'POST /api/cost-ledger', table: 'cost_ledger_items', okStatus: 200,
    call: async p => (await import('@/app/api/cost-ledger/route')).POST(jsonReq('/api/cost-ledger', { project_id: p })),
  },
  {
    name: 'POST /api/cost-ledger/init', table: 'cost_ledger_items', okStatus: 201, okProject: PROJECT_A_INIT,
    call: async p => (await import('@/app/api/cost-ledger/init/route')).POST(jsonReq('/api/cost-ledger/init', { project_id: p })),
  },
  {
    name: 'POST /api/cost-ledger/sync', table: 'cost_ledger_items', okStatus: 200, okProject: PROJECT_A_EMPTY,
    call: async p => (await import('@/app/api/cost-ledger/sync/route')).POST(jsonReq('/api/cost-ledger/sync', { project_id: p })),
  },
  {
    name: 'POST /api/estimate-groups', table: 'estimate_groups', okStatus: 201,
    call: async p => (await import('@/app/api/estimate-groups/route')).POST(jsonReq('/api/estimate-groups', { project_id: p, label: '工種' })),
  },
  {
    name: 'POST /api/estimate-revisions', table: 'estimate_revisions', okStatus: 201,
    call: async p => (await import('@/app/api/estimate-revisions/route')).POST(jsonReq('/api/estimate-revisions', {
      project_id: p, subtotal: 150000, misc_expense: 0, rounding_discount: 0, tax_amount: 15000, total: 165000,
    })),
  },
  {
    name: 'POST /api/invoices', table: 'invoice_documents', okStatus: 201,
    call: async p => (await import('@/app/api/invoices/route')).POST(jsonReq('/api/invoices', { project_id: p })),
  },
  {
    name: 'POST /api/project-notes', table: 'project_notes', okStatus: 201,
    call: async p => (await import('@/app/api/project-notes/route')).POST(jsonReq('/api/project-notes', { project_id: p, content: 'メモ' })),
  },
  {
    name: 'GET /api/project-billing（初回に既定の行を作る）', table: 'project_billing_milestones', okStatus: 200,
    call: async p => (await import('@/app/api/project-billing/route')).GET(new NextRequest(`http://localhost/api/project-billing?project_id=${p}`)),
  },
  {
    name: 'POST /api/line-events/[id]/notes（project_id）', table: 'line_event_notes', okStatus: 200,
    call: async p => (await import('@/app/api/line-events/[id]/notes/route')).POST(noteReq(p), { params: Promise.resolve({ id: EVENT_A }) }),
  },
  {
    name: 'POST /api/ai/chat/confirm-change（estimate_items create）', table: 'estimate_items', okStatus: 200,
    call: async p => (await import('@/app/api/ai/chat/confirm-change/route')).POST(jsonReq('/api/ai/chat/confirm-change', {
      change: { id: 'c1', target_table: 'estimate_items', change_type: 'create', proposed: { project_id: p, name: '追加項目', quantity: 1, unit: '式', cost_price: 1000 } },
    })),
  },
  {
    name: 'POST /api/ai/chat/confirm-change（estimate_items bulk_create）', table: 'estimate_items', okStatus: 200,
    call: async p => (await import('@/app/api/ai/chat/confirm-change/route')).POST(jsonReq('/api/ai/chat/confirm-change', {
      change: { id: 'c2', target_table: 'estimate_items', change_type: 'bulk_create', proposed: { project_id: p, items: [{ name: 'コピー項目', quantity: 1, unit: '式' }] } },
    })),
  },
]

describe.each(cases)('$name', c => {
  it.each([
    ['他社の案件', PROJECT_B],
    ['存在しない案件', PROJECT_MISSING],
    ['削除済みの自社案件', PROJECT_A_DELETED],
    ['UUID でない値', 'not-a-uuid'],
  ])('%s は 404 で、何も書き込まない', async (_label, projectId) => {
    currentUser = USER_A
    const before = await count(c.table)
    const res = await c.call(projectId)
    expect(res.status).toBe(404)
    const body = await res.json()
    // 内部情報（DB のエラー文・他社の案件名）を返さない
    expect(JSON.stringify(body)).not.toMatch(/violates|constraint|relation|B社/)
    expect(await count(c.table)).toBe(before)
  })

  it('自社の有効な案件では従来どおり成功し、行は自社・その案件に付く', async () => {
    currentUser = USER_A
    const project = c.okProject ?? PROJECT_A
    const before = await count(c.table)
    const res = await c.call(project)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(c.okStatus)
    if (c.okProject === PROJECT_A_EMPTY) return // sync: 見積項目が無い案件は差分0件（書き込みなし）が正常
    expect(await count(c.table)).toBeGreaterThan(before)
    const { rows } = await admin.query(
      `SELECT DISTINCT company_id, project_id FROM ${c.table} WHERE project_id = $1`, [project],
    )
    expect(rows).toEqual([{ company_id: COMPANY_A, project_id: project }])
  })
})

describe('POST /api/line-events/[id]/notes の起点イベント', () => {
  it('他社の LINE イベントを起点にした追記は 404 で、何も書き込まない', async () => {
    currentUser = USER_A
    const before = await count('line_event_notes')
    const { POST } = await import('@/app/api/line-events/[id]/notes/route')
    for (const id of [EVENT_B, randomUUID(), 'not-a-uuid']) {
      const res = await POST(noteReq(PROJECT_A), { params: Promise.resolve({ id }) })
      expect(res.status).toBe(404)
    }
    expect(await count('line_event_notes')).toBe(before)
  })

  it('案件未指定（未振り分け）の自社イベントへの追記は従来どおり成功する', async () => {
    currentUser = USER_A
    const { POST } = await import('@/app/api/line-events/[id]/notes/route')
    const res = await POST(noteReq(null), { params: Promise.resolve({ id: EVENT_A }) })
    expect(res.status).toBe(200)
    const { rows } = await admin.query('SELECT company_id, project_id FROM line_event_notes WHERE id = $1', [(await res.json()).id])
    expect(rows).toEqual([{ company_id: COMPANY_A, project_id: null }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 朝のブリーフィング（admin クライアント = RLS を通らない）
// ─────────────────────────────────────────────────────────────────────────────

describe('朝のブリーフィング: 他社の案件を指す行があっても他社の案件名・ID を出さない', () => {
  beforeAll(async () => {
    // B社の案件を指す A社の行（制約 20261014000001 の導入前に作られた行を想定）。
    // 制約がある DB では作れないため、このトランザクションだけ外部キーのトリガーを止めて作る
    await admin.query('BEGIN')
    await admin.query("SET LOCAL session_replication_role = 'replica'")
    await admin.query(
      `INSERT INTO project_billing_milestones (company_id, project_id, type, sort_order, invoice_date, invoice_amount)
       VALUES ($1, $2, '契約金', 0, $3, 500000)`, [COMPANY_A, PROJECT_B, longAgo])
    await admin.query(
      `INSERT INTO invoice_documents (company_id, project_id, status, payment_due_at, invoice_number)
       VALUES ($1, $2, 'issued', $3, 'INV-X'), ($1, $2, 'draft', NULL, 'INV-Y')`, [COMPANY_A, PROJECT_B, longAgo])
    await admin.query('COMMIT')
    // 制約がある DB では、A社のユーザーが同じ行を直接作ろうとしても拒否される
    await expect(asUser(USER_A,
      `INSERT INTO project_billing_milestones (company_id, project_id, type, sort_order, invoice_date, invoice_amount)
       VALUES ($1, $2, '契約金', 0, $3, 500000)`, [COMPANY_A, PROJECT_B, longAgo])).rejects.toMatchObject({ code: '23503' })
    // 比較用の A社の正常な行（自社案件の期限超過マイルストーン）
    await admin.query(
      `INSERT INTO project_billing_milestones (company_id, project_id, type, sort_order, invoice_date, invoice_amount)
       VALUES ($1, $2, '着工金', 1, $3, 300000)`, [COMPANY_A, PROJECT_A_EMPTY, longAgo])
  })

  it('前提: 修正前と同じ取得（行の company_id だけで絞る）では B社の案件名が返る', async () => {
    const sb = pgSupabase(admin)
    const { data } = await sb
      .from('project_billing_milestones')
      .select('project_id, projects!inner ( id, name )')
      .eq('company_id', COMPANY_A)
    expect(JSON.stringify(data)).toContain(SECRET_B)
  })

  it('getDailyBriefingItems（cron と同じ admin + companyId）と LINE 本文に B社の案件が出ない', async () => {
    const { getDailyBriefingItems, formatBriefingMessage } = await import('@/lib/services/daily-briefing')
    const items = await getDailyBriefingItems(pgSupabase(admin) as never, undefined, COMPANY_A)
    const text = JSON.stringify(items) + formatBriefingMessage(items, today)
    expect(text).not.toContain(SECRET_B)
    expect(text).not.toContain(PROJECT_B)
    // 自社の正常な行は従来どおり出る
    expect(items.some(i => i.projectId === PROJECT_A_EMPTY && i.type === 'billing_missing')).toBe(true)
  })

  it('getCompanyBillingStatus（admin + companyId）に B社の案件が出ず、金額にも含めない', async () => {
    const { getCompanyBillingStatus } = await import('@/lib/services/billing-status')
    const s = await getCompanyBillingStatus(pgSupabase(admin) as never, COMPANY_A)
    expect(JSON.stringify(s)).not.toContain(SECRET_B)
    expect(JSON.stringify(s)).not.toContain(PROJECT_B)
    expect(s.total_unpaid_amount).toBe(300000)
    expect(s.overdue_milestones.map(m => m.project_id)).toEqual([PROJECT_A_EMPTY])
    // 請求書は上の POST /api/invoices 正常系で作った A社の下書きだけ（B社の案件を指す INV-X / INV-Y は出ない）
    expect(s.issued_invoices).toEqual([])
    expect(s.draft_invoices.map(i => i.project_id)).toEqual([PROJECT_A])
  })

  it('ダッシュボード（RLS 有効・companyId なし）でも B社の案件の行は数えない', async () => {
    const { getCompanyBillingStatus } = await import('@/lib/services/billing-status')
    const { getDailyBriefingItems } = await import('@/lib/services/daily-briefing')
    const sb = pgSupabase(admin, USER_A)
    const s = await getCompanyBillingStatus(sb as never)
    expect(s.total_unpaid_amount).toBe(300000)
    const items = await getDailyBriefingItems(sb as never)
    expect(JSON.stringify(items)).not.toContain(PROJECT_B)
  })
})
