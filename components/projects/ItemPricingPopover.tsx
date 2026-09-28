'use client'

/**
 * 明細の「利益調整」UI
 *
 * - MarginCell        : 粗利率列のセル（1行表示: 31.0% ・ 個別 / 手入力）
 * - ItemPricingPopover: 粗利率セルをクリックすると開く。掛け率 ⇄ 粗利率 を相互連動で入力し、
 *                       変更後の単価をその場で確認して適用する
 * - LinkedRateFields  : 掛け率 / 粗利率の連動入力（案件標準ダイアログでも共用）
 *
 * 計算はすべて lib/estimate/pricing.ts（Calculation Layer）に委譲する。
 */

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  calculateSellingPrice,
  isValidMarkupRate,
  marginRateToMarkup,
  markupToMarginRate,
  type ItemPricingState,
} from '@/lib/estimate/pricing'

const T = {
  text:        '#1A2E24',
  textSub:     '#2D4A38',
  textMuted:   '#7A9185',
  divider:     '#D5DED8',
  accent:      '#2B5E40',
  accentLight: '#EAF3DE',
  accentTint:  '#A8D4B5',
  green:       '#2B5E40',
  red:         '#D12953',
  blue:        '#1D4ED8',
  blueBg:      '#DBEAFE',
} as const
const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const MARGIN_WARN = 0.15

const yen = (v: number) => `¥${v.toLocaleString('ja-JP')}`
export const fmtMarkup = (rate: number) => rate.toFixed(2)
export const fmtMarginPct = (margin: number | null) => margin != null ? `${(margin * 100).toFixed(1)}%` : '─'

export const RATE_RANGE_ERROR = '粗利率（89.9% 以下）または掛け率（0.01〜9.99）を入力してください。'

// ── 掛け率 ⇄ 粗利率 連動入力 ─────────────────────────────────

/**
 * 掛け率・粗利率のどちらを編集しても、もう一方と rate（保存する掛け率）が追従する。
 * rate は丸めない実数（粗利率入力時は 1 / (1 - margin)）。
 * 計算できない入力のときは、もう一方の欄を空にして「古い値が隣に残る」矛盾表示を防ぐ。
 */
export function useLinkedRateDraft(initialRate: number) {
  const [rate,       setRate]       = useState<number | null>(initialRate)
  const [markupText, setMarkupText] = useState(fmtMarkup(initialRate))
  const [marginText, setMarginText] = useState(marginTextOf(initialRate))
  const [invalid,    setInvalid]    = useState<string | null>(null)

  function editMarkup(text: string) {
    setMarkupText(text)
    const r = parseRateInput(text)
    const reason = r == null ? (text.trim() === '' ? null : '数値を入力してください')
      : isValidMarkupRate(r) ? null : '掛け率は 0.01〜9.99 で入力してください'
    if (r != null && reason == null) { setRate(r); setMarginText(marginTextOf(r)); setInvalid(null) }
    else { setRate(null); setMarginText(''); setInvalid(reason) }
  }
  function editMargin(text: string) {
    setMarginText(text)
    const p = parseRateInput(text)
    const r = p != null ? marginRateToMarkup(p / 100) : null
    const reason = p == null ? (text.trim() === '' ? null : '数値を入力してください')
      : p >= 100 ? '粗利率 100% 以上では単価を計算できません'
      : r == null || !isValidMarkupRate(r) ? (p > 0 ? '粗利率は 89.9% 以下で入力してください' : '粗利率が低すぎます（掛け率 0.01 未満）')
      : null
    if (r != null && reason == null) { setRate(r); setMarkupText(fmtMarkup(r)); setInvalid(null) }
    else { setRate(null); setMarkupText(''); setInvalid(reason) }
  }
  return { rate, markupText, marginText, invalid, editMarkup, editMargin }
}

/** 全角数字・全角マイナス・長音符・「%」混じりの入力も数値として解釈する（IME入力対策） */
export function parseRateInput(text: string): number | null {
  const t = text
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．。]/g, '.')
    .replace(/[−－ー‐]/g, '-')
    .replace(/[%％×xX\s]/g, '')
  if (t === '' || t === '-' || t === '.') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function marginTextOf(rate: number): string {
  const m = markupToMarginRate(rate)
  return m != null ? (m * 100).toFixed(1) : ''
}

