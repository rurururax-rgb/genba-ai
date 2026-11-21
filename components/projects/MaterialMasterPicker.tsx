'use client'

/**
 * 「資材マスターから追加」ダイアログ（PR-1: 1 件ずつ追加）。
 * 自社の資材マスターを品名で検索 → 1 件選ぶ → 追加先の工種・数量・原価・売価を確認 → 見積に追加。
 *
 * 安全のための決まり（過去見積から追加と同じ）:
 * - 追加の実行中は操作を止める（連打・Enter 連打・重複開始を ref でも防ぐ）
 * - 通信エラー・タイムアウト・5xx は「追加できたか不明」。自動で再送せず、見積明細の再取得を案内する
 * - 409（画面に出した後にマスターか掛け率が変わった）はいまの内容を「前 → 後」で見せ、確認するまで追加しない
 * - 選んでいた追加先の工種が消えたら、勝手に「その他」へ変えず、選び直すまで追加させない
 * - 読み込み直し（onReload）が失敗したら閉じない。追加済みなら「追加済み・画面更新に失敗」と分けて案内し、もう一度は追加させない
 * - 古い検索の応答は捨てる
 * - 成功するまで見積に行を足して見せない。成功後は親の reload で DB から読み直す
 * - 掛け率で計算する売価はここでは表示用。保存する売価はサーバーが同じ計算（lib/estimate/pricing.ts）で決める
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addFromMaster, searchMasterItems, type MasterItemHit } from '@/lib/estimate/master-copy-client'
import { formatYen } from '@/lib/estimate/past-copy-client'
import { MASTER_MAX_PRICE, MASTER_MAX_QUANTITY, masterLineAmount, resolveMasterSellingPrice } from '@/lib/estimate/master-copy'
import { parseNumericInput } from '@/lib/input/numeric-input'
import type { SellingPriceMode } from '@/lib/estimate/pricing'

const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const SEARCH_DEBOUNCE_MS = 350
const MISSING_GROUP = '__missing_group__'

type Notice = { tone: 'info' | 'warn' | 'error'; text: string }
/**
 * editing   : 選択・入力・追加できる
 * adding    : 追加の通信中
 * reloading : 見積の読み込み直し中
 * unknown   : 追加できたか不明（読み込み直して確かめるまで追加させない）
 * added     : 追加済みだが、見積の読み込み直しに失敗した（もう一度は追加させない）
 */
type Phase = 'editing' | 'adding' | 'unknown' | 'reloading' | 'added'

