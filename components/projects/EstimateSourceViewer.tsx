'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export type EstimateSourcePage = {
  /** ファイル名が同じ画像も区別する、取り込み候補と共通の識別子 */
  key: string
  name: string
  url: string
}

type Props = {
  pages: EstimateSourcePage[]
  selectedKey: string | null
  onSelect: (key: string) => void
  /** 明細の「原本を見る」クリックごとに変わる値。選択済みの画像でも開ける。 */
  openRequest?: number
}

const ZOOMS = [1, 1.5, 2, 3] as const

const toolbarButton: CSSProperties = {
  border: '1px solid #C5D7CB',
  borderRadius: 6,
  padding: '5px 9px',
  color: '#234332',
  background: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  minHeight: 30,
}

function ImageViewport({ page, zoom, expanded }: { page: EstimateSourcePage; zoom: number; expanded: boolean }) {
  return (
    <div
      data-testid={expanded ? 'source-image-large' : 'source-image-inline'}
      style={{
        height: expanded ? 'calc(100dvh - 160px)' : 'clamp(210px, 34dvh, 380px)',
        overflow: 'auto',
        background: '#F2F5F3',
        borderRadius: 6,
        textAlign: 'center',
        border: '1px solid #E2EAE4',
      }}
    >
      {/* 元画像の blob URL を使う。送信用に縮小した画像で原本の確認をしない */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={page.url}
        alt={`見積書原本: ${page.name}`}
        draggable={false}
        style={{ display: 'block', width: `${zoom * 100}%`, maxWidth: 'none', height: 'auto' }}
      />
    </div>
  )
}

/** 
 * 見積OCRの原本表示。読み取り・登録・確認状態は持たず、表示だけを担当する。
 * モーダルでも同じ画像 URL を使い、画像を Storage / DB に送らない。
 */
export function EstimateSourceViewer({ pages, selectedKey, onSelect, openRequest = 0 }: Props) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const active = pages.find(p => p.key === selectedKey) ?? pages[0]

  useEffect(() => { setZoomIndex(0) }, [active?.key])

  // 画像の選択だけでは見た目が変わらない場合があるため、明細からの操作では
  // 原本を大きく開く。openRequest=0 の初期表示では自動で開かない。
  useEffect(() => { if (openRequest > 0) setExpanded(true) }, [openRequest])

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  if (!active) return null

  const tools = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <button type="button" style={toolbarButton} aria-label="原本を縮小" disabled={zoomIndex === 0}
        onClick={() => setZoomIndex(i => Math.max(0, i - 1))}>−</button>
      <span data-testid="source-zoom" style={{ fontSize: 12, color: '#4E6557', minWidth: 42, textAlign: 'center' }}>
        {Math.round(ZOOMS[zoomIndex] * 100)}%
      </span>
      <button type="button" style={toolbarButton} aria-label="原本を拡大" disabled={zoomIndex === ZOOMS.length - 1}
        onClick={() => setZoomIndex(i => Math.min(ZOOMS.length - 1, i + 1))}>＋</button>
    </div>
  )

  const pageTabs = (
    <div role="group" aria-label="見積書の画像を選択" style={{ display: 'flex', gap: 5, overflowX: 'auto', padding: '5px 0' }}>
      {pages.map((page, index) => (
        <button
          key={page.key}
          type="button"
          aria-pressed={page.key === active.key}
          aria-label={`原本 ${index + 1}: ${page.name}`}
          onClick={() => onSelect(page.key)}
          style={{
            ...toolbarButton,
            flexShrink: 0,
            borderColor: page.key === active.key ? '#3D7A55' : '#C5D7CB',
            background: page.key === active.key ? '#E3EFE7' : '#fff',
            fontWeight: page.key === active.key ? 700 : 400,
          }}
        >{index + 1}ページ</button>
      ))}
    </div>
  )

  return (
    <section aria-label="見積書の原本" data-testid="estimate-source-viewer"
      style={{ background: '#fff', borderBottom: '1px solid #BDD1C3', padding: '10px 12px', position: 'sticky', top: 0, zIndex: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: '#192C1F' }}>原本を見ながら確認</strong>
        <button type="button" style={toolbarButton} onClick={() => setExpanded(true)}>大きく表示</button>
      </div>
      {pageTabs}
      <div title={active.name} style={{ fontSize: 11, color: '#4E6557', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>
        {active.name}（{pages.findIndex(p => p.key === active.key) + 1}/{pages.length}）
      </div>
      <ImageViewport page={active} zoom={ZOOMS[zoomIndex]} expanded={false} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 7 }}>
        <span style={{ fontSize: 11, color: '#4E6557' }}>画像を拡大して金額を照合してください</span>
        {tools}
      </div>

      {expanded && createPortal(
        <div role="presentation" onClick={e => { if (e.target === e.currentTarget) setExpanded(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15, 28, 20, .8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
          <section role="dialog" aria-modal="true" aria-label="見積書原本の拡大表示"
            style={{ background: '#fff', borderRadius: 12, padding: 14, width: 'min(1100px, 100%)', maxHeight: 'calc(100dvh - 24px)', overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14 }}>原本：{active.name}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {tools}
                <button type="button" style={toolbarButton} onClick={() => setExpanded(false)} autoFocus>閉じる</button>
              </div>
            </div>
            {pageTabs}
            <ImageViewport page={active} zoom={ZOOMS[zoomIndex]} expanded />
          </section>
        </div>,
        document.body,
      )}
    </section>
  )
}
