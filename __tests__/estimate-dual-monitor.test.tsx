// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/components/projects/EstimateImportTab', () => ({
  EstimateImportTab: () => <div data-testid="single-ocr-panel">取り込み候補</div>,
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
    click(popup.body, '1画面に戻す')
    expect(mountNode.querySelector('[data-testid=estimate-import-portal-host]')).toBe(host)
    expect(mountNode.querySelector('[data-testid=single-ocr-panel]')).toBe(panel)
    expect(popupWindow.close).toHaveBeenCalled()
  })
})
