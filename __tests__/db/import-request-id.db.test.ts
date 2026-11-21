/**
 * 見積書 OCR 取り込みの登録 ID（estimate_items.import_request_id）による二重登録防止の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用し、
 *   実際の登録 API（/api/estimate-items/import）を「ログイン済みユーザー（authenticated + RLS）」として動かす。
 *   同時送信は別々の DB 接続から同時に送る。本番・Preview の DB には接続しない。すべて架空のデータ。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { pgSupabase } from './helpers/pg-supabase'

const MIGRATION = '20261122000001_add_import_request_id_to_estimate_items.sql'

let server: LocalPostgres
let admin: Client
/** API が使う接続。同時送信のテストでは、呼び出しごとに別の接続を順に渡す */
let db: Client
let pool: Client[] = []
let currentUser: string | undefined

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => pgSupabase(pool.length ? pool.shift()! : db, currentUser),
}))

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const PA1 = randomUUID()   // A 社・掛け率 1.3
const PA2 = randomUUID()   // A 社・別案件
const PB = randomUUID()    // B 社
const GA1 = randomUUID()
const GA1B = randomUUID()
const GB = randomUUID()

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, '架空A社', COMPANY_B, '架空B社'])
  await c.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await c.query(
    `INSERT INTO projects (id, company_id, name, status, markup_rate) VALUES
       ($1, $4, '架空A案件', 'collecting', 1.3), ($2, $4, '架空A別案件', 'collecting', 1.45), ($3, $5, '架空B案件', 'collecting', 1.45)`,
    [PA1, PA2, PB, COMPANY_A, COMPANY_B])
  await c.query(
    `INSERT INTO estimate_groups (id, company_id, project_id, label, sort_order) VALUES
       ($1, $4, $5, '内装', 0), ($2, $4, $5, '設備', 1), ($3, $6, $7, 'B社の工種', 0)`,
    [GA1, GA1B, GB, COMPANY_A, PA1, COMPANY_B, PB])
}

async function resetItems(c: Client) {
  await c.query('DELETE FROM estimate_items')
  // migration 以前からある行（import_request_id は NULL）。NULL どうしは一意制約で衝突しない
  await c.query(
    `INSERT INTO estimate_items (project_id, company_id, group_id, name, quantity, unit, cost_price, selling_price, source, sort_order) VALUES
       ($1, $2, $3, '既存 手入力', 1, '式', 1000, 1300, 'manual', 0),
       ($1, $2, $3, '既存 取り込み', 1, '式', 2000, 2600, 'import', 1),
       ($1, $2, $3, '既存 取り込み', 1, '式', 2000, 2600, 'import', 2)`,
    [PA1, COMPANY_A, GA1])
}

const ITEM = { name: '架空 給湯器', quantity: 1, unit: '台', cost_price: 100000, vendor_name: '架空設備', internal_memo: '見積No. 架空-1' }

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/estimate-items/import/route')
  const res = await POST(new NextRequest('http://localhost/api/estimate-items/import', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  return { status: res.status, json: await res.json() as Record<string, unknown> & { items?: Array<Record<string, unknown>> } }
}

const rowsWith = async (id: string) => (await admin.query('SELECT * FROM estimate_items WHERE import_request_id = $1', [id])).rows
const count = async () => Number((await admin.query('SELECT count(*)::int AS n FROM estimate_items')).rows[0].n)

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await seed(admin)
  db = admin
})

afterAll(async () => { await server?.stop() })

beforeEach(async () => {
  currentUser = USER_A
  db = admin
  pool = []
  await resetItems(admin)
})

describe('migration', () => {
  it('NULL 許容の列と UNIQUE (company_id, import_request_id) を追加し、既存行（NULL）は変えない・衝突しない', async () => {
    const col = (await admin.query(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'estimate_items' AND column_name = 'import_request_id'`)).rows[0]
    expect(col).toEqual({ is_nullable: 'YES', data_type: 'uuid' })
    const con = (await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'estimate_items_company_import_request_key'`)).rows[0]
    expect(con.def).toBe('UNIQUE (company_id, import_request_id)')
    expect(Number((await admin.query('SELECT count(*)::int AS n FROM estimate_items WHERE import_request_id IS NULL')).rows[0].n)).toBe(3)
    // NULL の行はいくつでも追加できる（手入力・過去見積・旧クライアントの取り込み）
    await admin.query(`INSERT INTO estimate_items (project_id, company_id, name, source) VALUES ($1, $2, 'NULL 追加1', 'manual'), ($1, $2, 'NULL 追加2', 'manual')`, [PA1, COMPANY_A])
    expect(await count()).toBe(5)
  })

  it('同じ会社に同じ登録 ID は 1 行だけ（DB の制約で 23505）。別の会社なら同じ ID でも入る', async () => {
    const id = randomUUID()
    await admin.query(`INSERT INTO estimate_items (project_id, company_id, name, import_request_id) VALUES ($1, $2, 'x', $3)`, [PA1, COMPANY_A, id])
    await expect(admin.query(`INSERT INTO estimate_items (project_id, company_id, name, import_request_id) VALUES ($1, $2, 'y', $3)`, [PA2, COMPANY_A, id])).rejects.toMatchObject({ code: '23505' })
    await admin.query(`INSERT INTO estimate_items (project_id, company_id, name, import_request_id) VALUES ($1, $2, 'z', $3)`, [PB, COMPANY_B, id])
    expect((await rowsWith(id)).map(r => r.company_id).sort()).toEqual([COMPANY_A, COMPANY_B].sort())
  })
})

