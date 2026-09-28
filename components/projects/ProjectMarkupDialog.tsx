'use client'

/**
 * 案件標準（projects.markup_rate）の変更ダイアログ。
 * 粗利率 ⇄ 掛け率 の連動入力は明細 popover と共通（LinkedRateFields）。
 */

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { markupToMarginRate } from '@/lib/estimate/pricing'
import { LinkedRateFields, RATE_RANGE_ERROR, fmtMarginPct, fmtMarkup, useLinkedRateDraft } from './ItemPricingPopover'

const T = {
  text:        '#1A2E24',
  textMuted:   '#7A9185',
  accentLight: '#EAF3DE',
  green:       '#2B5E40',
  red:         '#D12953',
  blue:        '#1D4ED8',
} as const
const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"

export function ProjectMarkupDialog({
  currentRate, autoCount, excludedCount, onApply, onClose,
}: {
  currentRate:   number
  /** 案件標準で自動計算している明細数（今回の変更で単価が変わる） */
  autoCount:     number
  /** 手入力・個別設定の明細数（今回の変更対象外） */
  excludedCount: number
  /** 成功時 null、失敗時エラーメッセージ */
  onApply:       (rate: number) => Promise<string | null>
  onClose:       () => void
}) {
  const draft = useLinkedRateDraft(currentRate)
  const [applying, setApplying] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const changed = draft.rate != null && Math.abs(draft.rate - currentRate) > 1e-9

  async function submit() {
    if (draft.rate == null) { setError(draft.invalid ? null : RATE_RANGE_ERROR); return }
    if (!changed || applying) return
    setApplying(true); setError(null)
    try {
      const err = await onApply(draft.rate)
      if (err) setError(err)
      else onClose()
    } finally { setApplying(false) }
  }

  const stat = (label: string, rate: number, color: string) => (
    <div>
      <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
        粗利 {fmtMarginPct(markupToMarginRate(rate))}
      </div>
      <div style={{ fontSize: 11, color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>掛け率 {fmtMarkup(rate)}</div>
    </div>
  )

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget && !applying) onClose() }}
      onKeyDown={e => { if (e.key === 'Escape' && !applying) onClose() }}
    >
      <div role="dialog" aria-label="案件標準の粗利率を変更" style={{ background: '#fff', borderRadius: 14, padding: '28px 28px 24px', width: 380, boxShadow: '0 8px 40px rgba(26,35,50,0.18)', fontFamily: FONT }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: T.text, margin: '0 0 4px' }}>
          案件標準の粗利率を変更
        </h2>
        <p style={{ fontSize: 12, color: T.textMuted, margin: '0 0 20px', lineHeight: 1.6 }}>
          原価から単価を自動計算するときの基準です。見積全体の粗利率（実績）とは別の値です。
        </p>

        <div style={{ background: T.accentLight, borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 20, alignItems: 'center' }}>
          {stat('現在', currentRate, T.green)}
          {changed && draft.rate != null && (
            <>
              <span style={{ fontSize: 18, color: T.textMuted }}>→</span>
              {stat('変更後', draft.rate, T.blue)}
            </>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <LinkedRateFields
            draft={{ ...draft, editMarkup: t => { setError(null); draft.editMarkup(t) }, editMargin: t => { setError(null); draft.editMargin(t) } }}
            onEnter={submit}
          />
          {error && <p style={{ fontSize: 11, color: T.red, margin: '6px 0 0' }}>{error}</p>}
        </div>

        <div style={{ background: '#F8F9FA', borderRadius: 7, padding: '10px 14px', marginBottom: 20, fontSize: 12 }}>
          <div style={{ color: T.green, fontWeight: 600, marginBottom: excludedCount > 0 ? 4 : 0 }}>
            自動計算の明細 {autoCount} 件の単価が更新されます
          </div>
          {excludedCount > 0 && (
            <div style={{ color: T.textMuted }}>
              手入力・個別設定の明細 {excludedCount} 件は変わりません
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={applying} className="flex-1">
            キャンセル
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={!changed || applying} className="flex-[2]">
            {applying ? '更新中…' : '確定して更新'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