export function LinkedRateFields({
  draft, onEnter, autoFocus = 'margin',
}: {
  draft: ReturnType<typeof useLinkedRateDraft>
  onEnter: () => void
  autoFocus?: 'markup' | 'margin'
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Escape は popover / dialog 側で閉じるため伝播させる。それ以外は表のキー操作に漏らさない
    if (e.key === 'Escape') return
    e.stopPropagation()
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter() }
  }
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: T.textSub, display: 'block', marginBottom: 4 }
  return (
    <div>
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{ flex: 1 }}>
        <label style={label}>粗利率</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Input
            inputSize="compact" type="text" inputMode="decimal"
            value={draft.marginText}
            onChange={e => draft.editMargin(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={e => e.currentTarget.select()}
            autoFocus={autoFocus === 'margin'}
            aria-label="粗利率（%）"
            className="text-right tabular-nums"
          />
          <span style={{ fontSize: 13, color: T.textSub }}>%</span>
        </div>
      </div>
      <span style={{ fontSize: 13, color: T.textMuted, paddingBottom: 9 }}>⇄</span>
      <div style={{ flex: 1 }}>
        <label style={label}>掛け率</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 13, color: T.textSub }}>×</span>
          <Input
            inputSize="compact" type="text" inputMode="decimal"
            value={draft.markupText}
            onChange={e => draft.editMarkup(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={e => e.currentTarget.select()}
            autoFocus={autoFocus === 'markup'}
            aria-label="掛け率"
            className="text-right tabular-nums"
          />
        </div>
      </div>
      </div>
      {draft.invalid && (
        <p role="alert" style={{ fontSize: 11, color: T.red, margin: '6px 0 0', lineHeight: 1.5 }}>{draft.invalid}</p>
      )}
    </div>
  )
}

// ── 粗利率セル ──────────────────────────────────────────────

export function MarginCell({
  state, onOpen,
}: {
  state: ItemPricingState
  onOpen: (anchor: DOMRect) => void
}) {
  const [hov, setHov] = useState(false)

  if (state.basis === 'no_cost') {
    return (
      <div
        title="原価を入力すると、粗利率と単価を自動計算します"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: '100%', paddingRight: 8 }}
      >
        <span style={{ fontSize: 12, color: T.textMuted, opacity: 0.45, fontFamily: FONT }}>─</span>
      </div>
    )
  }

  // セルには「実際の原価・単価から計算した粗利率」だけを出す。
  // 計算方法（案件標準 / この明細だけ / 手入力）は popover 内で表示する
  const margin = state.actualMargin
  const warn   = margin != null && margin < MARGIN_WARN

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: '100%', paddingRight: 4 }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onOpen(e.currentTarget.getBoundingClientRect()) }}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        title="クリックして粗利率・掛け率を調整"
        aria-label={`粗利率 ${fmtMarginPct(margin)}。クリックして調整`}
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          height: 32, padding: '0 4px', borderRadius: 8,
          border: `1px solid ${hov ? T.divider : 'transparent'}`,
          background: hov ? '#fff' : 'transparent',
          cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
          transition: 'border-color 0.1s, background 0.1s',
        }}
      >
        <span style={{
          padding: '3px 5px', borderRadius: 20,
          fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          background: margin == null ? 'transparent' : warn ? '#FEF2F2' : '#F0FDF4',
          color:      margin == null ? T.textMuted  : warn ? T.red     : T.green,
        }}>
          {fmtMarginPct(margin)}
        </span>
      </button>
    </div>
  )
}

// ── 利益調整 Popover ────────────────────────────────────────

