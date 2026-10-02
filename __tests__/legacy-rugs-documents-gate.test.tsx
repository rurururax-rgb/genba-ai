import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 模擬: Supabase サーバークライアント / next/navigation ─────────────────
type Company = { name: string; display_name: string | null; tax_rate: number; template_id: string | null }
const state: { company: Company | null; queried: string[] } = { company: null, queried: [] }

function fakeSupabase() {
  const result = (table: string) => {
    if (table === 'projects') return { data: { id: 'p1', name: 'キッチン改修工事', customer_name: '山田 太郎', site_address: '東京都', construction_period: null, companies: state.company }, error: null }
    if (table === 'company_members') return { data: { company_id: 'c1', companies: state.company }, error: null }
    if (table === 'estimate_groups') return { data: [{ id: 'g1', label: '内装', display_mode: 'detailed', sort_order: 0 }], error: null }
    if (table === 'estimate_items') return { data: [{ id: 'i1', name: 'システムキッチン', quantity: 1, unit: '式', selling_price: 500000, amount: 500000, group_id: 'g1', sort_order: 0, row_type: 'item', memo: null }], error: null }
    return { data: null, error: null }
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from(table: string) {
      state.queried.push(table)
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'order', 'limit']) q[m] = () => q
      q.single = async () => result(table)
      q.maybeSingle = async () => result(table)
      q.then = (resolve: (v: unknown) => void) => resolve(result(table))
      return q
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ getServerClient: async () => fakeSupabase() }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) },
  usePathname: () => '/projects/p1',
}))

const RUGS: Company = { name: 'ラグズ建築', display_name: null, tax_rate: 0.1, template_id: 'rugs' }
const MODERN: Company = { name: 'トライアル工務店', display_name: 'トライアル工務店', tax_rate: 0.1, template_id: 'modern' }

// ラグズ建築の固有情報（他社へ表示・出力してはいけない）
const RUGS_STRINGS = ['ラグズ', '栗本', '岐阜', '今嶺', '058-374', 'T2200001044783', '十六銀行', '1326345', '103774', 'rugs_reform', '500-8388']

beforeEach(() => { state.queried = [] })

// ── legacy Excel API ─────────────────────────────────────────────────────
describe('GET /api/projects/[id]/estimate/excel', () => {
  const call = async () => {
    const { GET } = await import('@/app/api/projects/[id]/estimate/excel/route')
    return GET({} as never, { params: Promise.resolve({ id: 'p1' }) })
  }

  it('modern の会社：403 で拒否し、見積データも読まない（Excel を生成しない）', async () => {
    state.company = MODERN
    const res = await call()
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(state.queried).not.toContain('estimate_items')
    expect(state.queried).not.toContain('estimate_groups')
  })

  it.each([['template_id null', { ...MODERN, template_id: null }], ['会社情報なし', null]])('%s：403', async (_l, company) => {
    state.company = company as Company | null
    expect((await call()).status).toBe(403)
  })

  it('rugs の会社：従来どおり Excel を生成', async () => {
    state.company = RUGS
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
  })
})

