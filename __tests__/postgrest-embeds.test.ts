/**
 * KI-003: PostgREST の埋め込みがあいまいにならないための静的な回帰テスト。
 *
 * PR #35（20261013000002）・PR-3（20261014000001）で、案件にぶら下がるテーブルから projects への外部キーが
 * 2 本（単独 + 複合）になった。ヒントの無い `projects!inner (...)` は PostgREST が PGRST201 で拒否し、
 * 取得結果が空になる。projects を埋め込むときは、既存の単独外部キー名をヒントに付ける。
 *
 * 実際の外部キーとの照合は __tests__/db/postgrest-embeds.db.test.ts（npm run test:db）で行う。
 */

import { describe, expect, it } from 'vitest'
import { collectEmbeds } from './helpers/postgrest-embeds'

const { embeds, unparsed, multiHint } = collectEmbeds()

describe('PostgREST の埋め込み（KI-003）', () => {
  it('埋め込み付きの select はすべて .from(table).select(...) の形で読み取れる（取りこぼしなし）', () => {
    expect(unparsed).toEqual([])
    expect(multiHint).toEqual([])
  })

  it('projects の埋め込みには必ず既存の単独外部キー名（<テーブル>_project_id_fkey）をヒントに付ける', () => {
    const toProjects = embeds.filter(e => e.rel === 'projects')
    expect(toProjects.length).toBeGreaterThan(0)
    for (const e of toProjects) {
      expect({ file: e.file, base: e.base, hint: e.hint }).toEqual({ file: e.file, base: e.base, hint: `${e.base}_project_id_fkey` })
    }
  })

  it('埋め込みの一覧（増えたら、外部キーが複数ないかを確かめてからここに追加する）', () => {
    const list = embeds.map(e => `${e.file} | ${e.base} → ${e.rel}${e.hint ? `!${e.hint}` : ''}${e.inner ? '!inner' : ''}`).sort()
    expect(list).toEqual([
      'app/(dashboard)/projects/[id]/estimate/page.tsx | company_members → companies',
      'app/(dashboard)/projects/[id]/greeting/page.tsx | company_members → companies',
      'app/api/projects/[id]/estimate/excel/route.ts | projects → companies',
      'lib/company/current-company.ts | company_members → companies',
      'lib/services/billing-status.ts | invoice_documents → projects!invoice_documents_project_id_fkey!inner',
      'lib/services/billing-status.ts | project_billing_milestones → projects!project_billing_milestones_project_id_fkey!inner',
      'lib/services/daily-briefing.ts | project_billing_milestones → projects!project_billing_milestones_project_id_fkey!inner',
    ])
  })
})
