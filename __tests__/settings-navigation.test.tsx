import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishActiveProjectTab } from '@/lib/project/active-tab'

/**
 * 設定への導線（サイドバー下部の歯車・BottomNav の「設定」・/settings の一覧）。
 * 選択状態は pathname と案件タブの store だけから決まるので、描画し直す（= 再読み込み）たびに同じ結果になることも確かめる。
 */

let pathname = '/projects'
let user: { id: string } | null = { id: 'user-a' }

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) },
}))
vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock('@/lib/company/current-company', () => ({ getCurrentCompany: async () => null }))

const { Sidebar } = await import('@/components/shell/Sidebar')
const { BottomNav } = await import('@/components/shell/BottomNav')
const { default: SettingsPage } = await import('@/app/(dashboard)/settings/page')
const { default: DashboardLayout } = await import('@/app/(dashboard)/layout')

/** active（aria-current="page"）のリンク・ボタンのラベル */
function activeLabels(html: string, labelOf: (tag: string, rest: string) => string) {
  return [...html.matchAll(/<(?:button|a)\b([^>]*)>([\s\S]*?)<\/(?:button|a)>/g)]
    .filter(m => m[1].includes('aria-current="page"'))
    .map(m => labelOf(m[1], m[2]))
}
const sidebarActive = () =>
  activeLabels(renderToStaticMarkup(<Sidebar />), tag => /aria-label="([^"]+)"/.exec(tag)?.[1] ?? '')
const bottomActive = () =>
  activeLabels(renderToStaticMarkup(<BottomNav />), (_tag, inner) => /<span[^>]*>([^<]+)<\/span>/.exec(inner)?.[1] ?? '')

beforeEach(() => {
  pathname = '/projects'
  user = { id: 'user-a' }
})
afterEach(() => publishActiveProjectTab(null))

describe('サイドバー：設定（歯車）', () => {
  it('案件一覧・資材マスター・設定・案件詳細のどこでも、下部に /settings への歯車がある', () => {
    for (const p of ['/projects', '/materials', '/settings', '/settings/password', '/projects/p1']) {
      pathname = p
      const html = renderToStaticMarkup(<Sidebar />)
      const settingsLink = [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]).filter(t => t.includes('aria-label="設定"'))
      expect(settingsLink).toHaveLength(1)
      expect(settingsLink[0]).toContain('href="/settings"')
      // 歯車はナビの最後（下部）に置く
      const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1])
      expect(labels.at(-1)).toBe('設定')
    }
  })

  it('選択状態：開いている画面のものだけが active', () => {
    const cases: [string, string[]][] = [
      ['/projects', ['案件一覧']],
      ['/materials', ['資材マスター']],
      ['/settings', ['設定']],
      ['/settings/password', ['設定']],
    ]
    for (const [p, expected] of cases) {
      pathname = p
      expect(sidebarActive()).toEqual(expected)
    }
  })

  it('案件詳細：表示中の案件タブだけが active で、設定は active にならない', () => {
    pathname = '/projects/p1'
    publishActiveProjectTab('estimate')
    expect(sidebarActive()).toEqual(['見積エディタ'])
  })

  it('再読み込み：案件タブの状態が空でも、/settings/password では設定だけが active', () => {
    pathname = '/settings/password'
    publishActiveProjectTab(null)
    expect(sidebarActive()).toEqual(['設定'])
    expect(sidebarActive()).toEqual(['設定'])
  })
})

describe('BottomNav（スマホ）：設定', () => {
  it('案件一覧・資材マスター・設定の 3 つを出す', () => {
    const html = renderToStaticMarkup(<BottomNav />)
    expect([...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map(m => m[1])).toEqual(['/projects', '/materials', '/settings'])
  })

  it('選択状態：開いている画面のものだけが active（案件詳細では案件一覧）', () => {
    const cases: [string, string[]][] = [
      ['/projects', ['案件一覧']],
      ['/projects/p1', ['案件一覧']],
      ['/materials', ['資材マスター']],
      ['/settings', ['設定']],
      ['/settings/password', ['設定']],
    ]
    for (const [p, expected] of cases) {
      pathname = p
      expect(bottomActive()).toEqual(expected)
    }
  })
})

describe('画面幅：サイドバーは lg 以上、BottomNav は lg 未満', () => {
  it('どちらにも設定があり、幅で片方だけが表示される', async () => {
    pathname = '/projects/p1'
    const html = renderToStaticMarkup(await DashboardLayout({ children: <p>content</p> }))
    const sidebarWrap = /<div class="hidden lg:flex no-print">([\s\S]*?)<\/aside><\/div>/.exec(html)?.[1] ?? ''
    const bottomWrap = /<div class="lg:hidden no-print">([\s\S]*)$/.exec(html)?.[1] ?? ''
    expect(sidebarWrap).toContain('aria-label="設定"')
    expect(bottomWrap).toContain('href="/settings"')
  })
})

describe('/settings', () => {
  it('アカウント設定 → パスワード変更（/settings/password）だけを出す（未実装の項目は出さない）', async () => {
    const html = renderToStaticMarkup(await SettingsPage())
    expect(html).toContain('アカウント設定')
    expect([...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map(m => m[1])).toEqual(['/settings/password'])
    expect(html).toContain('パスワード変更')
    for (const label of ['会社情報', '見積書設定', 'LINE連携', '通知']) expect(html).not.toContain(label)
  })

  it('未ログインは /login へ', async () => {
    user = null
    await expect(SettingsPage()).rejects.toThrow('REDIRECT:/login')
  })
})

describe('案件一覧のヘッダー', () => {
  const src = readFileSync(path.resolve(__dirname, '../app/(dashboard)/projects/page.tsx'), 'utf8')

  it('パスワード変更のリンクは出さない', () => {
    expect(src).not.toContain('/settings/password')
    expect(src).not.toContain('パスワード変更')
  })

  it('ログアウトはそのまま（signOut して /login へ）', () => {
    expect(src).toMatch(/<LogoutForm \/>/)
    expect(src).toMatch(/auth\.signOut\(\)[\s\S]*redirect\('\/login'\)/)
  })
})
