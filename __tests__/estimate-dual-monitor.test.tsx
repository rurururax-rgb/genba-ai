// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/components/projects/EstimateImportTab', () => ({
  EstimateImportTab: ({ wide }: { wide?: boolean }) => <div data-testid="single-ocr-panel" data-wide={String(Boolean(wide))}>取り込み候補</div>,
}))
import { DetachableEstimateImportPanel } from '@/components/projects/DetachableEstimateImportPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mountNode: HTMLDivElement
let root: Root
const click = (target: HTMLElement, label: string) => {
  const button = [...target.querySelectorAll('button')].find(b => b.textContent?.includes(label))
  expect(button, label).toBeDefined()
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  mountNode = document.createElement('div')
  document.body.appendChild(mountNode)
  root = createRoot(mountNode)
  act(() => root.render(<DetachableEstimateImportPanel projectId="fake-project" onClose={() => {}} />))
})
afterEach(() => {
  act(() => root.unmount())
  mountNode.remove()
  vi.unstubAllGlobals()
})

describe('別ウィンドウの取り込みパネル', () => {
  it('通常は単一のパネルを表示。ポップアップ拒否時は候補を保持して利用可能', () => {
    const panel = mountNode.querySelector('[data-testid=single-ocr-panel]')
    const host = mountNode.querySelector('[data-testid=estimate-import-portal-host]')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('data-wide')).toBe('false')
    vi.stubGlobal('open', vi.fn(() => null))
    click(mountNode, '別ウィンドウで開く')
    expect(mountNode.querySelector('[data-testid=single-ocr-panel]')).toBe(panel)
    expect(mountNode.querySelector('[data-testid=estimate-import-portal-host]')).toBe(host)
    expect(mountNode.textContent).toContain('別ウィンドウを開けませんでした')
  })

  it('同じDOMノードを移動し、元に戻しても再マウントしない', () => {
    const popup = document.implementation.createHTMLDocument('popup')
    const popupWindow = {
      document: popup,
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
    }
    vi.stubGlobal('open', vi.fn(() => popupWindow))
    const host = mountNode.querySelector('[data-testid=estimate-import-portal-host]')
    const panel = mountNode.querySelector('[data-testid=single-ocr-panel]')
    click(mountNode, '別ウィンドウで開く')
    expect(popup.body.contains(host)).toBe(true)
    expect(popup.body.querySelector('[data-testid=single-ocr-panel]')).toBe(panel)
    expect(panel?.getAttribute('data-wide')).toBe('true')
    click(popup.body, '1画面に戻す')
    expect(mountNode.querySelector('[data-testid=estimate-import-portal-host]')).toBe(host)
    expect(mountNode.querySelector('[data-testid=single-ocr-panel]')).toBe(panel)
    expect(panel?.getAttribute('data-wide')).toBe('false')
    expect(popupWindow.close).toHaveBeenCalled()
  })

  it('別ウィンドウでは高さをウィンドウいっぱいに決め、外側ではスクロールしない（中の表がスクロールする）。1 画面に戻すと従来どおり', () => {
    const popup = document.implementation.createHTMLDocument('popup')
    const popupWindow = { document: popup, closed: false, focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => popupWindow))
    const scrollBox = () => document.querySelector('[data-testid=estimate-import-scroll]') as HTMLElement ?? popup.querySelector('[data-testid=estimate-import-scroll]') as HTMLElement
    expect(scrollBox().style.overflowY).toBe('auto')
    click(mountNode, '別ウィンドウで開く')
    expect(popup.documentElement.style.height).toBe('100%')
    expect(popup.body.style.height).toBe('100%')
    expect(popup.body.style.overflow).toBe('hidden')
    const box = popup.querySelector('[data-testid=estimate-import-scroll]') as HTMLElement
    expect(box.style.overflow).toBe('hidden')
    expect(box.style.display).toBe('flex')
    expect(box.style.minHeight).toBe('0')
    click(popup.body, '1画面に戻す')
    expect((mountNode.querySelector('[data-testid=estimate-import-scroll]') as HTMLElement).style.overflowY).toBe('auto')
  })

  it('1 画面: 入れ物は枠の中で縮み（min-height: 0）、パネル内のスクロール枠だけがスクロールする（本番で下が切れた不具合）', () => {
    const host = mountNode.querySelector('[data-testid=estimate-import-portal-host]') as HTMLElement
    // 枠（dock）の flex 子。min-height: auto のままだと内容の高さまで伸び、枠の overflow: hidden で切れてスクロールできない
    expect(host.style.minHeight).toBe('0')
    expect(host.style.flex).toBe('1 1 auto')
    const box = mountNode.querySelector('[data-testid=estimate-import-scroll]') as HTMLElement
    expect(box.style.overflowY).toBe('auto')
    expect(box.style.minHeight).toBe('0')
    expect(box.style.overscrollBehavior).toBe('contain')
  })

  it('1 画面: 枠の高さは「表示範囲の下端 − 枠の上端 − 12px」。上端が動いた・高さが変わったら測り直し、別ウィンドウ中は外す', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    vi.stubGlobal('innerHeight', 900)
    const dock = mountNode.querySelector('[data-testid=estimate-import-inline-dock]') as HTMLElement
    let top = 128
    dock.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 380, width: 380, height: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    // 案件ヘッダーの下（上端 128px）: 下端が表示範囲からはみ出さない
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(dock.style.maxHeight).toBe(`${900 - 128 - 12}px`)
    // 案件画面をスクロールして sticky の位置（上端 12px）へ
    top = 12
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(dock.style.maxHeight).toBe(`${900 - 12 - 12}px`)
    // 低いウィンドウ・拡大率を上げたとき（CSS の表示範囲が小さくなる）。最小 240px
    vi.stubGlobal('innerHeight', 200)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(dock.style.maxHeight).toBe('240px')

    const popup = document.implementation.createHTMLDocument('popup')
    vi.stubGlobal('open', vi.fn(() => ({ document: popup, closed: false, focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn() })))
    click(mountNode, '別ウィンドウで開く')
    expect(dock.style.maxHeight).toBe('')
    vi.stubGlobal('innerHeight', 900)
    click(popup.body, '1画面に戻す')
    expect(dock.style.maxHeight).toBe(`${900 - 12 - 12}px`)
  })
})