describe('登録 API: 同じ登録 ID の再送', () => {
  it('1 回目は登録し、同じ ID の再送（応答喪失・504 の後・連打・別ウィンドウ・再読み込み後）は保存済みの明細を返す', async () => {
    const id = randomUUID()
    const first = await post({ project_id: PA1, group_id: GA1, sort_order: 5000, items: [{ ...ITEM, import_request_id: id }] })
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ created: 1, replayed: 0, idempotent: true })
    const saved = first.json.items![0]
    // 売価は案件掛け率（1.3）で従来どおり計算される
    expect(saved).toMatchObject({ name: '架空 給湯器', selling_price: 130000, selling_price_mode: 'auto', sort_order: 5000, internal_memo: '見積No. 架空-1' })

    // 再送（並び順は送り直しで変わりうる。保存済みの位置のまま返す）
    const again = await post({ project_id: PA1, group_id: GA1, sort_order: 7000, items: [{ ...ITEM, import_request_id: id }] })
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ created: 0, replayed: 1, idempotent: true })
    expect(again.json.items![0]).toMatchObject({ id: saved.id, sort_order: 5000 })
    expect(await rowsWith(id)).toHaveLength(1)
  })

  it('大文字の UUID でも同じ ID として扱う', async () => {
    const id = randomUUID()
    await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    const again = await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id.toUpperCase() }] })
    expect(again.json).toMatchObject({ created: 0, replayed: 1 })
    expect(await rowsWith(id)).toHaveLength(1)
  })

  it.each([
    ['品名', { name: '架空 給湯器（別）' }],
    ['数量', { quantity: 2 }],
    ['単位', { unit: '式' }],
    ['原価', { cost_price: 90000 }],
    ['業者', { vendor_name: '別の架空業者' }],
    ['社内メモ', { internal_memo: '別のメモ' }],
  ])('同じ ID でも %s が違えば 409 で断り、何も登録しない', async (_label, patch) => {
    const id = randomUUID()
    await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    const before = await count()
    const r = await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, ...patch, import_request_id: id }] })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'import_request_conflict', not_saved: true })
    expect(await count()).toBe(before)
  })

  it('同じ ID でも案件・工種が違えば 409（別の案件・工種へ入れない）', async () => {
    const id = randomUUID()
    await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    expect((await post({ project_id: PA1, group_id: GA1B, items: [{ ...ITEM, import_request_id: id }] })).status).toBe(409)
    expect((await post({ project_id: PA2, group_id: null, items: [{ ...ITEM, import_request_id: id }] })).status).toBe(409)
    expect(await rowsWith(id)).toHaveLength(1)
  })

  it('登録後に削除された明細と同じ ID は、もう一度入れずに 409（削除したことを知らせる）', async () => {
    const id = randomUUID()
    await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    await admin.query('UPDATE estimate_items SET deleted_at = now() WHERE import_request_id = $1', [id])
    const r = await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'import_request_deleted', not_saved: true })
    expect(await rowsWith(id)).toHaveLength(1)
  })

  it('一括追加：保存済みの ID と新しい ID が混ざっていたら、新しい分だけ登録し、要求の順で返す', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
    const one = await post({ project_id: PA1, group_id: null, items: [{ ...ITEM, name: '架空 A', import_request_id: a }] })
    const r = await post({ project_id: PA1, group_id: null, items: [
      { ...ITEM, name: '架空 B', import_request_id: b }, { ...ITEM, name: '架空 A', import_request_id: a }, { ...ITEM, name: '架空 C', import_request_id: c },
    ] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ created: 2, replayed: 1 })
    expect(r.json.items!.map(i => i.name)).toEqual(['架空 B', '架空 A', '架空 C'])
    expect(r.json.items![1].id).toBe(one.json.items![0].id)
    for (const id of [a, b, c]) expect(await rowsWith(id)).toHaveLength(1)
  })

  it('一括追加の中に中身の違う保存済み ID があれば、1 件も登録しない', async () => {
    const [a, b] = [randomUUID(), randomUUID()]
    await post({ project_id: PA1, group_id: null, items: [{ ...ITEM, import_request_id: a }] })
    const before = await count()
    const r = await post({ project_id: PA1, group_id: null, items: [{ ...ITEM, name: '架空 新規', import_request_id: b }, { ...ITEM, quantity: 9, import_request_id: a }] })
    expect(r.status).toBe(409)
    expect(await count()).toBe(before)
    expect(await rowsWith(b)).toHaveLength(0)
  })
})

