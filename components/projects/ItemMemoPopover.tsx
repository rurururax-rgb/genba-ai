'use client'

/**
 * 明細の備考 編集パネル
 *
 * 「お客様向け備考」（estimate_items.memo … 見積書・Excel に載る）と
 * 「社内メモ」（estimate_items.internal_memo … RAGZ 内だけ。お客様向け出力には出ない）を
 * 最初から別の箱として縦に並べる。公開/非公開トグルは持たない。
 */

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const T = {
  text:      '#1A2E24',
  textSub:   '#2D4A38',
  textMuted: '#7A9185',
  divider:   '#D5DED8',
  red:       '#D12953',
} as const
const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"

export function LockIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  )
}

export type MemoPatch = { memo?: string | null; internal_memo?: string | null }

const norm = (v: string) => v.trim() === '' ? null : v.trim()

export function ItemMemoPopover({
  anchor, memo, internalMemo, internalAvailable, onSave, onClose,
}: {
  anchor:            DOMRect
  memo:              string | null
  internalMemo:      string | null
  /** internal_memo 列が利用可能か（migration 未適用環境では false） */
  internalAvailable: boolean
  onSave:            (patch: MemoPatch) => Promise<void>
  onClose:           () => void
}) {
  const [customer, setCustomer] = useState(memo ?? '')
  const [internal, setInternal] = useState(internalMemo ?? '')
  const [saving,   setSaving]   = useState(false)

  const patch: MemoPatch = {}
  if (norm(customer) !== (memo ?? null)) patch.memo = norm(customer)
  if (internalAvailable && norm(internal) !== (internalMemo ?? null)) patch.internal_memo = norm(internal)
  const changed = Object.keys(patch).length > 0

  async function save() {
    if (saving) return
    if (!changed) { onClose(); return }
    setSaving(true)
    try { await onSave(patch) } finally { setSaving(false) }
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // 表のキー操作（Tab/Enter での行移動など）に漏らさない
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); save() }
  }

  const W = 340
  const H = 330
  const top  = anchor.bottom + 6 + H > window.innerHeight ? Math.max(8, anchor.top - H - 6) : anchor.bottom + 6
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - W - 8)

  const label: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: T.text }
  const hint:  React.CSSProperties = { fontSize: 11, color: T.textMuted, lineHeight: 1.5 }

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 8998 }} onClick={onClose} />
      <div
        role="dialog"
        aria-label="備考"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          position: 'fixed', top, left, width: W, zIndex: 8999,
          background: '#fff', borderRadius: 12, border: `1px solid ${T.divider}`,
          boxShadow: '0 6px 28px rgba(26,35,50,0.16)', fontFamily: FONT,
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        {/* お客様向け備考 */}
        <div>
          <label htmlFor="item-memo-customer" style={label}>お客様向け備考</label>
          <div style={hint}>見積書に表示されます</div>
          <Textarea
            id="item-memo-customer"
            inputSize="compact"
            value={customer}
            onChange={e => setCustomer(e.target.value)}
            autoFocus
            rows={2}
            className="mt-1.5"
          />
        </div>

        {/* 社内メモ */}
        <div>
          <label htmlFor="item-memo-internal" style={label}>社内メモ</label>
          <div style={{ ...hint, display: 'flex', alignItems: 'center', gap: 4 }}>
            <LockIcon size={11} color={T.textMuted} />
            お客様には表示されません
          </div>
          <Textarea
            id="item-memo-internal"
            inputSize="compact"
            value={internal}
            onChange={e => setInternal(e.target.value)}
            disabled={!internalAvailable}
            placeholder={internalAvailable ? undefined : 'データベース更新後に使えます'}
            rows={2}
            className="mt-1.5 bg-[#F8FAF8]"
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button type="button" variant="primary" size="sm" className="flex-1" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  )
}
