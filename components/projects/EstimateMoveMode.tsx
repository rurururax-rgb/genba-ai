'use client'

// 見積エディタの「移動」（選択 → 移動 → 移動先の行間をクリック）の部品。
// 並びの計算は lib/estimate/move-plan.ts、状態の遷移は lib/estimate/move-mode.ts。

import { useCallback, useEffect, useReducer } from 'react'
import { initialMoveMode, moveModeReducer } from '@/lib/estimate/move-mode'

const ACCENT = '#2B5E40'
const FONT   = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"

/** 移動中の行 id と開始・終了。移動中は Esc で取り消す（IME 変換中の Esc は除く） */
export function useEstimateMoveMode() {
  const [{ moveIds }, dispatch] = useReducer(moveModeReducer, initialMoveMode)
  const start  = useCallback((selectedIds: Iterable<string>) => dispatch({ type: 'start', selectedIds }), [])
  const cancel = useCallback(() => dispatch({ type: 'cancel' }), [])
  const finish = useCallback(() => dispatch({ type: 'finish' }), [])

  useEffect(() => {
    if (!moveIds) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) cancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [moveIds, cancel])

  return { moveIds, moving: moveIds !== null, start, cancel, finish }
}

/** 移動先ボタンの読み上げ名。例：「外装工事」の システムキッチン の前へ移動 */
export function moveTargetLabel(groupLabel: string, beforeName: string | null) {
  const g = `「${groupLabel || '（無題）'}」`
  return beforeName === null ? `${g}の末尾へ移動` : `${g}の ${beforeName || '（名称なし）'} の前へ移動`
}

// ── MoveGap ───────────────────────────────────────────────
// 移動中だけ、行間 ＋（InsertGap）と同じ場所に置く「ここへ移動」。
// InsertGap と同じく行の内側に absolute で重ね、行の高さ・DnD の位置計算に影響させない。
// 見た目は globals.css の .est-move-gap-*（デスクトップはホバーで表示、タッチは常に小さく表示）。

export function MoveGap({ edge, label, onPick }: {
  edge: 'top' | 'bottom'
  label: string
  onPick: () => void
}) {
  return (
    <div className="est-move-gap" data-testid="estimate-move-gap" data-edge={edge}
      style={{ position: 'absolute', left: 0, right: 0, top: edge === 'top' ? 0 : '100%', height: 0, zIndex: 5, pointerEvents: 'none' }}>
      <span className="est-move-gap-line" aria-hidden />
      <button type="button" className="est-move-gap-btn" aria-label={label} title={label} onClick={onPick}>
        <span className="est-move-gap-label" aria-hidden>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          ここへ移動
        </span>
      </button>
    </div>
  )
}

/** 行がない場所（空の工種・行のない「その他」）への移動先 */
export function MoveTargetBlock({ label, text, onPick }: { label: string; text: string; onPick: () => void }) {
  return (
    <div data-testid="estimate-move-target" style={{ padding: '8px 52px' }}>
      <button type="button" className="est-move-target" aria-label={label} title={label} onClick={onPick}>
        {text}
      </button>
    </div>
  )
}

/** 移動中は選択バーの代わりに出す。次にすることと取り消し方を常に見せる */
export function MoveModeBar({ count, onCancel }: { count: number; onCancel: () => void }) {
  return (
    <div role="status" data-testid="estimate-move-bar" style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 12px',
      padding: '6px 16px', minHeight: 44,
      background: ACCENT, color: '#fff', fontFamily: FONT,
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{count}件を移動中</span>
      <span style={{ fontSize: 12 }}>移動先の行間の「ここへ移動」を押してください（別の工種タブにも移せます）</span>
      <div style={{ flex: 1 }} />
      <span className="est-move-esc-hint" style={{ fontSize: 11, opacity: 0.8 }}>Esc で取消</span>
      <button type="button" onClick={onCancel} style={{
        fontSize: 12, fontWeight: 700, fontFamily: FONT,
        color: ACCENT, background: '#fff', border: 'none', borderRadius: 6,
        padding: '0 14px', height: 32, cursor: 'pointer',
      }}>
        キャンセル
      </button>
    </div>
  )
}
