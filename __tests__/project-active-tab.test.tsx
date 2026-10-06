import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishActiveProjectTab, getActiveProjectTab } from '@/lib/project/active-tab'
import { resolveProjectTab } from '@/components/projects/ProjectTabs'
import { Sidebar } from '@/components/shell/Sidebar'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects/p1' }))

const LABEL: Record<string, string> = {
  info: '基本情報', estimate: '見積エディタ', invoice: '請求書',
  'cost-ledger': '原価台帳', 'spec-import': '仕様書等の取り込み', schedule: '工程表',
}

/** サイドバーで active（aria-current="page"）になっているボタンのラベル一覧 */
function activeLabels(legacyRugsDocuments: boolean): string[] {
  const html = renderToStaticMarkup(<Sidebar legacyRugsDocuments={legacyRugsDocuments} />)
  return [...html.matchAll(/<(?:button|a)\b[^>]*>/g)]
    .map(m => m[0])
    .filter(tag => tag.includes('aria-current="page"'))
    .map(tag => /aria-label="([^"]+)"/.exec(tag)?.[1] ?? '')
}

/** ProjectTabs が表示するタブ（resolveProjectTab）を publish したときのサイドバー active */
function showAndRead(requested: string | null, rugs: boolean) {
  const shown = resolveProjectTab(requested, rugs)
  publishActiveProjectTab(shown)
  return { shown, active: activeLabels(rugs) }
}

afterEach(() => publishActiveProjectTab(null))

describe('案件画面：表示中のタブ === サイドバーで active なタブ', () => {
  for (const rugs of [true, false]) {
    const company = rugs ? 'rugs（請求書あり）' : 'modern（請求書なし）'
    for (const requested of ['info', 'estimate', 'invoice', 'cost-ledger', 'spec-import', 'schedule']) {
      it(`${company}：${requested} を開く → 表示中タブだけが active`, () => {
        const { shown, active } = showAndRead(requested, rugs)
        expect(active).toEqual([LABEL[shown]])
      })
    }
  }

  it('modern で請求書を指定されても見積を表示し、サイドバーも見積（請求書アイコンは出さない）', () => {
    const { shown, active } = showAndRead('invoice', false)
    expect(shown).toBe('estimate')
    expect(active).toEqual(['見積エディタ'])
    expect(renderToStaticMarkup(<Sidebar legacyRugsDocuments={false} />)).not.toContain('aria-label="請求書"')
  })

  it('未知の ?tab= / 指定なし → 見積を表示し、サイドバーも見積', () => {
    expect(showAndRead('unknown', true).active).toEqual(['見積エディタ'])
    expect(showAndRead(null, true).active).toEqual(['見積エディタ'])
  })

  it('本番の再現手順：請求書 → 案件一覧へ戻る → 案件を開き直す（見積）でサイドバーが請求書に残らない', () => {
    expect(showAndRead('invoice', true).active).toEqual(['請求書'])
    publishActiveProjectTab(null) // ProjectTabs unmount（案件一覧へ）
    expect(getActiveProjectTab()).toBeNull()
    expect(showAndRead(undefined as unknown as null, true).active).toEqual(['見積エディタ'])
  })

  it('見積 → 請求書 → 原価 → 工程 → 見積 の順に切り替えても常に一致', () => {
    for (const t of ['estimate', 'invoice', 'cost-ledger', 'schedule', 'estimate']) {
      const { shown, active } = showAndRead(t, true)
      expect(active).toEqual([LABEL[shown]])
    }
  })

  it('サイドバーは独自の選択 state を持たず、表示中タブ（ProjectTabs が publish）だけに従う', () => {
    const sidebar = readFileSync(path.join(process.cwd(), 'components/shell/Sidebar.tsx'), 'utf8')
    expect(sidebar).not.toMatch(/useState\(\s*'estimate'\s*\)/)
    expect(sidebar).not.toContain('setActiveTab')
    expect(sidebar).toContain('useSyncExternalStore(subscribeActiveProjectTab')
    const tabs = readFileSync(path.join(process.cwd(), 'components/projects/ProjectTabs.tsx'), 'utf8')
    expect(tabs).toMatch(/publishActiveProjectTab\(tab\)/) // 実際に描画するタブを publish
    expect(tabs).toMatch(/publishActiveProjectTab\(null\)/) // 案件を離れたら解除
  })
})
