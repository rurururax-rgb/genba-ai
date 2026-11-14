'use client'

/**
 * 「過去見積から追加」ダイアログ。
 * 自社の過去案件の明細を品名で検索 → 複数選択（選んだ順を保つ）→ 追加先の工種を選ぶ → 金額を確認して一括追加。
 *
 * 安全のための決まり:
 * - 追加の実行中は操作を止める（連打・Enter 連打・重複開始を ref でも防ぐ）
 * - 通信エラー・タイムアウト・5xx は「追加できたか不明」。自動で再送せず、見積明細の再取得を案内する
 * - 409（確認後に金額・明細が変わった）は新しい金額を表示し、利用者が確認するまで追加しない
 * - 404（コピー元が使えない）は該当の明細を選択から外し、検索し直してもらう
 * - 備考・社内メモは検索結果で中身を確認できないため、この画面ではコピーしない
 * - 選べるのは検索をまたいで最大 50 件（コピー API の上限）
 * - 選んでいた追加先の工種が消えたら、勝手に「その他」へ変えず、選び直すまで追加させない
 * - 読み込み直し（onReload）が失敗したら閉じない。追加済みなら「追加済み・画面更新に失敗」と分けて案内し、もう一度は追加させない
 * - 古い検索の応答は捨てる（後から届いても結果を上書きしない）
 * - 成功するまで見積に行を足して見せない。成功後は親の reload で DB から読み直す
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  copyFromPast,
  describeCopyPrice,
  formatDate,
  formatYen,
  searchPastEstimates,
  type PastCopyPreview,
  type PastEstimateHit,
  type PriceTone,
} from '@/lib/estimate/past-copy-client'
import { PAST_COPY_MAX_ITEMS } from '@/lib/estimate/past-copy'

const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"
const SEARCH_DEBOUNCE_MS = 350
/** 追加先の工種が消えたときに select に出す、選べない項目の値 */
const MISSING_GROUP = '__missing_group__'

type Hit = PastEstimateHit & { copy_preview: PastCopyPreview }

const TONE: Record<PriceTone, { bg: string; fg: string }> = {
  same:    { bg: '#EAF3DE', fg: '#3B6D11' },
  changed: { bg: '#FFF7ED', fg: '#9A3412' },
  fixed:   { bg: '#EFF6FF', fg: '#1D4ED8' },
  unset:   { bg: '#FEF2F2', fg: '#B91C1C' },
}

type Notice = { tone: 'info' | 'warn' | 'error'; text: string }
/**
 * editing   : 選択・追加できる
 * copying   : 追加の通信中
 * reloading : 見積の読み込み直し中
 * unknown   : 追加できたか不明（読み込み直して確かめるまで追加させない）
 * added     : 追加済みだが、見積の読み込み直しに失敗した（もう一度は追加させない）
 */
type Phase = 'editing' | 'copying' | 'unknown' | 'reloading' | 'added'

