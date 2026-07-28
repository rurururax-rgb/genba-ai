'use client'

import { useEffect, useRef, useState } from 'react'
import { getClient } from '@/lib/supabase/client'
import { CATEGORY_COLORS } from '@/lib/estimate/categories'

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

type Candidate = {
  id: string; category: string; name: string; unit: string
  cost_price: number | null; selling_price: number | null
  memo: string | null; usage_count: number; last_used_at: string; similarity: number
}

type MatchedItem = {
  term:      string
  quantity:  number | null
  unit:      string | null
  detail:    string | null
  candidates: Candidate[]
}

type LineEvent = {
  id: string
  event_type: 'text' | 'image' | 'audio'
  raw_content: string | null
  storage_path: string | null
  project_id: string | null
  received_at: string
  extracted_terms: MatchedItem[] | string[] | null
  matched_items: MatchedItem[] | null
  reflected_to_estimate: boolean
  is_processed: boolean
}

// ──────────────────────────────────────────────────────────
// quantity / memo 解決ロジック
// ──────────────────────────────────────────────────────────

const MEASURABLE_UNITS = new Set(['㎡', '㎥', '坪', 'm'])

function resolveQuantityAndMemo(
  candidateUnit: string,
  voiceQty:      number | null,
  voiceUnit:     string | null,
  voiceDetail:   string | null,
): { quantity: number | null; memo: string | null } {
  const hasQtyInfo = voiceQty != null || voiceUnit != null
  if (!hasQtyInfo && voiceDetail == null) return { quantity: null, memo: null }
  const qtyStr = hasQtyInfo ? `${voiceQty ?? ''}${voiceUnit ?? ''}`.trim() : ''
  let quantityToUse: number | null = null
  let includeQtyInMemo = false
  if (hasQtyInfo) {
    if (candidateUnit === '式') {
      includeQtyInMemo = true
    } else if (MEASURABLE_UNITS.has(candidateUnit) && voiceUnit === candidateUnit && voiceQty != null) {
      quantityToUse = voiceQty
    } else {
      includeQtyInMemo = true
    }
  }
  const memoParts: string[] = []
  if (includeQtyInMemo && qtyStr) memoParts.push(qtyStr)
  if (voiceDetail) memoParts.push(voiceDetail)
  const memo = memoParts.length > 0 ? `（現場メモ: ${memoParts.join(' / ')}）` : null
  return { quantity: quantityToUse, memo }
}

// ──────────────────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────────────────

const fmtPrice = (v: number | null) =>
  v == null ? '要確認' : `¥${v.toLocaleString('ja-JP')}`

function fmtLastUsed(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

function relativeTimeLabel(iso: string): string {
  const d    = new Date(iso)
  const now  = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const yestStart  = new Date(todayStart.getTime() - 86_400_000)
  const dStart     = new Date(d);   dStart.setHours(0, 0, 0, 0)
  const timeStr = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  if (dStart.getTime() === todayStart.getTime()) return `今日 ${timeStr}`
  if (dStart.getTime() === yestStart.getTime())  return `昨日 ${timeStr}`
  return `${d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${timeStr}`
}

function groupByDate(events: LineEvent[]): Array<{ label: string; key: string; items: LineEvent[] }> {
  const now        = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const yestStart  = new Date(todayStart.getTime() - 86_400_000)
  const map        = new Map<string, LineEvent[]>()
  for (const ev of events) {
    const d = new Date(ev.received_at); d.setHours(0, 0, 0, 0)
    const key = d.toISOString()
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(ev)
  }
  return [...map.entries()].map(([key, items]) => {
    const d = new Date(key)
    let label: string
    if (d.getTime() === todayStart.getTime())       label = '今日'
    else if (d.getTime() === yestStart.getTime())   label = '昨日'
    else label = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
    return { label, key, items }
  })
}

function getKeywords(ev: LineEvent): string[] {
  if (!ev.extracted_terms || !Array.isArray(ev.extracted_terms) || ev.extracted_terms.length === 0)
    return []
  if (typeof ev.extracted_terms[0] === 'string')
    return (ev.extracted_terms as string[]).slice(0, 5)
  return (ev.extracted_terms as MatchedItem[]).map(m => m.term).slice(0, 5)
}

// ──────────────────────────────────────────────────────────
// WaveformDecor
// ──────────────────────────────────────────────────────────

function WaveformDecor({ seed }: { seed: string }) {
  const N    = 44
  const bars = Array.from({ length: N }, (_, i) => {
    const c1  = seed.charCodeAt(i % seed.length)
    const c2  = seed.charCodeAt((i * 3 + 7) % seed.length)
    const raw = (c1 * 17 + c2 * 31 + i * 5) % 100
    return Math.max(4, Math.round(6 + raw * 0.26))
  })
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 32 }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          width: 2.5, height: h, borderRadius: 2, flexShrink: 0,
          background: i % 2 === 0 ? '#93C5FD' : '#BFDBFE',
        }} />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// CategoryLabel