export function ItemPricingPopover({
  anchor, costPrice, sellingPrice, state, projectMarkupRate, onApply, onClose,
}: {
  anchor:            DOMRect
  costPrice:         number
  sellingPrice:      number | null
  state:             ItemPricingState
  projectMarkupRate: number
  /** rate = null は「案件標準に戻す」 */
  onApply:           (rate: number | null) => Promise<void>
  onClose:           () => void
}) {
  const isManual    = state.basis === 'manual'
  // AUTO は設定中の掛け率、MANUAL は実売価から逆算した掛け率を初期値にする（＝表示と一致）
  const initialRate = isManual ? (state.actualMarkup ?? state.configuredRate) : state.configuredRate
  const draft       = useLinkedRateDraft(initialRate)
  const [applying, setApplying] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const nextSelling = draft.rate != null ? calculateSellingPrice(costPrice, draft.rate) : null
  const changed     = nextSelling != null && nextSelling !== sellingPrice
  const projMargin  = markupToMarginRate(projectMarkupRate)
  // いまの計算方法（DB の selling_price_mode / markup_rate_override を利用者の言葉で説明する）
  const modeLabel =
    isManual                     ? '単価を手入力（原価を変えても単価は変わりません）'
    : state.basis === 'override' ? `この明細だけ 粗利 ${fmtMarginPct(markupToMarginRate(state.configuredRate))}（掛け率 ${fmtMarkup(state.configuredRate)}）で自動計算`
    : '案件標準で自動計算'

  // 行は楽観的更新で即時反映されるため、保存完了を待たずに閉じる（古いプレビューを見せない）
  function apply(rate: number | null) {
    if (applying) return
    setApplying(true)
    onClose()
    void onApply(rate)
  }
  function submit() {
    if (draft.rate == null) { setError(draft.invalid ? null : RATE_RANGE_ERROR); return }
    setError(null)
    apply(draft.rate)
  }

  const W = 300
  const H = 360
  const top  = anchor.bottom + 6 + H > window.innerHeight ? Math.max(8, anchor.top - H - 6) : anchor.bottom + 6
  const left = Math.min(Math.max(8, anchor.right - W), window.innerWidth - W - 8)

  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, lineHeight: 1.9 }

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 8998 }} onClick={onClose} />
      <div
        role="dialog"
        aria-label="単価の計算"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
        style={{
          position: 'fixed', top, left, width: W, zIndex: 8999,
          background: '#fff', borderRadius: 12, border: `1px solid ${T.divider}`,
          boxShadow: '0 6px 28px rgba(26,35,50,0.16)', fontFamily: FONT, overflow: 'hidden',
        }}
      >
        {/* 前提：原価と案件標準 */}
        <div style={{ padding: '12px 16px 8px', borderBottom: `1px solid ${T.divider}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>単価の計算</div>
          <div style={row}>
            <span style={{ color: T.textMuted }}>原価</span>
            <span style={{ color: T.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yen(costPrice)}</span>
          </div>
          <div style={row}>
            <span style={{ color: T.textMuted }}>案件標準</span>
            <span style={{ color: T.textSub, fontVariantNumeric: 'tabular-nums' }}>
              粗利 {fmtMarginPct(projMargin)}（掛け率 {fmtMarkup(projectMarkupRate)}）
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.textSub, lineHeight: 1.5, marginTop: 2 }}>
            <span style={{ color: T.textMuted }}>いまの計算：</span>{modeLabel}
          </div>
        </div>

        {/* 変更内容 */}
        <div style={{ padding: '12px 16px' }}>
          <LinkedRateFields
            draft={{ ...draft, editMarkup: t => { setError(null); draft.editMarkup(t) }, editMargin: t => { setError(null); draft.editMargin(t) } }}
            onEnter={submit}
          />
          {error && <p style={{ fontSize: 11, color: T.red, margin: '6px 0 0', lineHeight: 1.5 }}>{error}</p>}
        </div>

        {/* 結果 */}
        <div style={{ margin: '0 16px', padding: '8px 12px', borderRadius: 8, background: T.accentLight }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, color: T.textMuted }}>単価</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {changed && sellingPrice != null && (
                <span style={{ fontSize: 12, color: T.textMuted, textDecoration: 'line-through', marginRight: 6 }}>{yen(sellingPrice)}</span>
              )}
              <span style={{ fontSize: 18, fontWeight: 700, color: changed ? T.blue : T.text }}>
                {nextSelling != null ? yen(nextSelling) : '─'}
              </span>
            </span>
          </div>
          {isManual && (
            <p style={{ fontSize: 10, color: T.textMuted, margin: '2px 0 0', lineHeight: 1.5 }}>
              適用すると、原価からの自動計算に切り替わります。
            </p>
          )}
        </div>

        {/* 操作 */}
        <div style={{ padding: '12px 16px 14px', display: 'flex', gap: 8 }}>
          {state.basis !== 'project' && (
            <Button
              type="button" variant="secondary" size="sm" className="flex-1"
              disabled={applying}
              onClick={() => apply(null)}
              title={`案件標準（粗利 ${fmtMarginPct(projMargin)}）で単価を自動計算します`}
            >
              {isManual ? '自動計算に戻す' : '案件標準に戻す'}
            </Button>
          )}
          <Button
            type="button" variant="primary" size="sm" className="flex-1"
            disabled={draft.rate == null || applying}
            onClick={submit}
          >
            {applying ? '保存中…' : '適用'}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  )
}