describe('同時送信（別々の DB 接続から同じ ID）', () => {
  it('同じ ID の 5 件を同時に送っても 1 行だけ。全員に同じ明細を返す', async () => {
    const conns = await Promise.all(Array.from({ length: 5 }, () => server.connect()))
    const id = randomUUID()
    pool = [...conns]
    const results = await Promise.all(conns.map(() => post({ project_id: PA1, group_id: GA1, sort_order: 9000, items: [{ ...ITEM, import_request_id: id }] })))
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(new Set(results.map(r => r.json.items![0].id)).size).toBe(1)
    expect(results.reduce((s, r) => s + Number(r.json.created), 0)).toBe(1)
    expect(await rowsWith(id)).toHaveLength(1)
    await Promise.all(conns.map(c => c.end()))
  })

  it('確定前の同じ ID の登録と競合したら、確定を待って 23505 → 保存済みを読み直して返す（決まった順で再現）', async () => {
    const other = await server.connect()
    const id = randomUUID()
    // 別の送信が INSERT 済み・まだ確定していない（API の事前確認からは見えない）
    await other.query('BEGIN')
    await other.query(
      `INSERT INTO estimate_items (project_id, company_id, group_id, name, quantity, unit, cost_price, selling_price, selling_price_mode, vendor_name, internal_memo, source, sort_order, import_request_id)
       VALUES ($1, $2, $3, $4, 1, '台', 100000, 130000, 'auto', '架空設備', '見積No. 架空-1', 'import', 100, $5)`,
      [PA1, COMPANY_A, GA1, ITEM.name, id])
    // API は自分の接続で動かす（待っている間も、確認のクエリは admin で流せるように）
    const apiConn = await server.connect()
    pool = [apiConn]
    const pending = post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    // API の INSERT が一意インデックスで待っていることを確かめてから確定する
    for (let i = 0; i < 100; i++) {
      const w = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO "estimate_items"%'`)
      if (Number(w.rows[0].n) > 0) break
      await new Promise(r => setTimeout(r, 20))
    }
    const waited = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO "estimate_items"%'`)).rows[0].n)
    expect(waited).toBe(1)
    await other.query('COMMIT')
    const r = await pending
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ created: 0, replayed: 1 })
    expect(r.json.items![0].sort_order).toBe(100)
    expect(await rowsWith(id)).toHaveLength(1)
    await other.end()
    await apiConn.end()
  })

  it('確定前の同じ ID の登録が取り消されたら、待った後に自分の登録が入る', async () => {
    const other = await server.connect()
    const id = randomUUID()
    await other.query('BEGIN')
    await other.query(`INSERT INTO estimate_items (project_id, company_id, name, source, import_request_id) VALUES ($1, $2, 'x', 'import', $3)`, [PA1, COMPANY_A, id])
    // API は自分の接続で動かす（待っている間も、確認のクエリは admin で流せるように）
    const apiConn = await server.connect()
    pool = [apiConn]
    const pending = post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    for (let i = 0; i < 100; i++) {
      const w = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO "estimate_items"%'`)
      if (Number(w.rows[0].n) > 0) break
      await new Promise(r => setTimeout(r, 20))
    }
    await other.query('ROLLBACK')
    const r = await pending
    expect(r.json).toMatchObject({ created: 1, replayed: 0 })
    expect((await rowsWith(id)).map(x => x.name)).toEqual([ITEM.name])
    await other.end()
    await apiConn.end()
  })

  it('同じ ID・違う中身を同時に送ったら、1 つだけ登録され、残りは 409（二重に入らない）', async () => {
    const conns = await Promise.all(Array.from({ length: 4 }, () => server.connect()))
    const id = randomUUID()
    pool = [...conns]
    const results = await Promise.all(conns.map((_, i) => post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, quantity: i + 1, import_request_id: id }] })))
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(3)
    expect(await rowsWith(id)).toHaveLength(1)
    await Promise.all(conns.map(c => c.end()))
  })

  it('一括追加どうしが一部の ID で重なって同時に来ても、各 ID は 1 行だけ', async () => {
    const conns = await Promise.all(Array.from({ length: 3 }, () => server.connect()))
    const ids = Array.from({ length: 6 }, () => randomUUID())
    pool = [...conns]
    const bodies = [[0, 1, 2], [2, 3, 4], [4, 5, 0]].map(set => ({ project_id: PA1, group_id: null, items: set.map(k => ({ ...ITEM, name: `架空 ${k}`, import_request_id: ids[k] })) }))
    const results = await Promise.all(bodies.map(b => post(b)))
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    for (const id of ids) expect(await rowsWith(id)).toHaveLength(1)
    await Promise.all(conns.map(c => c.end()))
  })
})