const NOTICE_STYLE: Record<Notice['tone'], { bg: string; fg: string; border: string }> = {
  info:  { bg: '#EAF3DE', fg: '#3B6D11', border: '#C9DDB4' },
  warn:  { bg: '#FFFBEB', fg: '#92400E', border: '#FDE68A' },
  error: { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
}

export function PastEstimatePicker({
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
  const [results, setResults] = useState<Hit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null)

  /** 選んだ順 */
  const [selected, setSelected] = useState<Hit[]>([])
  /** 409 で金額が変わり、利用者の確認待ちの明細 */
  const [needsReview, setNeedsReview] = useState<Set<string>>(new Set())
  // 追加先の工種（null = その他）。消えたときの案内に名前を出すため、選んだ時点の名前も持つ。
  // 開いた時点で既定の工種が無ければ「その他」から始める
  const [target, setTarget] = useState<{ id: string; label: string } | null>(() => {
    const g = defaultGroupId ? groups.find(x => x.id === defaultGroupId) : undefined
    return g ? { id: g.id, label: g.label } : null
  })
  const targetGroupId = target?.id ?? null
  // 一度選べた工種があとから消えた（別タブで削除など）。勝手に「その他」へ変えず、選び直してもらう
  const groupMissing = target != null && !groups.some(g => g.id === target.id)
  function chooseGroup(id: string | null) {
    const g = id ? groups.find(x => x.id === id) : undefined
    setTarget(g ? { id: g.id, label: g.label } : null)
  }
  const [phase, setPhase] = useState<Phase>('editing')
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 結果不明・追加済みの後の読み込み直し中（その間も「読み込み直し」の画面を出し続ける） */
  const [retrying, setRetrying] = useState(false)

  const searchSeq = useRef(0)
  /** 最後に検索した語（Enter で検索した直後に、入力待ちの検索が同じ語でもう一度走らないように） */
  const lastIssued = useRef<string | null>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const copyingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => { searchAbort.current?.abort() }, [])

  const busy = phase !== 'editing'

  const runSearch = useCallback(async (raw: string, opts: { skipIfSame?: boolean } = {}) => {
    const q = raw.trim()
    if (opts.skipIfSame && q === (lastIssued.current ?? '')) return
    lastIssued.current = q
    searchAbort.current?.abort()
    const seq = ++searchSeq.current
    if (!q) {
      setResults([]); setHasMore(false); setSearchError(null); setSearchedQuery(null); setSearching(false)
      return
    }
    const controller = new AbortController()
    searchAbort.current = controller
    setSearching(true); setSearchError(null)
    const outcome = await searchPastEstimates(q, projectId, controller.signal)
    // 後から届いた古い検索の応答は捨てる
    if (seq !== searchSeq.current || outcome.kind === 'aborted') return
    setSearching(false)
    if (outcome.kind === 'error') {
      setSearchError(outcome.message)
      return
    }
    setResults(outcome.items.filter((i): i is Hit => i.copy_preview != null))
    setHasMore(outcome.hasMore)
    setSearchedQuery(q)
  }, [projectId])

  // 入力が止まったら検索する（Enter で即時）
  useEffect(() => {
    const t = setTimeout(() => { void runSearch(query, { skipIfSame: true }) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, runSearch])

  const selectedIds = useMemo(() => new Set(selected.map(s => s.id)), [selected])
  const atLimit = selected.length >= PAST_COPY_MAX_ITEMS

  function toggle(hit: Hit) {
    if (busy) return
    const isSelected = selectedIds.has(hit.id)
    if (!isSelected && atLimit) {
      setNotice({ tone: 'warn', text: `一度に追加できるのは ${PAST_COPY_MAX_ITEMS} 件までです。選択を外すと、別の明細を選べます。` })
      return
    }
    setNotice(null)
    setSelected(prev => (prev.some(s => s.id === hit.id)
      ? prev.filter(s => s.id !== hit.id)
      : prev.length >= PAST_COPY_MAX_ITEMS ? prev : [...prev, hit]))
    setNeedsReview(prev => { if (!prev.has(hit.id)) return prev; const n = new Set(prev); n.delete(hit.id); return n })
  }

  function remove(id: string) {
    if (busy) return
    setNotice(null)
    setSelected(prev => prev.filter(s => s.id !== id))
    setNeedsReview(prev => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n })
  }

  const targetLabel = target
    ? (groups.find(g => g.id === target.id)?.label ?? target.label) || '（名称なし）'
    : 'その他'
  const total = selected.reduce((sum, s) => {
    const p = s.copy_preview.new_selling_price
    return p == null ? sum : sum + Math.round((s.quantity ?? 1) * p)
  }, 0)
  const unsetCount = selected.filter(s => s.copy_preview.new_selling_price == null).length
  const canCopy = phase === 'editing' && selected.length > 0 && needsReview.size === 0 && !groupMissing

  /** 親の reload。false・reject は失敗 */
  async function reloadEstimate(): Promise<boolean> {
    try {
      return (await onReload()) !== false
    } catch {
      return false
    }
  }

  async function submit() {
    if (!canCopy || copyingRef.current) return
    copyingRef.current = true
    setPhase('copying'); setNotice(null)
    let keepLocked = false
    try {
      const outcome = await copyFromPast({
        project_id: projectId,
        group_id: targetGroupId,
        items: selected.map(s => ({ source_item_id: s.id, fingerprint: s.copy_preview.fingerprint })),
      })
      switch (outcome.kind) {
        case 'success': {
          keepLocked = true
          setPhase('reloading')
          setNotice({ tone: 'info', text: `${outcome.count}件を「${targetLabel}」に追加しました。見積を読み込み直しています…` })
          if (await reloadEstimate()) { onClose(); return }
          setPhase('added')
          setNotice({ tone: 'warn', text: `${outcome.count}件は追加済みです。ただし見積の画面を更新できませんでした。「見積を読み込み直す」を押してください（もう一度追加すると二重になります）。` })
          return
        }
        case 'changed': {
          // 新しい金額だけでなく、いまの原価・数量なども表示に反映する（古い原価と新しい売価を並べない）
          const byId = new Map(outcome.changed.map(c => [c.source_item_id, c]))
          const apply = (h: Hit): Hit => {
            const c = byId.get(h.id)
            return c ? { ...h, ...(c.item ?? {}), copy_preview: c.copy_preview } : h
          }
          setSelected(prev => prev.map(apply))
          setResults(prev => prev.map(apply))
          setNeedsReview(new Set(byId.keys()))
          setNotice({ tone: 'warn', text: `確認したあとに ${byId.size} 件の金額または内容が変わりました。新しい金額を確認してから追加してください（まだ追加していません）。` })
          return
        }
        case 'missing': {
          const gone = new Set(outcome.ids)
          const names = selected.filter(s => gone.has(s.id)).map(s => `「${s.name}」`).join('、')
          setSelected(prev => prev.filter(s => !gone.has(s.id)))
          setResults(prev => prev.filter(s => !gone.has(s.id)))
          setNotice({ tone: 'error', text: `${names || `${gone.size}件`} は削除・変更されたため追加できません。選択から外しました。必要なら検索し直してください（まだ追加していません）。` })
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
      if (!keepLocked) { setPhase('editing'); copyingRef.current = false }
    }
  }

  /** 結果不明・追加済みの後の読み込み直し。失敗したら閉じず、同じ状態のまま再試行できるようにする */
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
    if (phase === 'copying' || phase === 'reloading') return
    onClose()
  }

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      // 背景のクリックで閉じるのは、何も選んでいないときだけ（選んだ明細を誤って失わない）
      onMouseDown={e => { if (e.target === e.currentTarget && selected.length === 0) requestClose() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); requestClose() } }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="past-estimate-picker-title"
        aria-busy={busy}
        className="flex w-full max-w-[1040px] flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_8px_40px_rgba(26,35,50,0.18)]"
        style={{ maxHeight: 'calc(100dvh - 24px)', fontFamily: FONT, color: '#1A2E24' }}
      >
        {/* ヘッダー */}
        <div className="flex items-start justify-between gap-3 border-b border-[#E4E8E5] px-4 py-3 sm:px-5">
          <div>
            <h2 id="past-estimate-picker-title" className="m-0 text-base font-bold">過去見積から追加</h2>
            <p className="m-0 mt-0.5 text-xs text-[#7A9185]">自社の過去案件の明細を探して、この見積に追加します。備考・社内メモはコピーしません。</p>
          </div>
          <Button type="button" variant="tertiary" size="icon" aria-label="閉じる" onClick={requestClose} disabled={phase === 'copying' || phase === 'reloading'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </div>

        {/* 検索 */}
        <div className="flex gap-2 border-b border-[#E4E8E5] px-4 py-3 sm:px-5">
          <Input
            ref={inputRef}
            type="search"
            inputSize="compact"
            value={query}
            maxLength={50}
            placeholder="品名で検索（例：キッチン　交換）"
            aria-label="品名で検索"
            disabled={busy}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              // 日本語変換の確定 Enter は検索として扱わない
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void runSearch(query) }
            }}
          />
          <Button type="button" variant="secondary" size="sm" className="h-9 shrink-0" disabled={busy} onClick={() => void runSearch(query)}>
            検索
          </Button>
        </div>

        {/* 本体：結果（左）と選択中（右）。狭い画面では縦に並べる */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
          <section aria-label="検索結果" className="min-h-0 md:overflow-auto">
            <SearchResults
              results={results}
              searching={searching}
              searchError={searchError}
              searchedQuery={searchedQuery}
              hasMore={hasMore}
              selectedIds={selectedIds}
              needsReview={needsReview}
              disabled={busy}
              atLimit={atLimit}
              onToggle={toggle}
            />
          </section>

          <section aria-label="選択中の明細" className="flex min-h-0 flex-col border-t border-[#E4E8E5] bg-[#F8FAF8] md:border-l md:border-t-0">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <span className="text-[13px] font-bold">選択中 {selected.length} 件<span className="ml-1 text-[11px] font-normal text-[#7A9185]">（最大 {PAST_COPY_MAX_ITEMS} 件）</span></span>
              {selected.length > 0 && <span className="text-[11px] text-[#7A9185]">この順に追加します</span>}
            </div>
            {atLimit && (
              <p className="m-0 px-4 pb-1 text-[11px] font-semibold text-[#92400E]">上限の {PAST_COPY_MAX_ITEMS} 件に達しました。外すと別の明細を選べます。</p>
            )}
            <ol className="m-0 min-h-[56px] list-none space-y-1.5 px-3 pb-2 md:flex-1 md:overflow-auto">
              {selected.length === 0 && (
                <li className="px-1 py-3 text-xs text-[#7A9185]">左の検索結果から追加したい明細を選んでください。</li>
              )}
              {selected.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2 rounded-lg border border-[#E4E8E5] bg-white px-2.5 py-2">
                  <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-[#2B5E40] px-1 text-[11px] font-bold text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold" title={s.name}>{s.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="tabular-nums">{formatYen(s.copy_preview.new_selling_price)}</span>
                      <PriceBadge preview={s.copy_preview} />
                      {needsReview.has(s.id) && <span className="rounded bg-[#FFFBEB] px-1.5 py-0.5 text-[11px] font-bold text-[#92400E]">金額が変わりました</span>}
                    </div>
                  </div>
                  <Button type="button" variant="tertiary" size="icon" className="shrink-0" aria-label={`${s.name} を選択から外す`} disabled={busy} onClick={() => remove(s.id)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </Button>
                </li>
              ))}
            </ol>

            <div className="space-y-2 border-t border-[#E4E8E5] px-4 py-3">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.04em] text-[#47564E]" htmlFor="past-estimate-target">追加先の工種</label>
              <select
                id="past-estimate-target"
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
              {selected.length > 0 && (
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-[#47564E]">追加する金額の合計（参考）</span>
                  <span className="text-sm font-bold tabular-nums">{formatYen(total)}</span>
                </div>
              )}
              {unsetCount > 0 && (
                <p className="m-0 text-[11px] font-semibold text-[#B91C1C]">売価なしの明細が {unsetCount} 件あります（合計に含みません）。追加後に売価を入力してください。</p>
              )}
            </div>
          </section>
        </div>

        {/* お知らせ・操作 */}
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
                  <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={requestClose}>
                    閉じる
                  </Button>
                )}
                <Button type="button" variant="primary" className="w-full sm:w-auto" disabled={phase === 'reloading'} onClick={() => void retryReload()}>
                  {phase === 'reloading' ? '読み込み直しています…' : phase === 'added' ? '見積を読み込み直す' : '見積明細を読み込み直して確認する'}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={requestClose} disabled={phase === 'copying' || phase === 'reloading'}>
                  キャンセル
                </Button>
                {needsReview.size > 0 && phase === 'editing' && (
                  <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={() => { setNeedsReview(new Set()); setNotice(null) }}>
                    新しい金額を確認しました
                  </Button>
                )}
                <Button type="button" variant="primary" className="w-full sm:w-auto" disabled={!canCopy} onClick={() => void submit()}>
                  {phase === 'copying' ? '追加しています…'
                    : phase === 'reloading' ? '読み込み直しています…'
                    : selected.length === 0 ? '明細を選んでください'
                    : groupMissing ? '追加先の工種を選び直してください'
                    : `選んだ ${selected.length} 件を「${targetLabel}」に追加`}
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

function PriceBadge({ preview }: { preview: PastCopyPreview }) {
  const d = describeCopyPrice(preview)
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] font-bold" style={{ background: TONE[d.tone].bg, color: TONE[d.tone].fg }} title={d.detail}>
      {d.badge}
    </span>
  )
}

