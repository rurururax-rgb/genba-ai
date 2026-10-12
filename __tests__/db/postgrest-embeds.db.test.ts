/**
 * KI-003: アプリの PostgREST の埋め込みが、全 migration を適用した DB の外部キーで一意に解決できること。
 *
 * - ヒントあり: そのテーブル → 埋め込み先の外部キーとして実在する（名前違い・別テーブルの外部キーではない）。
 * - ヒントなし: 2 テーブル間の関係（どちら向きの外部キーも数える）が 1 本だけ。2 本以上なら PostgREST は PGRST201 で拒否する。
 *
 * migration で外部キーを足したときに、既存の埋め込みがあいまいになっていないかをここで検出する。
 * 本番・Preview には接続しない（隔離ローカル PostgreSQL）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { collectEmbeds } from '../helpers/postgrest-embeds'

let server: LocalPostgres
let db: Client

beforeAll(async () => {
  server = await startLocalPostgres()
  db = await server.connect()
  await applyFullSchema(db)
})

afterAll(async () => {
  await server?.stop()
})

async function fkeys(from: string, to: string): Promise<string[]> {
  const { rows } = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND conrelid = to_regclass('public.' || $1) AND confrelid = to_regclass('public.' || $2)
      ORDER BY conname`, [from, to])
  return rows.map(r => r.conname)
}

const { embeds } = collectEmbeds()

describe('PostgREST の埋め込みが外部キーで一意に解決できる（KI-003）', () => {
  it('埋め込みが 1 件以上見つかる（パーサーの前提）', () => {
    expect(embeds.length).toBeGreaterThan(0)
  })

  it.each(embeds.map(e => [`${e.file}: ${e.base} → ${e.rel}`, e] as const))('%s', async (_label, e) => {
    const forward = await fkeys(e.base, e.rel)
    if (e.hint) {
      expect(forward).toContain(e.hint)
    } else {
      const backward = await fkeys(e.rel, e.base)
      expect({ forward, backward, total: forward.length + backward.length }).toMatchObject({ total: 1 })
    }
  })

  it('前提: PR #35 / PR-3 で projects への外部キーが 2 本になったテーブルでは、ヒントが必須になっている', async () => {
    expect(await fkeys('project_billing_milestones', 'projects')).toEqual([
      'project_billing_milestones_project_company_fkey', 'project_billing_milestones_project_id_fkey',
    ])
    expect(await fkeys('invoice_documents', 'projects')).toEqual([
      'invoice_documents_project_company_fkey', 'invoice_documents_project_id_fkey',
    ])
  })
})