describe('他社・RLS・互換性', () => {
  it('他社が同じ ID を使っていても、自社の登録は入り、他社の行は返さない・変えない', async () => {
    const id = randomUUID()
    await admin.query(`INSERT INTO estimate_items (project_id, company_id, group_id, name, quantity, unit, cost_price, source, import_request_id) VALUES ($1, $2, $3, 'B社の秘密の明細', 1, '式', 1, 'import', $4)`, [PB, COMPANY_B, GB, id])
    const r = await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ created: 1, replayed: 0 })
    expect(JSON.stringify(r.json)).not.toContain('B社の秘密')
    const all = await rowsWith(id)
    expect(all).toHaveLength(2)
    expect(all.find(x => x.company_id === COMPANY_B)?.name).toBe('B社の秘密の明細')
  })

  it('他社の案件・工種へは、登録 ID があっても入れない（従来の所有確認のまま）', async () => {
    expect((await post({ project_id: PB, group_id: GB, items: [{ ...ITEM, import_request_id: randomUUID() }] })).status).toBe(404)
    expect((await post({ project_id: PA1, group_id: GB, items: [{ ...ITEM, import_request_id: randomUUID() }] })).status).toBe(404)
  })

  it('B 社の利用者からは、A 社の登録 ID の明細は見えない（RLS）', async () => {
    const id = randomUUID()
    await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }] })
    await admin.query('BEGIN')
    await admin.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_B])
    await admin.query('SET LOCAL ROLE authenticated')
    const seen = (await admin.query('SELECT id FROM estimate_items WHERE import_request_id = $1', [id])).rows
    await admin.query('ROLLBACK')
    expect(seen).toEqual([])
  })

  it('登録 ID の無い要求（旧クライアント）は従来どおり毎回登録する（idempotent: false）', async () => {
    const a = await post({ project_id: PA1, group_id: GA1, items: [ITEM] })
    const b = await post({ project_id: PA1, group_id: GA1, items: [ITEM] })
    expect(a.json).toMatchObject({ created: 1, idempotent: false })
    expect(b.json).toMatchObject({ created: 1, idempotent: false })
    expect(Number((await admin.query(`SELECT count(*)::int AS n FROM estimate_items WHERE name = '架空 給湯器' AND import_request_id IS NULL`)).rows[0].n)).toBe(2)
  })

  it('登録 ID の形が正しくない・一部の行だけ・重複は 400（何も登録しない）', async () => {
    const before = await count()
    const id = randomUUID()
    expect((await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: 'not-a-uuid' }] })).status).toBe(400)
    expect((await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }, ITEM] })).status).toBe(400)
    expect((await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: id }, { ...ITEM, import_request_id: id }] })).status).toBe(400)
    expect(await count()).toBe(before)
  })
})

describe('migration 未適用の DB（アプリを先に出した場合）', () => {
  let old: Client
  beforeAll(async () => {
    await server.createDatabase('before_import_request_id')
    old = await server.connect('before_import_request_id')
    await applyFullSchema(old, { skip: [MIGRATION] })
    await seed(old)
  })

  it('登録 ID を送っても、列が無ければ従来どおり登録する（取り込みは止めない・idempotent: false）', async () => {
    db = old
    const r = await post({ project_id: PA1, group_id: GA1, items: [{ ...ITEM, import_request_id: randomUUID() }] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ created: 1, idempotent: false })
    expect(Number((await old.query(`SELECT count(*)::int AS n FROM estimate_items WHERE name = '架空 給湯器'`)).rows[0].n)).toBe(1)
  })
})

describe('ロールバック', () => {
  it('制約 → 列の順に削除でき、既存の明細は残る', async () => {
    await server.createDatabase('rollback_check')
    const c = await server.connect('rollback_check')
    await applyFullSchema(c)
    await seed(c)
    await c.query(`INSERT INTO estimate_items (project_id, company_id, name, import_request_id) VALUES ($1, $2, 'x', $3), ($1, $2, 'y', NULL)`, [PA1, COMPANY_A, randomUUID()])
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('docs/db/import-request-id-sql-editor-rollback.sql', 'utf8')
    await c.query(sql)
    expect((await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'estimate_items' AND column_name = 'import_request_id'`)).rows[0].n).toBe(0)
    expect(Number((await c.query('SELECT count(*)::int AS n FROM estimate_items')).rows[0].n)).toBe(2)
  })
})