// ──────────────────────────────────────────────────────────

function CategoryLabel({ category }: { category: string }) {
  const col = CATEGORY_COLORS[category] ?? { bg: '#F2F2F7', text: '#3C3C43' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 5,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.2px',
      background: col.bg, color: col.text,
    }}>
      {category}
    </span>
  )
}

// ──────────────────────────────────────────────────────────
// SimilarityBar（コンパクト版: 4px 角）
// ──────────────────────────────────────────────────────────

function SimilarityBar({ similarity }: { similarity: number }) {
  const filled = Math.max(1, Math.min(5, Math.round(similarity * 5)))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: 1.5,
          background: i <= filled ? '#0A84FF' : '#E4E8EE',
        }} />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// AiMemoPanel — メインコンポーネント
// ──────────────────────────────────────────────────────────

export function AiMemoPanel({ projectId }: { projectId: string }) {
  const supabase = useRef(getClient()).current

  const [assigned,   setAssigned]   = useState<LineEvent[]>([])
  const [unassigned, setUnassigned] = useState<LineEvent[]>([])
  const [loading,    setLoading]    = useState(true)

  const [selected,     setSelected]     = useState<Record<string, Candidate>>({})
  const [urlMap,       setUrlMap]       = useState<Record<string, string>>({})
  const [reflected,    setReflected]    = useState<Record<string, boolean>>({})
  const [editMap,      setEditMap]      = useState<Record<string, string | undefined>>({})
  const [reprocessing, setReprocessing] = useState<Record<string, boolean>>({})
  const [globalAdding, setGlobalAdding] = useState(false)

  const [openEventId,  setOpenEventId]  = useState<string | null>(null)
  const [unreflecting, setUnreflecting] = useState<Record<string, boolean>>({})

  const totalSelected = Object.keys(selected).length

  useEffect(() => {
    async function load() {
      const [r1, r2] = await Promise.all([
        supabase.from('line_events').select('*')
          .eq('project_id', projectId)
          .order('received_at', { ascending: false }),
        supabase.from('line_events').select('*')
          .is('project_id', null).eq('is_processed', true)
          .order('received_at', { ascending: false }),
      ])
      const a = (r1.data ?? []) as LineEvent[]
      const u = (r2.data ?? []) as LineEvent[]
      setAssigned(a)
      setUnassigned(u)
      await Promise.all(
        [...a, ...u].filter(ev => ev.storage_path)
          .map(ev => fetchSignedUrl(ev.id, ev.storage_path!))
      )
      setLoading(false)
    }
    load()
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchSignedUrl(eventId: string, storagePath: string) {
    try {
      const res = await fetch('/api/files/signed-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: storagePath }),
      })
      const { url } = (await res.json()) as { url?: string }
      if (url) setUrlMap(p => ({ ...p, [eventId]: url }))
    } catch { /* サイレント */ }
  }

  function updateEvent(eventId: string, patch: Partial<LineEvent>) {
    const apply = (arr: LineEvent[]) => arr.map(e => e.id === eventId ? { ...e, ...patch } : e)
    setAssigned(a => apply(a))
    setUnassigned(u => apply(u))
  }

  function handleCardClick(eventId: string, term: string, candidate: Candidate) {
    const key = `${eventId}::${term}::${candidate.id}`
    setSelected(p => {
      if (p[key]) { const n = { ...p }; delete n[key]; return n }
      return { ...p, [key]: candidate }
    })
  }

  async function handleAddAll() {
    if (!totalSelected || globalAdding) return
    const byEvent = new Map<string, Array<[string, Candidate]>>()
    for (const [key, candidate] of Object.entries(selected)) {
      const eventId = key.split('::')[0]
      if (!byEvent.has(eventId)) byEvent.set(eventId, [])
      byEvent.get(eventId)!.push([key, candidate])
    }
    setGlobalAdding(true)
    try {
      for (const [eventId, entries] of byEvent) {
        const event = [...assigned, ...unassigned].find(e => e.id === eventId)
        if (!event) continue
        const res = await fetch('/api/estimate-items', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId, line_event_id: eventId,
            items: entries.map(([key, c]) => {
              const term    = key.split('::')[1]
              const matched = event.matched_items?.find(m => m.term === term)
              const { quantity, memo } = resolveQuantityAndMemo(
                c.unit, matched?.quantity ?? null, matched?.unit ?? null, matched?.detail ?? null,
              )
              return { name: c.name, unit: c.unit, selling_price: c.selling_price, category: c.category, quantity, memo }
            }),
          }),
        })
        if (res.ok) {
          setReflected(p => ({ ...p, [eventId]: true }))
          updateEvent(eventId, { reflected_to_estimate: true })
        }
      }
      setSelected({})
    } finally {
      setGlobalAdding(false)
    }
  }

  async function handleReprocess(event: LineEvent) {
    const text = editMap[event.id]
    if (!text?.trim()) return
    setReprocessing(p => ({ ...p, [event.id]: true }))
    try {
      const res = await fetch(`/api/line-events/${event.id}/reprocess`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_content: text }),
      })
      if (res.ok) {
        const { terms, matched_items } =
          (await res.json()) as { terms: string[]; matched_items: MatchedItem[] }
        updateEvent(event.id, { raw_content: text, extracted_terms: terms, matched_items })
        setEditMap(p => { const n = { ...p }; delete n[event.id]; return n })
        setSelected(p => {
          const n = { ...p }
          Object.keys(n).filter(k => k.startsWith(`${event.id}::`)).forEach(k => delete n[k])
          return n
        })
      }
    } finally {
      setReprocessing(p => ({ ...p, [event.id]: false }))
    }
  }

  async function handleUnreflect(eventId: string) {
    setUnreflecting(p => ({ ...p, [eventId]: true }))
    try {
      const res = await fetch(`/api/line-events/${eventId}/estimate-items`, { method: 'DELETE' })
      if (res.ok) {
        setReflected(p => { const n = { ...p }; delete n[eventId]; return n })
        updateEvent(eventId, { reflected_to_estimate: false })
      }
    } finally {
      setUnreflecting(p => { const n = { ...p }; delete n[eventId]; return n })
    }
  }

  function togglePanel(eventId: string, isProcessed: boolean) {
    if (!isProcessed) return
    setOpenEventId(p => p === eventId ? null : eventId)
  }

  if (loading) return <div style={s.empty}>読み込み中...</div>

  if (!assigned.length && !unassigned.length) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🎙</div>
        <p style={{ color: '#8E8E93', fontSize: 14, margin: 0 }}>まだAI整理できるデータがありません</p>
        <p style={{ color: '#C7C7CC', fontSize: 12, margin: '6px 0 0' }}>
          LINEから音声を送ると候補が自動生成されます
        </p>
      </div>
    )
  }

  const allEvents = [...assigned, ...unassigned]
    .sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
  const dateGroups = groupByDate(allEvents)

  return (
    <>
      <div style={{ ...s.container, paddingBottom: totalSelected > 0 ? 104 : 32 }}>

        {dateGroups.map(group => (
          <section key={group.key}>
            <div style={s.dateGroupRow}>
              <div style={s.dateGroupLine} />
              <span style={s.dateGroupLabel}>{group.label}</span>
              <div style={s.dateGroupLine} />
            </div>

            <div style={s.eventList}>
              {group.items.map(ev => {
                const isReflected = reflected[ev.id] ?? ev.reflected_to_estimate
                const isOpen      = openEventId === ev.id
                return (
                  <div key={ev.id} style={s.eventWrapper}>
                    <EventRow
                      event={ev}
                      isOpen={isOpen}
                      isReflected={isReflected}
                      isUnreflecting={unreflecting[ev.id] ?? false}
                      onToggle={() => togglePanel(ev.id, ev.is_processed)}
                      onUnreflect={() => handleUnreflect(ev.id)}
                    />
                    {isOpen && ev.is_processed && (
                      <CandidatePanel
                        event={ev}
                        signedUrl={urlMap[ev.id]}
                        selected={selected}
                        isReflected={isReflected}
                        editText={editMap[ev.id]}
                        isReprocessing={reprocessing[ev.id] ?? false}
                        onCardClick={handleCardClick}
                        onEditChange={(id, text) => setEditMap(p => ({ ...p, [id]: text }))}
                        onEditStart={(id, cur)   => setEditMap(p => ({ ...p, [id]: cur }))}
                        onEditCancel={(id)        => setEditMap(p => { const n = { ...p }; delete n[id]; return n })}
                        onReprocess={handleReprocess}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        <p style={s.disclaimer}>
          この内容はAIによる整理結果です。最終判断は担当者が行ってください。
        </p>
      </div>

      {totalSelected > 0 && (
        <div style={s.stickyFooter}>
          <div style={s.stickyFooterInner}>
            <button
              onClick={handleAddAll}
              disabled={globalAdding}
              style={globalAdding ? { ...s.ctaButton, opacity: 0.6, cursor: 'not-allowed' } : s.ctaButton}
            >
              {globalAdding ? '追加中...' : `選択した ${totalSelected} 件を見積に追加`}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ──────────────────────────────────────────────────────────
// EventRow — コンパクト行（常に表示）
// ──────────────────────────────────────────────────────────

function EventRow({
  event, isOpen, isReflected, isUnreflecting, onToggle, onUnreflect,
}: {
  event:          LineEvent
  isOpen:         boolean
  isReflected:    boolean
  isUnreflecting: boolean
  onToggle:       () => void
  onUnreflect:    () => void
}) {
  const keywords = getKeywords(event)
  const typeInfo = event.event_type === 'audio'
    ? { icon: '🎙', bg: '#FEF3C7', col: '#92400E' }
    : event.event_type === 'image'
    ? { icon: '📷', bg: '#F0FDF4', col: '#166534' }
    : { icon: '💬', bg: '#F5F7FA', col: '#6B7280' }

  // <button> の中に <button> を入れるとHTML違反になるため、外枠は <div role="button"> を使う
  return (
    <div
      role="button"
      tabIndex={event.is_processed ? 0 : -1}
      onClick={event.is_processed ? onToggle : undefined}
      onKeyDown={event.is_processed ? (e) => { if (e.key === 'Enter' || e.key === ' ') onToggle() } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', minHeight: 56,
        padding: '10px 14px',
        background: isOpen ? '#F0F7FF' : '#FFFFFF',
        cursor: event.is_processed ? 'pointer' : 'default',
        userSelect: 'none' as const,
        transition: 'background 0.15s',
        outline: 'none',
      }}
    >
      {/* タイプアイコン（40×40 視覚的アンカー） */}
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: typeInfo.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18,
      }}>
        {typeInfo.icon}
      </div>

      {/* 時刻 + キーワードチップ */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            {relativeTimeLabel(event.received_at)}
          </span>
          {event.project_id === null && (
            <span style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 20,
              background: '#FEF9C3', color: '#854D0E', fontWeight: 600,
            }}>
              未振り分け
            </span>
          )}
        </div>
        {event.is_processed && keywords.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
            {keywords.slice(0, 4).map(kw => (
              <span key={kw} style={{
                padding: '2px 8px', borderRadius: 20,
                fontSize: 11, fontWeight: 600,
                background: '#EFF6FF', color: '#1D4ED8',
              }}>
                {kw}
              </span>
            ))}
          </div>
        )}
        {!event.is_processed && (
          <span style={{ fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' as const }}>
            ✦ 整理中...
          </span>
        )}
      </div>

      {/* 右端: 状態 + アクション */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {isReflected ? (
          <>
            <span style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 20,
              background: '#EFF6FF', color: '#1D4ED8', fontWeight: 700,
            }}>
              ✓ 反映済み
            </span>
            {/* div内のbutton → HTML的に正当 */}
            <button
              onClick={e => { e.stopPropagation(); onUnreflect() }}
              disabled={isUnreflecting}
              style={{
                minHeight: 44, padding: '0 10px', borderRadius: 10,
                background: '#FEF2F2', color: '#DC2626',
                border: '1px solid #FECACA', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                opacity: isUnreflecting ? 0.5 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isUnreflecting ? '...' : '↩ 取り消す'}
            </button>
          </>
        ) : event.is_processed ? (
          <div style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg
              width="7" height="12" viewBox="0 0 7 12" fill="none"
              style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}
            >
              <path d="M1 1l5 5-5 5" stroke="#C9D0DC" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// CandidatePanel — 候補選択パネル（タップで展開）
// ──────────────────────────────────────────────────────────

type PanelProps = {
  event:          LineEvent
  signedUrl:      string | undefined
  selected:       Record<string, Candidate>
  isReflected:    boolean
  editText:       string | undefined
  isReprocessing: boolean
  onCardClick:    (eventId: string, term: string, candidate: Candidate) => void
  onEditChange:   (eventId: string, text: string) => void
  onEditStart:    (eventId: string, cur: string) => void
  onEditCancel:   (eventId: string) => void
  onReprocess:    (event: LineEvent) => void
}

function CandidatePanel({
  event, signedUrl, selected, isReflected,
  editText, isReprocessing,
  onCardClick, onEditChange, onEditStart, onEditCancel, onReprocess,
}: PanelProps) {
  const matchedItems = event.matched_items ?? []
  const hasTerms     = matchedItems.length > 0
  const isEditing    = editText !== undefined

  const [detailKey, setDetailKey] = useState<string | null>(null)

  function toggleDetail(key: string, e: React.MouseEvent) {
    e.stopPropagation()
    setDetailKey(prev => prev === key ? null : key)
  }

  return (
    <div style={p.panel}>

      {/* ── 音声プレイヤー ── */}
      {signedUrl && event.event_type === 'audio' && (
        <div style={p.audioWrap}>
          <WaveformDecor seed={event.id} />
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={signedUrl} style={{ width: '100%', height: 32 }} />
        </div>
      )}

      {/* ── 写真 ── */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {signedUrl && event.event_type === 'image' && (
        <img src={signedUrl} alt="現場写真" style={p.photo} />
      )}

      {/* ── 文字起こし（タップで編集） ── */}
      {event.raw_content != null && (
        <div>
          {!isEditing ? (
            <p
              style={p.transcription}
              onClick={() => onEditStart(event.id, event.raw_content!)}
              title="タップして編集"
            >
              {event.event_type === 'audio' && (
                <span style={p.transcriptionLabel}>文字起こし　</span>
              )}
              {event.raw_content}
              <span style={{ fontSize: 12, color: '#C9D0DC' }}> ✏️</span>
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {event.event_type === 'audio' && (
                <span style={p.transcriptionLabel}>文字起こし（編集中）</span>
              )}
              <textarea
                value={editText}
                onChange={e => onEditChange(event.id, e.target.value)}
                style={p.editTextarea}
                rows={3}
                autoFocus
                disabled={isReprocessing}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onEditCancel(event.id)} disabled={isReprocessing} style={p.cancelBtn}>
                  キャンセル
                </button>
                <button
                  onClick={() => onReprocess(event)}
                  disabled={!editText.trim() || isReprocessing}
                  style={{ ...p.researchBtn, opacity: !editText.trim() || isReprocessing ? 0.5 : 1 }}
                >
                  {isReprocessing ? '再検索中...' : 'この内容で再検索'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 候補グリッド（term 列 × candidates 行、横スクロール） ── */}
      {!isReflected && hasTerms && !isEditing && (
        <div>
          <div style={p.gridLabel}>候補から選択</div>

          {/* 横スクロールコンテナ */}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' as React.CSSProperties['WebkitOverflowScrolling'], paddingBottom: 4 }}>
            <div style={p.termGrid}>
              {matchedItems.map(matched => {
                const top3 = [...matched.candidates]
                  .sort((a, b) => b.similarity - a.similarity)
                  .slice(0, 3)

                return (
                  <div key={matched.term} style={p.termCol}>
                    {/* Term ヘッダー */}
                    <div style={p.termHeader}>
                      <span style={p.termKeyword}>「{matched.term}」</span>
                      {(matched.quantity != null || matched.unit != null) && (
                        <span style={p.termQtyHint}>
                          {[matched.quantity, matched.unit].filter(v => v != null).join('')}
                        </span>
                      )}
                    </div>

                    {/* 候補カード（コンパクト、縦に並ぶ） */}
                    {top3.length === 0 ? (
                      <span style={{ fontSize: 12, color: '#C9D0DC', padding: '8px 2px', display: 'block' }}>
                        候補なし
                      </span>
                    ) : (
                      top3.map(candidate => {
                        const key           = `${event.id}::${matched.term}::${candidate.id}`
                        const isSelected    = !!selected[key]
                        const isDetailOpen  = detailKey === key
                        return (
                          <div key={candidate.id} style={{ display: 'flex', flexDirection: 'column' as const, gap: 0 }}>
                            {/* ── 選択カード ── */}
                            <button
                              onClick={() => onCardClick(event.id, matched.term, candidate)}
                              style={(() => {
                                // border shorthand と borderBottom を混在させると React 警告が出るため
                                // 4辺を個別指定で統一する
                                const bColor  = isSelected ? '#0A84FF' : '#E4E8EE'
                                const bWidth  = isSelected ? 2 : 1
                                const bBottom = isDetailOpen
                                  ? (isSelected ? '#BFDBFE' : '#E4E8EE')
                                  : bColor
                                return {
                                  position: 'relative' as const,
                                  width: '100%', minHeight: 80,
                                  padding: '10px 12px',
                                  borderRadius: isDetailOpen ? '12px 12px 0 0' : 12,
                                  borderTop:    `${bWidth}px solid ${bColor}`,
                                  borderLeft:   `${bWidth}px solid ${bColor}`,
                                  borderRight:  `${bWidth}px solid ${bColor}`,
                                  borderBottom: `${isDetailOpen ? 1 : bWidth}px solid ${bBottom}`,
                                  background: isSelected ? '#EFF6FF' : '#FFFFFF',
                                  cursor: 'pointer', textAlign: 'left' as const,
                                  boxShadow: isSelected
                                    ? '0 0 0 3px rgba(10,132,255,0.12)'
                                    : '0 1px 3px rgba(0,0,0,0.05)',
                                  transition: 'border-color 0.15s, background 0.15s',
                                  display: 'flex', flexDirection: 'column' as const, gap: 4,
                                }
                              })()}
                            >
                              {/* チェックバッジ */}
                              {isSelected && (
                                <div style={{
                                  position: 'absolute' as const, top: 8, right: 8,
                                  width: 20, height: 20, borderRadius: '50%',
                                  background: '#0A84FF', color: '#FFFFFF',
                                  fontSize: 11, fontWeight: 700,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}>
                                  ✓
                                </div>
                              )}

                              {/* 工種ラベル */}
                              <CategoryLabel category={candidate.category} />

                              {/* 品名（2行まで） */}
                              <div style={{
                                fontSize: 14, fontWeight: 600, color: '#0D1117',
                                lineHeight: 1.35,
                                paddingRight: isSelected ? 24 : 0,
                                overflow: 'hidden',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical' as React.CSSProperties['WebkitBoxOrient'],
                              } as React.CSSProperties}>
                                {candidate.name}
                              </div>

                              {/* 単価 + 確信度 */}
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                                <span style={{
                                  fontSize: 14, fontWeight: 700, letterSpacing: '-0.2px',
                                  color: isSelected ? '#0A84FF' : '#374151',
                                }}>
                                  {fmtPrice(candidate.selling_price)}
                                </span>
                                <SimilarityBar similarity={candidate.similarity} />
                              </div>
                            </button>

                            {/* ── 詳細を見るリンク ── */}
                            <button
                              onClick={e => toggleDetail(key, e)}
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                                height: 30, width: '100%',
                                border: isDetailOpen ? '2px solid #0A84FF' : '1px solid #E4E8EE',
                                borderTop: 'none',
                                borderRadius: isDetailOpen ? '0 0 12px 12px' : '0 0 12px 12px',
                                background: isDetailOpen ? '#F0F7FF' : '#FAFAFA',
                                cursor: 'pointer',
                                fontSize: 11, fontWeight: 600,
                                color: isDetailOpen ? '#0A84FF' : '#9CA3AF',
                                transition: 'background 0.15s, color 0.15s',
                              }}
                            >
                              {isDetailOpen ? '▲ 閉じる' : '📋 参考情報を見る'}
                            </button>

                            {/* ── 詳細パネル ── */}
                            {isDetailOpen && (
                              <div style={{
                                border: '2px solid #0A84FF', borderTop: 'none',
                                borderRadius: '0 0 12px 12px',
                                background: '#F8FAFC',
                                padding: '12px 12px 14px',
                                display: 'flex', flexDirection: 'column' as const, gap: 8,
                                marginTop: -1,
                              }}>
                                {/* 使用実績サマリー */}
                                <div style={{ display: 'flex', gap: 16 }}>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                                    <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 600 }}>使用回数</span>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
                                      {candidate.usage_count}回
                                    </span>
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                                    <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 600 }}>最終使用</span>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
                                      {fmtLastUsed(candidate.last_used_at)}
                                    </span>
                                  </div>
                                </div>

                                {/* 区切り線 */}
                                <div style={{ height: 1, background: '#E4E8EE' }} />

                                {/* プレースホルダー */}
                                <div style={{
                                  display: 'flex', flexDirection: 'column' as const,
                                  alignItems: 'center', gap: 4,
                                  padding: '6px 0',
                                }}>
                                  <span style={{ fontSize: 18 }}>📂</span>
                                  <p style={{ fontSize: 12, color: '#9CA3AF', margin: 0, textAlign: 'center' as const, lineHeight: 1.6 }}>
                                    写真・過去案件メモはまだ登録されていません
                                  </p>
                                  <p style={{ fontSize: 11, color: '#C7C7CC', margin: 0, textAlign: 'center' as const }}>
                                    案件が完了すると自動的に蓄積されます
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 反映済みの補足テキスト */}
      {isReflected && (
        <p style={{ fontSize: 12, color: '#9CA3AF', margin: 0 }}>
          この受信データの項目は見積に追加済みです
        </p>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// スタイル
// ──────────────────────────────────────────────────────────

const s = {
  container: {
    padding: '4px 12px',
    display: 'flex', flexDirection: 'column' as const, gap: 0,
  },
  empty: { padding: 48, textAlign: 'center' as const },

  dateGroupRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    margin: '16px 0 8px',
  },
  dateGroupLine:  { flex: 1, height: 1, background: '#E4E8EE' },
  dateGroupLabel: {
    fontSize: 11, fontWeight: 600, color: '#9CA3AF',
    textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    whiteSpace: 'nowrap' as const,
  },

  eventList:    { display: 'flex', flexDirection: 'column' as const, gap: 8, marginBottom: 4 },
  eventWrapper: {
    borderRadius: 14,
    boxShadow: '0 2px 8px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04)',
    overflow: 'hidden',
    background: '#FFFFFF',
  },

  disclaimer: {
    fontSize: 11, color: '#C9D0DC', textAlign: 'center' as const,
    margin: '16px 0 4px', lineHeight: 1.6,
  },

  stickyFooter: {
    position: 'fixed' as const,
    bottom: 'var(--bottom-safe)' as React.CSSProperties['bottom'],
    left: 0, right: 0,
    padding: '12px 16px 16px',
    background: 'rgba(255,255,255,0.97)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderTop: '1px solid #E4E8EE',
    zIndex: 50,
  },
  stickyFooterInner: {
    maxWidth: 480,
    margin: '0 auto',
  },
  ctaButton: {
    width: '100%', height: 52, borderRadius: 16, border: 'none',
    background: 'linear-gradient(135deg, #1B3659, #0A84FF)',
    color: '#FFFFFF', fontSize: 16, fontWeight: 700, cursor: 'pointer',
    letterSpacing: '-0.2px',
  },
} as const

// CandidatePanel 専用スタイル
const p = {
  panel: {
    background: '#F8FAFC',
    borderTop: '1px solid #E4E8EE',
    padding: '14px 14px 16px',
    display: 'flex', flexDirection: 'column' as const, gap: 12,
  },

  audioWrap: {
    background: '#F0F7FF', borderRadius: 12,
    padding: '10px 12px',
    display: 'flex', flexDirection: 'column' as const, gap: 8,
    border: '1px solid #DBEAFE',
  },

  photo: {
    width: '100%', maxHeight: 200,
    objectFit: 'cover' as const, borderRadius: 10, display: 'block',
  },

  transcription: {
    fontSize: 14, color: '#0D1117', lineHeight: 1.6,
    margin: 0, cursor: 'pointer',
  },
  transcriptionLabel: { fontSize: 11, color: '#9CA3AF', marginRight: 4 },

  editTextarea: {
    width: '100%', padding: '8px 10px', borderRadius: 10,
    border: '1.5px solid #0A84FF', fontSize: 14, color: '#0D1117',
    lineHeight: 1.5, resize: 'vertical' as const, fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  },
  cancelBtn: {
    flex: 1, height: 44, borderRadius: 10, border: '1.5px solid #E4E8EE',
    background: '#F5F7FA', color: '#6B7280', fontSize: 14, cursor: 'pointer',
  },
  researchBtn: {
    flex: 2, height: 44, borderRadius: 10, border: 'none',
    background: 'linear-gradient(135deg, #1B3659, #0A84FF)',
    color: '#FFFFFF', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    transition: 'opacity 0.15s',
  },

  gridLabel: {
    fontSize: 11, fontWeight: 600, color: '#9CA3AF',
    textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    marginBottom: 8,
  },

  termGrid: {
    display: 'flex', gap: 10,
    minWidth: 'min-content' as const,
  },

  termCol: {
    display: 'flex', flexDirection: 'column' as const, gap: 6,
    minWidth: 152, maxWidth: 188,
  },

  termHeader: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '0 2px',
  },
  termKeyword: { fontSize: 11, fontWeight: 600, color: '#6B7280' },
  termQtyHint: { fontSize: 10, color: '#0A84FF', fontWeight: 600 },
} as const