// ── 挨拶回り文書ページ ───────────────────────────────────────────────────
describe('/projects/[id]/greeting', () => {
  const render = async () => {
    const { default: GreetingPage } = await import('@/app/(dashboard)/projects/[id]/greeting/page')
    return GreetingPage({ params: Promise.resolve({ id: 'p1' }) })
  }

  it('modern の会社：直接 URL でも notFound（ラグズ建築の文書を返さない）', async () => {
    state.company = MODERN
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('会社情報なし：notFound', async () => {
    state.company = null
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('rugs の会社：従来どおり表示', async () => {
    state.company = RUGS
    const el = await render()
    expect(React.isValidElement(el)).toBe(true)
  })
})

// ── UI の導線 ────────────────────────────────────────────────────────────
describe('UI の導線（請求書タブ・挨拶状リンク）', () => {
  it('サイドバー：modern では請求書ボタンを出さない / rugs では出す', async () => {
    const { Sidebar } = await import('@/components/shell/Sidebar')
    // ラベルはホバー時のツールチップで静的 HTML に出ないため、案件タブのボタン数で確認する
    const buttons = (html: string) => (html.match(/<button/g) ?? []).length
    const modern = buttons(renderToStaticMarkup(<Sidebar legacyRugsDocuments={false} />))
    const dflt   = buttons(renderToStaticMarkup(<Sidebar />))
    const rugs   = buttons(renderToStaticMarkup(<Sidebar legacyRugsDocuments />))
    expect(rugs).toBe(modern + 1)   // 請求書の 1 ボタン分だけ差がある
    expect(dflt).toBe(modern)       // 既定は出さない（Fail Closed）
  })

  it('基本情報：modern では挨拶回り文書リンクなし・実在人物名なし / rugs ではリンクあり', async () => {
    const { ProjectInfoPanel } = await import('@/components/projects/ProjectInfoPanel')
    const project = { id: 'p1', name: 'A', customer_name: null, site_address: null, person_in_charge: null, construction_period: null, payment_terms: null, estimate_valid_from: null, estimate_valid_months: null, construction_overview: null, project_memo: null, payment_contract_pct: null, payment_start_pct: null, payment_completion_pct: null }
    const modern = renderToStaticMarkup(<ProjectInfoPanel project={project} />)
    const rugs   = renderToStaticMarkup(<ProjectInfoPanel project={project} legacyRugsDocuments />)
    expect(modern).not.toContain('挨拶回り文書')
    expect(modern).not.toContain('/greeting')
    for (const s of RUGS_STRINGS) expect(modern, s).not.toContain(s)
    expect(rugs).toContain('挨拶回り文書を出力')
  })

  it('ProjectTabs：modern で ?tab=invoice を指定しても請求書を描画しない', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
    const { ProjectTabs } = await import('@/components/projects/ProjectTabs')
    const projectInfo = { id: 'p1', name: 'A', customer_name: null, site_address: null, person_in_charge: null, construction_period: null, payment_terms: null, estimate_valid_from: null, estimate_valid_months: null, construction_overview: null, project_memo: null, payment_contract_pct: null, payment_start_pct: null, payment_completion_pct: null }
    const html = renderToStaticMarkup(<ProjectTabs projectId="p1" projectInfo={projectInfo} defaultTab="invoice" />)
    for (const s of RUGS_STRINGS) expect(html, s).not.toContain(s)
    expect(html).not.toContain('御請求')
    expect(html).not.toContain('請求書を新規作成')
  })
})

// ── ソース上の保証 ───────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const SOURCES = ['app', 'components', 'lib'].flatMap(d => walk(d)).filter(f => !/(^|\/)qa\//.test(f))

describe('ソース上の保証', () => {
  // コメントを除いたコード部分だけを検査する
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')

  it('template_id の判定は lib/company/templates.ts だけ（各所へコピーしない）', () => {
    const offenders = SOURCES.filter(f => f !== 'lib/company/templates.ts')
      .filter(f => /template_id\s*[!=]==?\s*['"]|['"]rugs['"]/.test(strip(readFileSync(f, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('ラグズ建築の固有情報を含むのは、ゲート済みの legacy 帳票ファイルだけ', () => {
    const allowed = new Set([
      'components/projects/InvoiceTab.tsx',                        // 請求書（rugs のみ読み込み・表示）
      'app/(dashboard)/projects/[id]/greeting/GreetingDocument.tsx', // 挨拶状（rugs 以外は notFound）
      'components/estimate/EstimateDocument.tsx',                  // 表紙ロゴ（rugs のみ表示）
      'lib/excel/fill-template.ts',                                // 未使用の旧 Excel 生成（テンプレートファイル名）
      'lib/company/templates.ts',                                  // 判定の説明コメント
    ])
    const pattern = new RegExp(RUGS_STRINGS.filter(s => s !== '岐阜').join('|'))
    const offenders = SOURCES.filter(f => !allowed.has(f)).filter(f => pattern.test(strip(readFileSync(f, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('AI の指示文に特定会社名を固定していない', () => {
    const files = SOURCES.filter(f => f.startsWith('app/api/ai/') || f.startsWith('lib/ai/'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('ラグズ')
    expect(readFileSync('app/api/ai/extract-estimate/route.ts', 'utf8')).toContain('業者から自社への請求金額')
  })
})
