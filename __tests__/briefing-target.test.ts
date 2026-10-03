import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getBriefingTargetCompany, parseLineCompanyId } from '@/lib/services/briefing-target'

const RUGS = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'
const TRIAL = '11111111-2222-4333-8444-555555555555'
const DB = [{ id: RUGS, name: 'ラグズ建築' }, { id: TRIAL, name: 'トライアル工務店' }]

// companies への問い合わせを記録する最小の模擬クライアント
function fakeAdmin(opts: { error?: boolean } = {}) {
  const calls: Array<{ table: string; select: string; eq: Array<[string, string]> }> = []
  const client = {
    from(table: string) {
      const call = { table, select: '', eq: [] as Array<[string, string]> }
      calls.push(call)
      const q = {
        select(cols: string) { call.select = cols; return q },
        eq(col: string, val: string) { call.eq.push([col, val]); return q },
        async maybeSingle() {
          if (opts.error) return { data: null, error: { message: 'db error' } }
          const rows = DB.filter(r => call.eq.every(([c, v]) => (r as Record<string, string>)[c] === v))
          return { data: rows[0] ?? null, error: null }
        },
      }
      return q
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('parseLineCompanyId', () => {
  it('UUID はそのまま（小文字化・前後空白除去）', () => {
    expect(parseLineCompanyId(RUGS)).toBe(RUGS)
    expect(parseLineCompanyId(`  ${RUGS.toUpperCase()}  `)).toBe(RUGS)
  })
  it.each([undefined, null, '', '   ', 'rugs', 'all', '*', '1', `${RUGS},${TRIAL}`, `${RUGS}x`, "' or 1=1 --"])(
    '不正値 %j → null', v => { expect(parseLineCompanyId(v as string | null | undefined)).toBeNull() },
  )
})

describe('getBriefingTargetCompany（Fail Closed）', () => {
  it('LINE_COMPANY_ID なし → 対象 0 社。DB も読まない', async () => {
    for (const v of [undefined, null, '', '  ']) {
      const { client, calls } = fakeAdmin()
      expect(await getBriefingTargetCompany(client, v)).toBeNull()
      expect(calls).toHaveLength(0)
    }
  })

  it('不正な ID → 対象 0 社。DB も読まない', async () => {
    const { client, calls } = fakeAdmin()
    expect(await getBriefingTargetCompany(client, 'not-a-uuid')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('正しい ID → その 1 社のみ（必ず id で絞り込む）', async () => {
    const { client, calls } = fakeAdmin()
    expect(await getBriefingTargetCompany(client, RUGS)).toEqual({ id: RUGS, name: 'ラグズ建築' })
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('companies')
    expect(calls[0].eq).toEqual([['id', RUGS]])
  })

  it('存在しない会社 ID → 対象 0 社（他社へフォールバックしない）', async () => {
    const { client } = fakeAdmin()
    expect(await getBriefingTargetCompany(client, '99999999-9999-4999-8999-999999999999')).toBeNull()
  })

  it('DB エラー → 対象 0 社', async () => {
    const { client } = fakeAdmin({ error: true })
    expect(await getBriefingTargetCompany(client, RUGS)).toBeNull()
  })
})

describe('cron ルートに全社取得が残っていない', () => {
  const src = readFileSync('app/api/cron/daily-briefing/route.ts', 'utf8')
  it("companies テーブルを直接読まない（対象決定は briefing-target に一本化）", () => {
    expect(src).not.toMatch(/from\(\s*['"]companies['"]\s*\)/)
    expect(src).toContain('getBriefingTargetCompany(supabaseAdmin, process.env.LINE_COMPANY_ID)')
  })
  it('会社のループ処理が無い', () => {
    expect(src).not.toMatch(/for\s*\(\s*const\s+company\s+of/)
  })
})
