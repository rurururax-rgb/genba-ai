import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// QA 用 Fixture バックエンド（lib/qa/invoice-fixture-backend.ts）の fetch 差し替えの寿命と遮断の確認。
// node 環境なので window / sessionStorage は最小限のスタブで置き換える
const ORIGIN = 'http://localhost:3000'
const SUPABASE = 'https://example-ref.supabase.co'

let realFetch: ReturnType<typeof vi.fn>

async function load() {
  vi.resetModules()
  return import('@/lib/qa/invoice-fixture-backend')
}

beforeEach(() => {
  realFetch = vi.fn(async () => new Response('real'))
  const store = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  })
  vi.stubGlobal('window', { fetch: realFetch, location: { href: `${ORIGIN}/qa/invoice`, origin: ORIGIN } })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('installInvoiceFixtureBackend', () => {
  it('差し替え中は /api/invoices を Fixture で応答し、Supabase と未対応の /api は実サーバーへ送らない', async () => {
    const { installInvoiceFixtureBackend, INVOICE_FIXTURE_PROJECT_ID } = await load()
    const uninstall = installInvoiceFixtureBackend()
    expect(uninstall).toBeTypeOf('function')
    expect(window.fetch).not.toBe(realFetch)

    const created = await window.fetch('/api/invoices', { method: 'POST', body: JSON.stringify({ adjustment: -500, items: [{ amount: 1000 }] }) })
    expect(created.status).toBe(201)
    const inv = await created.json()
    expect(inv).toMatchObject({ project_id: INVOICE_FIXTURE_PROJECT_ID, adjustment: -500, items: [{ amount: 1000 }] })
    const list = await (await window.fetch(`/api/invoices?project_id=${INVOICE_FIXTURE_PROJECT_ID}`)).json()
    expect(list).toHaveLength(1)

    for (const url of [
      `${SUPABASE}/rest/v1/estimate_items?project_id=eq.${INVOICE_FIXTURE_PROJECT_ID}`,
      'https://other-ref.supabase.co/rest/v1/projects',
      `${SUPABASE}/auth/v1/token?grant_type=refresh_token`,
      '/api/estimate-items',
    ]) {
      const res = await window.fetch(url, { method: 'POST' })
      expect(res.status).toBe(403)
    }
    // Request オブジェクトで渡しても判定される
    expect((await window.fetch(new Request(`${SUPABASE}/rest/v1/projects`, { method: 'PATCH' }))).status).toBe(403)
    expect(realFetch).not.toHaveBeenCalled()

    // 対象外（同一オリジンの静的ファイル・他サイト）は元の fetch に渡す
    await window.fetch('/favicon.ico')
    expect(realFetch).toHaveBeenCalledTimes(1)
    if (uninstall) uninstall()
  })

  it('戻す関数で元の fetch に戻る（ページを離れた後は差し替えが残らない）', async () => {
    const { installInvoiceFixtureBackend, isInvoiceFixtureBackendActive } = await load()
    expect(isInvoiceFixtureBackendActive()).toBe(false)
    const uninstall = installInvoiceFixtureBackend()
    if (!uninstall) throw new Error('not installed')
    expect(isInvoiceFixtureBackendActive()).toBe(true)
    uninstall()
    expect(isInvoiceFixtureBackendActive()).toBe(false)
    expect(window.fetch).toBe(realFetch)
    await window.fetch('/api/invoices')
    expect(realFetch).toHaveBeenCalledTimes(1)
    // 2 回呼んでも問題ない
    uninstall()
    expect(window.fetch).toBe(realFetch)
  })

  it('再マウント（StrictMode の effect 二重実行）でも差し替えが有効なまま、最後に元に戻る', async () => {
    const { installInvoiceFixtureBackend } = await load()
    const first = installInvoiceFixtureBackend()
    if (!first) throw new Error('not installed')
    first()
    const second = installInvoiceFixtureBackend()
    if (!second) throw new Error('not installed')
    expect(window.fetch).not.toBe(realFetch)
    expect((await window.fetch(`${SUPABASE}/rest/v1/projects`)).status).toBe(403)
    second()
    expect(window.fetch).toBe(realFetch)
  })

  it('重ねて呼ばれた場合は、すべて戻されるまで差し替えたまま', async () => {
    const { installInvoiceFixtureBackend } = await load()
    const a = installInvoiceFixtureBackend()
    const b = installInvoiceFixtureBackend()
    if (!a || !b) throw new Error('not installed')
    a()
    a() // 同じ戻す関数を 2 回呼んでも数え間違えない
    expect(window.fetch).not.toBe(realFetch)
    b()
    expect(window.fetch).toBe(realFetch)
  })

  it('他のコードが後から fetch を上書きしていたら、それは壊さない', async () => {
    const { installInvoiceFixtureBackend } = await load()
    const uninstall = installInvoiceFixtureBackend()
    if (!uninstall) throw new Error('not installed')
    const other = vi.fn()
    window.fetch = other
    // 差し替えが外れた状態として扱う（Fixture ページは InvoiceTab を描画しない）
    const { isInvoiceFixtureBackendActive } = await import('@/lib/qa/invoice-fixture-backend')
    expect(isInvoiceFixtureBackendActive()).toBe(false)
    uninstall()
    expect(window.fetch).toBe(other)
  })

  it('本番ビルドでは差し替えない', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { installInvoiceFixtureBackend } = await load()
    expect(installInvoiceFixtureBackend()).toBe(false)
    expect(window.fetch).toBe(realFetch)
  })
})