function SearchResults({
  results, searching, searchError, searchedQuery, hasMore, selectedIds, needsReview, disabled, atLimit, onToggle,
}: {
  results: Hit[]
  searching: boolean
  searchError: string | null
  searchedQuery: string | null
  hasMore: boolean
  selectedIds: Set<string>
  needsReview: Set<string>
  disabled: boolean
  /** 選択が上限に達している（未選択の明細は選べない。選択済みは外せる） */
  atLimit: boolean
  onToggle: (hit: Hit) => void
}) {
  if (searchError) return <p role="alert" className="m-0 px-5 py-6 text-[13px] text-[#B91C1C]">{searchError}</p>
  if (searchedQuery == null && !searching) {
    return <p className="m-0 px-5 py-6 text-[13px] text-[#7A9185]">品名を入力すると、自社の過去案件の明細を新しい順に表示します。</p>
  }
  if (results.length === 0) {
    return <p className="m-0 px-5 py-6 text-[13px] text-[#7A9185]">{searching ? '検索しています…' : `「${searchedQuery}」に一致する過去の明細はありません。`}</p>
  }
  return (
    <div aria-busy={searching}>
      <ul className="m-0 list-none divide-y divide-[#EEF2EF] p-0">
        {results.map(hit => {
          const checked = selectedIds.has(hit.id)
          const p = hit.copy_preview
          const d = describeCopyPrice(p)
          return (
            <li key={hit.id}>
              <label
                className={`flex min-h-[44px] cursor-pointer items-start gap-3 px-4 py-2.5 sm:px-5 ${checked ? 'bg-[#F3F7F4]' : 'hover:bg-[#F8FAF8]'} ${disabled || (atLimit && !checked) ? 'cursor-not-allowed' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-[#2B5E40]"
                  checked={checked}
                  disabled={disabled || (atLimit && !checked)}
                  onChange={() => onToggle(hit)}
                  aria-label={`${hit.name}（${hit.project.name}）を選ぶ`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-semibold">{hit.name}</span>
                    {needsReview.has(hit.id) && <span className="rounded bg-[#FFFBEB] px-1.5 py-0.5 text-[11px] font-bold text-[#92400E]">金額が変わりました</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[#7A9185]">
                    {hit.project.name}・{formatDate(hit.created_at)}・{hit.group?.label || 'その他'}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[#47564E]" data-testid="past-hit-vendor">
                    業者 {hit.vendor_name || '—'}・分類 {hit.category || '—'}
                  </div>
                  <dl className="m-0 mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular-nums sm:grid-cols-4">
                    <Field label="数量">{hit.quantity ?? 1} {hit.unit ?? '式'}</Field>
                    <Field label="原価">{formatYen(hit.cost_price)}</Field>
                    <Field label="過去の売価">{formatYen(p.past_selling_price)}</Field>
                    <Field label="追加後の売価"><strong>{formatYen(p.new_selling_price)}</strong></Field>
                  </dl>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <PriceBadge preview={p} />
                    <span className="text-[11px] text-[#7A9185]">{d.detail}</span>
                  </div>
                </div>
              </label>
            </li>
          )
        })}
      </ul>
      {hasMore && <p className="m-0 px-5 py-3 text-[11px] text-[#7A9185]">さらに古い明細があります。語を足して絞り込んでください。</p>}
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
