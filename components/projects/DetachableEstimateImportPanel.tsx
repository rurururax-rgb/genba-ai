'use client'

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { EstimateImportTab } from './EstimateImportTab'

type Props = {
  projectId: string
  onClose: () => void
}

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
    node.style.minWidth = '0'
    return node
  })
  const [detached, setDetached] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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
          top: 12,
          alignSelf: 'flex-start',
          maxHeight: 'calc(100dvh - 24px)',
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
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <EstimateImportTab projectId={projectId} wide={detached} />
          </div>
        </>,
        host,
      )}
    </>
  )
}
