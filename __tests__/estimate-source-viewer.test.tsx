// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EstimateSourceViewer } from '@/components/projects/EstimateSourceViewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let el: HTMLDivElement | null = null
let root: Root | null = null
const pages = [
  { key: 'same.jpg:10:1', name: 'same.jpg', url: 'blob:original-A' },
  { key: 'same.jpg:20:2', name: 'same.jpg', url: 'blob:original-B' },
]

function mount() {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  let selected = pages[0].key
  const change = (key: string) => {
    selected = key
    act(() => root!.render(<EstimateSourceViewer pages={pages} selectedKey={selected} onSelect={change} />))
  }
  act(() => root!.render(<EstimateSourceViewer pages={pages} selectedKey={selected} onSelect={change} />))
  return { element: el }
}
function click(rootElement: Element, label: string) {
  const button = [...rootElement.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.includes(label))
  expect(button, `Button ${label}`).toBeDefined()
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
afterEach(() => {
  if (root) act(() => root!.unmount())
  el?.remove()
  el = null; root = null
})

describe('見積の原本画像ビューア', () => {
  it('元画像を表示し、同じファイル名でもキーでページを選ぶ', () => {
    const { element } = mount()
    const photo = () => element.querySelector('[data-testid=source-image-inline] img') as HTMLImageElement
    expect(photo().getAttribute('src')).toBe('blob:original-A')
    click(element, '原本 2: same.jpg')
    expect(photo().getAttribute('src')).toBe('blob:original-B')
    expect(element.textContent).toContain('2/2')
  })

  it('ズームは段階的に制限され、画像を切り替えるとリセット', () => {
    const { element } = mount()
    click(element, '原本を拡大')
    expect(element.querySelector('[data-testid=source-zoom]')?.textContent).toContain('150%')
    click(element, '原本 2: same.jpg')
    expect(element.querySelector('[data-testid=source-zoom]')?.textContent).toContain('100%')
    click(element, '原本を縮小')
    expect(element.querySelector('[data-testid=source-zoom]')?.textContent).toContain('100%')
  })

  it('明細からの開く要求で、同じ画像でも原本の拡大表示を開く', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const localRoot = createRoot(element)
    let count = 0
    const show = () => act(() => localRoot.render(
      <EstimateSourceViewer pages={pages} selectedKey={pages[0].key} onSelect={() => {}} openRequest={count} />,
    ))
    show()
    expect(document.querySelector('[role=dialog]')).toBeNull()
    count++
    show()
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role=dialog]')).toBeNull()
    count++
    show()
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    act(() => localRoot.unmount())
    element.remove()
  })

  it('拡大モーダルから元画像を表示し、Escapeで閉じる', () => {
    const { element } = mount()
    click(element, '大きく表示')
    const dialog = document.querySelector('[role=dialog]') as HTMLElement
    expect(dialog).not.toBeNull()
    const img = dialog.querySelector('[data-testid=source-image-large] img')!
    expect(img.getAttribute('src')).toBe('blob:original-A')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
})