const NOTICE_STYLE: Record<Notice['tone'], { bg: string; fg: string; border: string }> = {
  info:  { bg: '#EAF3DE', fg: '#3B6D11', border: '#C9DDB4' },
  warn:  { bg: '#FFFBEB', fg: '#92400E', border: '#FDE68A' },
  error: { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
}

/** 入力欄の文字列（全角・桁区切り・¥ を受け付ける） */
type Draft = { quantity: string; cost: string; selling: string; mode: SellingPriceMode }

function draftFrom(hit: MasterItemHit, quantity = '1'): Draft {
  return {
    quantity,
    cost: hit.preview.cost_price != null ? String(hit.preview.cost_price) : '',
    selling: hit.preview.selling_price_mode === 'manual' && hit.preview.selling_price != null ? String(hit.preview.selling_price) : '',
    mode: hit.preview.selling_price_mode,
  }
}

/** 入力の解釈。数量は 0 より大きい数、原価は空欄（なし）か 0 以上、manual の売価は 0 以上（必須） */
function readDraft(d: Draft) {
  const quantity = parseNumericInput(d.quantity)
  const cost = d.cost.trim() === '' ? null : parseNumericInput(d.cost)
  const selling = d.selling.trim() === '' ? null : parseNumericInput(d.selling)
  const errors: string[] = []
  if (quantity == null || quantity <= 0 || quantity > MASTER_MAX_QUANTITY) errors.push('数量は 0 より大きい数で入力してください')
  if (d.cost.trim() !== '' && (cost == null || cost < 0 || cost >= MASTER_MAX_PRICE)) errors.push('原価は 0 以上の数で入力してください（なしは空欄）')
  if (d.mode === 'manual' && (selling == null || selling < 0 || selling >= MASTER_MAX_PRICE)) errors.push('売価を 0 以上の数で入力してください')
  return { quantity, cost, selling, errors }
}

export function MaterialMasterPicker({
  projectId, groups, defaultGroupId, onReload, onClose,
}: {
  projectId: string
  /** 追加先に選べる工種（この案件の有効な工種）。null（その他）は常に選べる */
  groups: Array<{ id: string; label: string }>
  defaultGroupId: string | null
  /** 見積明細を DB から読み直す（成功後・結果不明時）。明細を取得できなければ false（または reject） */
  onReload: () => Promise<boolean>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MasterItemHit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState('')

  const [selected, setSelected] = useState<MasterItemHit | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  /** 409 で内容が変わったときの、変わる前の内容（確認するまで追加させない） */
  const [review, setReview] = useState<MasterItemHit | null>(null)

  const [target, setTarget] = useState<{ id: string; label: string } | null>(() => {
    const g = defaultGroupId ? groups.find(x => x.id === defaultGroupId) : undefined
    return g ? { id: g.id, label: g.label } : null
  })
  const targetGroupId = target?.id ?? null
  const groupMissing = target != null && !groups.some(g => g.id === target.id)
  function chooseGroup(id: string | null) {
    const g = id ? groups.find(x => x.id === id) : undefined
    setTarget(g ? { id: g.id, label: g.label } : null)
  }

  const [phase, setPhase] = useState<Phase>('editing')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [retrying, setRetrying] = useState(false)

  const searchSeq = useRef(0)
  const lastIssued = useRef<string | null>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const addingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => { searchAbort.current?.abort() }, [])

  const busy = phase !== 'editing'

  const runSearch = useCallback(async (raw: string, opts: { skipIfSame?: boolean } = {}) => {
    const q = raw.trim()
    if (opts.skipIfSame && q === lastIssued.current) return
    lastIssued.current = q
    searchAbort.current?.abort()
    const seq = ++searchSeq.current
    const controller = new AbortController()
    searchAbort.current = controller
    setSearching(true); setSearchError(null)
    const outcome = await searchMasterItems(q, projectId, controller.signal)
    if (seq !== searchSeq.current || outcome.kind === 'aborted') return
    setSearching(false)
    if (outcome.kind === 'error') { setSearchError(outcome.message); return }
    setResults(outcome.items)
    setHasMore(outcome.hasMore)
    setSearched(true)
    setSearchedQuery(q)
  }, [projectId])

  // 開いたらよく使う順の一覧を出し、入力が止まったら検索する（Enter で即時）
  useEffect(() => {
    const t = setTimeout(() => { void runSearch(query, { skipIfSame: true }) }, lastIssued.current == null ? 0 : SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, runSearch])

  function choose(hit: MasterItemHit) {
    if (busy) return
    setNotice(null)
    setReview(null)
    setSelected(hit)
    setDraft(draftFrom(hit))
  }

  const parsed = draft ? readDraft(draft) : null
  const markupRate = selected?.preview.markup_rate ?? null
  const previewSelling = draft && parsed
    ? resolveMasterSellingPrice(draft.mode, parsed.cost, parsed.selling, markupRate)
    : null
  const amount = parsed ? masterLineAmount(parsed.quantity, previewSelling) : null
  const targetLabel = target
    ? (groups.find(g => g.id === target.id)?.label ?? target.label) || '（名称なし）'
    : 'その他'
  const canAdd = phase === 'editing' && selected != null && parsed != null && parsed.errors.length === 0
    && review == null && !groupMissing

  async function reloadEstimate(): Promise<boolean> {
    try {
      return (await onReload()) !== false
    } catch {
      return false
    }
  }

  async function submit() {
    if (!canAdd || addingRef.current || !selected || !draft || !parsed) return
    addingRef.current = true
    setPhase('adding'); setNotice(null)
    let keepLocked = false
    try {
      const outcome = await addFromMaster({
        project_id: projectId,
        group_id: targetGroupId,
        master_item_id: selected.id,
        fingerprint: selected.preview.fingerprint,
        quantity: parsed.quantity!,
        cost_price: parsed.cost,
        selling_price_mode: draft.mode,
        ...(draft.mode === 'manual' ? { selling_price: parsed.selling! } : {}),
      })
      switch (outcome.kind) {
        case 'success': {
          keepLocked = true
          setPhase('reloading')
          setNotice({ tone: 'info', text: `「${selected.name}」を「${targetLabel}」に追加しました。見積を読み込み直しています…` })
          if (await reloadEstimate()) { onClose(); return }
          setPhase('added')
          setNotice({ tone: 'warn', text: `「${selected.name}」は追加済みです。ただし見積の画面を更新できませんでした。「見積を読み込み直す」を押してください（もう一度追加すると二重になります）。` })
          return
        }
        case 'changed': {
          // いまのマスターの内容と初期値に入れ替え、確認するまで追加させない（数量はそのまま）
          setReview(selected)
          setSelected(outcome.item)
          setDraft(draftFrom(outcome.item, draft.quantity))
          setResults(prev => prev.map(r => (r.id === outcome.item.id ? outcome.item : r)))
          setNotice({ tone: 'warn', text: `${outcome.message}（まだ追加していません）` })
          return
        }
        case 'missing': {
          setResults(prev => prev.filter(r => r.id !== selected.id))
          setSelected(null); setDraft(null)
          setNotice({ tone: 'error', text: `${outcome.message}（まだ追加していません）` })
          return
        }
        case 'rejected':
          setNotice({ tone: 'error', text: `${outcome.message}（まだ追加していません）` })
          return
        case 'unknown':
          keepLocked = true
          setPhase('unknown')
          setNotice({ tone: 'warn', text: outcome.message })
          return
      }
    } finally {
      if (!keepLocked) { setPhase('editing'); addingRef.current = false }
    }
  }

  async function retryReload() {
    if (phase !== 'unknown' && phase !== 'added') return
    const from = phase
    setPhase('reloading'); setRetrying(true)
    const ok = await reloadEstimate()
    setRetrying(false)
    if (ok) { onClose(); return }
    setPhase(from)
    setNotice(from === 'added'
      ? { tone: 'error', text: '追加は完了していますが、見積の読み込み直しに失敗しました。通信を確認して、もう一度「見積を読み込み直す」を押してください（もう一度追加しないでください）。' }
      : { tone: 'error', text: '見積の読み込み直しに失敗したため、追加できたか確かめられませんでした。通信を確認して、もう一度読み込み直してください（もう一度追加しないでください）。' })
  }

  function requestClose() {
    if (phase === 'adding' || phase === 'reloading') return
    onClose()
  }

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(d => (d ? { ...d, [key]: value } : d))
  }

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      // 背景のクリックで閉じるのは、何も選んでいないときだけ（入力した内容を誤って失わない）
      onMouseDown={e => { if (e.target === e.currentTarget && selected == null) requestClose() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); requestClose() } }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="material-master-picker-title"
        aria-busy={busy}
        className="flex w-full max-w-[1040px] flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_8px_40px_rgba(26,35,50,0.18)]"
        style={{ maxHeight: 'calc(100dvh - 24px)', fontFamily: FONT, color: '#1A2E24' }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E4E8E5] px-4 py-3 sm:px-5">
          <div>
            <h2 id="material-master-picker-title" className="m-0 text-base font-bold">資材マスターから追加</h2>
            <p className="m-0 mt-0.5 text-xs text-[#7A9185]">自社の資材マスターから 1 件選び、数量・原価・売価を確認して見積に追加します。資材マスターは変わりません。</p>
          </div>
          <Button type="button" variant="tertiary" size="icon" aria-label="閉じる" onClick={requestClose} disabled={phase === 'adding' || phase === 'reloading'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </div>

        <div className="flex gap-2 border-b border-[#E4E8E5] px-4 py-3 sm:px-5">
          <Input
            ref={inputRef}
            type="search"
            inputSize="compact"
            value={query}
            maxLength={50}
            placeholder="品名で検索（例：ユニットバス）。空欄ならよく使う順"
            aria-label="資材を品名で検索"
            disabled={busy}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void runSearch(query) }
            }}
          />
          <Button type="button" variant="secondary" size="sm" className="h-9 shrink-0" disabled={busy} onClick={() => void runSearch(query)}>
            検索
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(0,1fr)_360px] md:overflow-hidden">
          <section aria-label="資材の検索結果" className="min-h-0 md:overflow-auto">
            <MasterResults
              results={results}
              searching={searching}
              searchError={searchError}
              searched={searched}
              query={searchedQuery}
              hasMore={hasMore}
              selectedId={selected?.id ?? null}
              disabled={busy}
              onChoose={choose}
            />
          </section>

          <section aria-label="追加する内容" className="flex flex-col border-t border-[#E4E8E5] bg-[#F8FAF8] md:min-h-0 md:border-l md:border-t-0">
            <div className="space-y-3 px-4 py-3 md:min-h-0 md:flex-1 md:overflow-auto">
              {!selected || !draft || !parsed ? (
                <p className="m-0 py-3 text-xs text-[#7A9185]">左の一覧から追加する資材を選んでください。</p>
              ) : (
                <>
                  {review && (
                    <ReviewCard before={review} after={selected} disabled={busy} onConfirm={() => { setReview(null); setNotice(null) }} />
                  )}
                  <div>
                    <div className="text-[13px] font-bold" data-testid="master-selected-name">{selected.name}</div>
                    <div className="mt-0.5 text-[11px] text-[#7A9185]">
                      {selected.spec ? `仕様 ${selected.spec}・` : ''}単位 {selected.unit || '式'}{selected.category ? `・分類 ${selected.category}` : ''}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <NumField id="master-qty" label={`数量（${selected.unit || '式'}）`} value={draft.quantity} disabled={busy} onChange={v => setField('quantity', v)} />
                    <NumField id="master-cost" label="原価（単価）" value={draft.cost} placeholder="なし" disabled={busy} onChange={v => setField('cost', v)} />
                  </div>

                  <fieldset className="m-0 space-y-1.5 border-0 p-0" disabled={busy}>
                    <legend className="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#47564E]">売価（単価）の決め方</legend>
                    <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-[13px]">
                      <input type="radio" name="master-mode" className="h-4 w-4 accent-[#2B5E40]" checked={draft.mode === 'auto'} onChange={() => setField('mode', 'auto')} />
                      原価 × この案件の掛け率 {markupRate}
                    </label>
                    <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="radio" name="master-mode" className="h-4 w-4 accent-[#2B5E40]" checked={draft.mode === 'manual'}
                        onChange={() => setDraft(d => (d ? { ...d, mode: 'manual', selling: d.selling || (selected.selling_price != null ? String(selected.selling_price) : '') } : d))}
                      />
                      売価を固定する{selected.selling_price != null && selected.selling_price > 0 ? `（マスターの売価 ${formatYen(selected.selling_price)}）` : ''}
                    </label>
                    {draft.mode === 'manual' && (
                      <NumField id="master-selling" label="売価（単価）" value={draft.selling} disabled={busy} onChange={v => setField('selling', v)} />
                    )}
                  </fieldset>

                  <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-lg border border-[#E4E8E5] bg-white px-3 py-2 text-[13px] tabular-nums">
                    <dt className="text-[#7A9185]">売価（単価）</dt>
                    <dd className="m-0 text-right font-semibold" data-testid="master-preview-selling">{formatYen(previewSelling)}</dd>
                    <dt className="text-[#7A9185]">金額</dt>
                    <dd className="m-0 text-right text-[15px] font-bold" data-testid="master-preview-amount">{formatYen(amount)}</dd>
                  </dl>
                  {draft.mode === 'auto' && previewSelling == null && parsed.errors.length === 0 && (
                    <p className="m-0 text-[11px] font-semibold text-[#B91C1C]">原価がないため売価を計算できません。このまま追加すると売価なしになります（追加後に入力できます）。</p>
                  )}
                  {parsed.errors.length > 0 && (
                    <ul role="alert" className="m-0 list-none space-y-0.5 p-0 text-[11px] font-semibold text-[#B91C1C]">
                      {parsed.errors.map(e => <li key={e}>{e}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>

            <div className="space-y-2 border-t border-[#E4E8E5] px-4 py-3">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.04em] text-[#47564E]" htmlFor="material-master-target">追加先の工種</label>
              <select
                id="material-master-target"
                value={groupMissing ? MISSING_GROUP : (targetGroupId ?? '')}
                disabled={busy}
                aria-invalid={groupMissing}
                onChange={e => { if (e.target.value !== MISSING_GROUP) chooseGroup(e.target.value || null) }}
                className="h-11 w-full cursor-pointer rounded-[8px] border border-[#D5DED8] bg-white px-[10px] text-sm text-[#1A2E24] outline-none hover:border-[#AFC4B5] focus:border-[#2B5E40] focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] disabled:cursor-not-allowed disabled:border-[#E4E8EE] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF]"
              >
                {groupMissing && <option value={MISSING_GROUP} disabled>（見つからない工種）選び直してください</option>}
                {groups.map(g => <option key={g.id} value={g.id}>{g.label || '（名称なし）'}</option>)}
                <option value="">その他（未分類）</option>
              </select>
              {groupMissing && (
                <p role="alert" className="m-0 text-[11px] font-semibold text-[#B91C1C]">
                  追加先の工種「{targetLabel}」が見つかりません（削除された可能性があります）。追加先を選び直してください。
                </p>
              )}
              <p className="m-0 text-[11px] text-[#7A9185]">選んだ工種の末尾に追加します。既存の行の並びは変わりません。</p>
            </div>
          </section>
        </div>

        <div className="space-y-2 border-t border-[#E4E8E5] px-4 py-3 sm:px-5">
          {notice && (
            <div
              role={notice.tone === 'info' ? 'status' : 'alert'}
              className="rounded-lg border px-3 py-2 text-[13px] leading-relaxed"
              style={{ background: NOTICE_STYLE[notice.tone].bg, color: NOTICE_STYLE[notice.tone].fg, borderColor: NOTICE_STYLE[notice.tone].border }}
            >
              {notice.text}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            {phase === 'unknown' || phase === 'added' || retrying ? (
              <>
                {phase === 'added' && (
                  <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={requestClose}>閉じる</Button>
                )}
                <Button type="button" variant="primary" className="w-full sm:w-auto" disabled={phase === 'reloading'} onClick={() => void retryReload()}>
                  {phase === 'reloading' ? '読み込み直しています…' : phase === 'added' ? '見積を読み込み直す' : '見積明細を読み込み直して確認する'}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={requestClose} disabled={phase === 'adding' || phase === 'reloading'}>
                  キャンセル
                </Button>
                <Button type="button" variant="primary" className="w-full sm:w-auto" disabled={!canAdd} onClick={() => void submit()}>
                  {phase === 'adding' ? '追加しています…'
                    : phase === 'reloading' ? '読み込み直しています…'
                    : !selected ? '資材を選んでください'
                    : groupMissing ? '追加先の工種を選び直してください'
                    : review ? '変更内容を確認してください'
                    : `「${targetLabel}」に追加`}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function NumField({ id, label, value, placeholder, disabled, onChange }: {
  id: string; label: string; value: string; placeholder?: string; disabled: boolean; onChange: (v: string) => void
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-[#47564E]">{label}</label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        inputSize="compact"
        className="text-right tabular-nums"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

/** 409 で変わった内容の「前 → 後」。確認ボタンで承認する */
function ReviewCard({ before, after, disabled, onConfirm }: { before: MasterItemHit; after: MasterItemHit; disabled: boolean; onConfirm: () => void }) {
  const rows: Array<[string, string, string]> = [
    ['品名', before.name, after.name],
    ['仕様', before.spec || '—', after.spec || '—'],
    ['単位', before.unit || '式', after.unit || '式'],
    ['原価', formatYen(before.cost_price), formatYen(after.cost_price)],
    ['マスター売価', formatYen(before.selling_price), formatYen(after.selling_price)],
    ['掛け率', String(before.preview.markup_rate), String(after.preview.markup_rate)],
  ]
  return (
    <div role="region" aria-label="変更された内容" className="rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-2.5" data-testid="master-review-card">
      <div className="mb-1 text-[12px] font-bold text-[#92400E]">資材マスターか掛け率が変わりました。原価・売価を初期値に戻しました</div>
      <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs tabular-nums">
        {rows.map(([label, b, a]) => (
          <React.Fragment key={label}>
            <dt className="text-[#7A9185]">{label}</dt>
            <dd className="m-0 min-w-0 break-words" data-changed={b !== a ? 'true' : undefined}>
              {b !== a
                ? <><span className="text-[#9CA3AF] line-through">{b}</span><span className="mx-1 text-[#9CA3AF]">→</span><strong className="text-[#9A3412]">{a}</strong></>
                : a}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="mt-1.5 flex justify-end">
        <Button type="button" variant="secondary" disabled={disabled} onClick={onConfirm}>この内容で確認しました</Button>
      </div>
    </div>
  )
}

function MasterResults({
  results, searching, searchError, searched, query, hasMore, selectedId, disabled, onChoose,
}: {
  results: MasterItemHit[]
  searching: boolean
  searchError: string | null
  searched: boolean
  query: string
  hasMore: boolean
  selectedId: string | null
  disabled: boolean
  onChoose: (hit: MasterItemHit) => void
}) {
  if (searchError) return <p role="alert" className="m-0 px-5 py-6 text-[13px] text-[#B91C1C]">{searchError}</p>
  if (results.length === 0) {
    return (
      <p className="m-0 px-5 py-6 text-[13px] text-[#7A9185]">
        {searching || !searched ? '読み込んでいます…'
          : query ? `「${query}」に一致する資材はありません。`
          : '資材マスターに登録された資材がありません。'}
      </p>
    )
  }
  return (
    <div aria-busy={searching}>
      <ul className="m-0 list-none divide-y divide-[#EEF2EF] p-0">
        {results.map(hit => {
          const checked = hit.id === selectedId
          return (
            <li key={hit.id}>
              <label className={`flex min-h-[44px] cursor-pointer items-start gap-3 px-4 py-2.5 sm:px-5 ${checked ? 'bg-[#F3F7F4]' : 'hover:bg-[#F8FAF8]'} ${disabled ? 'cursor-not-allowed' : ''}`}>
                <input
                  type="radio"
                  name="master-item"
                  className="mt-1 h-5 w-5 shrink-0 accent-[#2B5E40]"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChoose(hit)}
                  aria-label={`${hit.name} を選ぶ`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{hit.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-[#7A9185]" data-testid="master-hit-spec">
                    仕様 {hit.spec || '—'}{hit.category ? `・分類 ${hit.category}` : ''}
                  </div>
                  <dl className="m-0 mt-1.5 grid grid-cols-3 gap-x-3 text-xs tabular-nums">
                    <Field label="単位">{hit.unit || '式'}</Field>
                    <Field label="原価">{formatYen(hit.cost_price)}</Field>
                    <Field label="売価">{formatYen(hit.selling_price)}</Field>
                  </dl>
                </div>
              </label>
            </li>
          )
        })}
      </ul>
      {hasMore && <p className="m-0 px-5 py-3 text-[11px] text-[#7A9185]">ほかにも資材があります。品名で絞り込んでください。</p>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="shrink-0 text-[#7A9185]">{label}</dt>
      <dd className="m-0 truncate">{children}</dd>
    </div>
  )
}
