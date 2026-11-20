'use client'

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { EstimateImportTab } from './EstimateImportTab'

type Props = {
  projectId: string
  onClose: () => void
}

/** 1 画面の枠の下の余白（sticky の top と同じ） */
const INLINE_GAP = 12
/** 1 画面の枠の最小の高さ。これより低い画面では、外側（案件画面）のスクロールで下端を出す */
const MIN_INLINE_HEIGHT = 240

/**
 * One OCR panel, two display locations. We move the SAME portal container
 * across same-origin windows. Candidate / confirmation / in-flight state
 * is never duplicated and the import API stays unchanged.
 */
export function DetachableEstimateImportPanel({ projectId, onClose }: Props) {
  const inlineRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<Window | null>(null)
  // 1 画面と別ウィンドウを行き来する同じ入れ物（作り直さないので、読み取り・確認・送信中の状態を失わない）
  const [host] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null
    const node = document.createElement('div')
    node.dataset.testid = 'estimate-import-portal-host'
    node.style.display = 'flex'
    node.style.flexDirection = 'column'
    node.style.height = '100%'
    // 1 画面では枠（dock）の flex 子。min-height: 0 が無いと内容の高さ以下に縮まず、枠の外（overflow: hidden）で切れて
    // 中の枠（estimate-import-scroll）がスクロールしない。別ウィンドウ（body 直下）では height: 100% が効き、この 2 つは影響しない
    node.style.flex = '1 1 auto'
    node.style.minHeight = '0'
    node.style.minWidth = '0'
    return node
  })
  const [detached, setDetached] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // 1 画面: 枠の下端を表示範囲の下端（-12px）に合わせる。枠の上端は案件ヘッダー・ツールバーの下にあり、スクロールで
  // sticky の位置まで上がるので、上端から測る（100dvh 固定だと、上端がずれた分だけ下がはみ出す）。拡大率・高さの変更にも追従
  useEffect(() => {
    if (detached) return
    const dock = inlineRef.current
    if (!dock) return
    let frame = 0
    const fit = () => {
      frame = 0
      const viewport = window.visualViewport?.height ?? window.innerHeight
      const top = Math.max(0, dock.getBoundingClientRect().top)
      dock.style.maxHeight = `${Math.max(MIN_INLINE_HEIGHT, Math.floor(viewport - top - INLINE_GAP))}px`
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit) }
    fit()
    // 案件画面のスクロールは main の中で起きるので、捕捉フェーズで受ける（パネル内のスクロールも来るが計算は軽い）
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    // 上のツールバーの折り返しなどで枠の上端が動いたとき（祖先の大きさが変わる）にも測り直す
    for (let el = dock.parentElement; el && el !== document.body; el = el.parentElement) ro?.observe(el)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      ro?.disconnect()
      dock.style.maxHeight = ''
    }
  }, [detached])

  useEffect(() => {
    const node = host
    if (!node) return
    inlineRef.current?.appendChild(node)
    return () => {
      const popup = popupRef.current
      popupRef.current = null
      if (popup && !popup.closed) popup.close()
      node.remove()
    }
  }, [host])

  function restore() {
    const popup = popupRef.current
    popupRef.current = null
    if (host && inlineRef.current) inlineRef.current.appendChild(host)
    setDetached(false)
    setNotice(null)
    if (popup && !popup.closed) popup.close()
  }

  function detach() {
    if (!host || popupRef.current) return
    const popup = window.open('', '', 'popup=yes,width=1440,height=920,resizable=yes,scrollbars=yes')
    if (!popup) {
      setNotice('別ウィンドウを開けませんでした。ポップアップ設定を確認してください。1画面モードはそのまま使えます。')
      return
    }
    try {
      popup.document.title = 'RAGZ｜見積書OCR 原本確認'
      popup.document.documentElement.className = document.documentElement.className
      popup.document.body.className = document.body.className
      popup.document.body.style.margin = '0'
      // 別ウィンドウの高さいっぱいを使う（html / body / 入れ物の高さを決め、スクロールは中の原本と表に任せる）
      popup.document.documentElement.style.height = '100%'
      popup.document.body.style.height = '100%'
      popup.document.body.style.overflow = 'hidden'
      popup.document.body.style.background = '#F8FAF9'
      document.querySelectorAll('style,link[rel="stylesheet"]').forEach(el => {
        popup.document.head.appendChild(el.cloneNode(true))
      })
      popup.document.body.appendChild(host)
      popupRef.current = popup
      const onBeforeUnload = () => {
        if (popupRef.current !== popup) return
        popupRef.current = null
        inlineRef.current?.appendChild(host)
        setDetached(false)
      }
      popup.addEventListener('beforeunload', onBeforeUnload, { once: true })
      popup.focus()
      setDetached(true)
      setNotice(null)
    } catch {
      inlineRef.current?.appendChild(host)
      popupRef.current = null
      popup.close()
      setDetached(false)
      setNotice('別ウィンドウを初期化できませんでした。1画面モードに戻しました。')
    }
  }

  return (
    <>
      <div
        ref={inlineRef}
        data-testid="estimate-import-inline-dock"
        style={{
          width: detached ? 0 : 380,
          flexShrink: 0,
          display: detached ? 'none' : 'flex',
          flexDirection: 'column',
          borderRadius: 10,
          border: detached ? 'none' : '1px solid #D4DDD6',
          background: '#fff',
          overflow: 'hidden',
          position: 'sticky',
          top: INLINE_GAP,
          alignSelf: 'flex-start',
          // 初回描画の目安。実際の値は上の fit() が枠の上端から計算して上書きする
          maxHeight: `calc(100dvh - ${INLINE_GAP * 2}px)`,
          minWidth: 0,
        }}
      />
      {notice && !detached && (
        <div role="alert" style={{ fontSize: 12, color: '#92400E', maxWidth: 380 }}>{notice}</div>
      )}
      {host && createPortal(
        <>
          <div style={{
            flexShrink: 0, minHeight: 52, display: 'flex', gap: 8, alignItems: 'center',
            justifyContent: 'space-between', padding: '8px 12px',
            borderBottom: '1px solid #D4DDD6', background: '#fff',
          }}>
            <strong style={{ color: '#1A2E24', fontSize: 14 }}>見積書を取り込む</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button"
                data-testid="estimate-popout-toggle"
                onClick={() => detached ? restore() : detach()}
                style={{ border: '1px solid #A8C5B5', borderRadius: 6, background: '#EAF3DE', color: '#1E5C3A', padding: '5px 8px', cursor: 'pointer', fontSize: 12 }}
              >{detached ? '1画面に戻す' : '別ウィンドウで開く'}</button>
              <button type="button" aria-label="取込パネルを閉じる" onClick={onClose}
                style={{ border: '1px solid #D4DDD6', borderRadius: 6, background: '#fff', padding: '5px 9px', cursor: 'pointer' }}>×</button>
            </div>
          </div>
          {/* 1 画面はこの枠でスクロール。別ウィンドウは高さだけ渡し、中（原本・表）がそれぞれスクロールする */}
          <div data-testid="estimate-import-scroll" style={detached
            ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
            : { flex: 1, overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain' }}>
            <EstimateImportTab projectId={projectId} wide={detached} />
          </div>
        </>,
        host,
      )}
    </>
  )
}
