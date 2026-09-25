'use client'

import { useEffect, useRef, useState } from 'react'
import { getClient } from '@/lib/supabase/client'
import { Textarea } from '@/components/ui/textarea'
import { CATEGORY_COLORS } from '@/lib/estimate/categories'

// ──────────────────────────────────────────────────────────
// 定数
// ──────────────────────────────────────────────────────────

const GROUP_THRESHOLD_MS = 5 * 60 * 1000

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

type MatchedCandidate = { category: string }
type MatchedItemEntry = { candidates: MatchedCandidate[] }

type LineEvent = {
  id:            string
  event_type:    'text' | 'image' | 'audio'
  raw_content:   string | null
  storage_path:  string | null
  project_id:    string | null
  received_at:   string
  matched_items: MatchedItemEntry[] | null
}

type EventGroup = {
  startTime: string
  events:    LineEvent[]
}

type LineEventNote = {
  id:              string
  anchor_event_id: string
  note_type:       'text' | 'photo'
  content:         string | null
  storage_path:    string | null
  created_at:      string
}

type ViewMode = 'grid' | 'list'

// ──────────────────────────────────────────────────────────
// グルーピング・ヘルパー
// ──────────────────────────────────────────────────────────

function groupByTime(events: LineEvent[]): EventGroup[] {
  if (!events.length) return []
  const sorted = [...events].sort(
    (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime(),
  )
  const groups: EventGroup[] = []
  let cur: EventGroup = { startTime: sorted[0].received_at, events: [sorted[0]] }
  for (let i = 1; i < sorted.length; i++) {
    const diff =
      new Date(sorted[i].received_at).getTime() -
      new Date(sorted[i - 1].received_at).getTime()
    if (diff <= GROUP_THRESHOLD_MS) {
      cur.events.push(sorted[i])
    } else {
      groups.push(cur)
      cur = { startTime: sorted[i].received_at, events: [sorted[i]] }
    }
  }
  groups.push(cur)
  return groups
}

function getSingleCategory(group: EventGroup): string | null {
  const cats = new Set<string>()
  for (const ev of group.events) {
    for (const mi of ev.matched_items ?? []) {
      for (const c of mi.candidates) {
        cats.add(c.category)
      }
    }
  }
  return cats.size === 1 ? [...cats][0] : null
}

function getFirstTranscript(group: EventGroup): string | null {
  for (const ev of group.events) {
    if (ev.raw_content) return ev.raw_content
  }
  return null
}

function getCalendarKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function fmtDatePill(iso: string): string {
  const d = new Date(iso)
  const days = ['日', '月', '火', '水', '木', '金', '土']
  return `${d.getMonth() + 1}/${d.getDate()}（${days[d.getDay()]}）`
}

function getDateFirstSet(groups: EventGroup[]): Set<number> {
  const seen = new Set<string>()
  const firsts = new Set<number>()
  groups.forEach((g, i) => {
    const key = getCalendarKey(g.startTime)
    if (!seen.has(key)) {
      seen.add(key)
      firsts.add(i)
    }
  })
  return firsts
}

const fmtShortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

// ──────────────────────────────────────────────────────────
// PhotoMemoTab
// ──────────────────────────────────────────────────────────

export function PhotoMemoTab({ projectId }: { projectId: string }) {
  const supabase = useRef(getClient()).current

  const [events,      setEvents]      = useState<LineEvent[]>([])
  const [loading,     setLoading]     = useState(true)
  const [urlMap,      setUrlMap]      = useState<Record<string, string>>({})
  const [notes,       setNotes]       = useState<LineEventNote[]>([])
  const [noteUrlMap,  setNoteUrlMap]  = useState<Record<string, string>>({})
  const [openGroup,   setOpenGroup]   = useState<EventGroup | null>(null)
  const [autoFocus,   setAutoFocus]   = useState(false)
  const [viewMode,      setViewMode]      = useState<ViewMode>('grid')
  const [menuOpenIdx,   setMenuOpenIdx]   = useState<number | null>(null)
  const [deletingGridId, setDeletingGridId] = useState<string | null>(null)

  async function fetchSignedUrl(eventId: string, storagePath: string) {
    try {
      const res = await fetch('/api/files/signed-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: storagePath }),
      })
      const { url } = (await res.json()) as { url?: string }
      if (url) setUrlMap(p => ({ ...p, [eventId]: url }))
    } catch { /* サイレント */ }
  }

  async function fetchNoteSignedUrl(noteId: string, storagePath: string) {
    try {
      const res = await fetch('/api/files/signed-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_path: storagePath }),
      })
      const { url } = (await res.json()) as { url?: string }
      if (url) setNoteUrlMap(p => ({ ...p, [noteId]: url }))
    } catch { /* サイレント */ }
  }

  useEffect(() => {
    async function load() {
      const [r1, r2] = await Promise.all([
        supabase
          .from('line_events')
          .select('id,event_type,raw_content,storage_path,project_id,received_at,matched_items')
          .eq('project_id', projectId)
          .order('received_at', { ascending: true }),
        supabase
          .from('line_events')
          .select('id,event_type,raw_content,storage_path,project_id,received_at,matched_items')
          .is('project_id', null)
          .order('received_at', { ascending: true }),
      ])
      const all = [...(r1.data ?? []), ...(r2.data ?? [])] as LineEvent[]
      setEvents(all)

      await Promise.all(
        all
          .filter(e => e.event_type === 'image' && e.storage_path)
          .map(e => fetchSignedUrl(e.id, e.storage_path!)),
      )

      const eventIds = all.map(e => e.id)
      if (eventIds.length > 0) {
        const { data: notesData } = await supabase
          .from('line_event_notes')
          .select('id,anchor_event_id,note_type,content,storage_path,created_at')
          .in('anchor_event_id', eventIds)
          .order('created_at', { ascending: true })
        const loaded = (notesData ?? []) as LineEventNote[]
        setNotes(loaded)

        await Promise.all(
          loaded
            .filter(n => n.note_type === 'photo' && n.storage_path)
            .map(n => fetchNoteSignedUrl(n.id, n.storage_path!)),
        )
      }

      setLoading(false)
    }
    load()
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleNoteAdded(note: LineEventNote, photoUrl?: string) {
    setNotes(prev => [...prev, note])
    if (photoUrl) setNoteUrlMap(prev => ({ ...prev, [note.id]: photoUrl }))
  }

  function openDetail(group: EventGroup, focus = false) {
    setAutoFocus(focus)
    setOpenGroup(group)
    setMenuOpenIdx(null)
  }

  // LINE イベント写真の削除後 state 更新
  function handleEventPhotoDeleted(eventId: string) {
    setEvents(prev =>
      prev
        .map(e => e.id !== eventId ? e : { ...e, storage_path: null, event_type: 'text' as const })
        .filter(e => e.id !== eventId || e.raw_content !== null),
    )
    setUrlMap(prev => { const n = { ...prev }; delete n[eventId]; return n })
    setOpenGroup(null)
  }

  // 追記写真の削除後 state 更新
  function handleNotePhotoDeleted(noteId: string) {
    setNotes(prev => prev.filter(n => n.id !== noteId))
    setNoteUrlMap(prev => { const n = { ...prev }; delete n[noteId]; return n })
  }

  // グリッドドロップダウンからの写真削除
  async function handleGridPhotoDelete(eventId: string) {
    if (!window.confirm('この写真を削除しますか？\n\n削除後は元に戻せません。')) return
    setDeletingGridId(eventId)
    setMenuOpenIdx(null)
    try {
      const res = await fetch(`/api/line-events/${eventId}/photo`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        alert(`削除に失敗しました: ${body?.error ?? `HTTP ${res.status}`}`)
        return
      }
      handleEventPhotoDeleted(eventId)
    } finally {
      setDeletingGridId(null)
    }
  }

  if (loading) return <div style={s.empty}>読み込み中...</div>

  const groups     = groupByTime(events)
  const hasContent = events.some(e => e.event_type === 'image' || e.raw_content)

  if (!hasContent) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>📷</div>
        <p style={{ margin: 0, color: '#8E8E93', fontSize: 14 }}>まだ写真が届いていません</p>
        <p style={{ margin: '6px 0 0', color: '#C7C7CC', fontSize: 12 }}>
          LINEから写真・音声を送ると、ここに表示されます
        </p>
      </div>
    )
  }

  const visibleGroups = groups.filter(g => {
    const photos  = g.events.filter(e => e.event_type === 'image')
    const content = g.events.filter(e => e.raw_content)
    return photos.length > 0 || content.length > 0
  })

  const anchorIds   = new Set(notes.map(n => n.anchor_event_id))
  const dateFirsts  = getDateFirstSet(visibleGroups)

  return (
    <>
      {/* ── ツールバー（Google Drive style） ── */}
      <div style={s.toolbar}>
        <span style={s.sortLabel}>{visibleGroups.length}件</span>
        <div style={s.toggleGroup}>
          <button
            onClick={() => setViewMode('grid')}
            style={viewMode === 'grid' ? s.toggleActive : s.toggleInactive}
            aria-label="グリッド表示"
          >
            <GridIcon active={viewMode === 'grid'} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={viewMode === 'list' ? s.toggleActive : s.toggleInactive}
            aria-label="リスト表示"
          >
            <ListIcon active={viewMode === 'list'} />
          </button>
        </div>
      </div>

      {/* メニュー外クリックで閉じるオーバーレイ */}
      {menuOpenIdx !== null && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 90 }}
          onClick={() => setMenuOpenIdx(null)}
        />
      )}

      {/* ── グリッド表示 ── */}
      {viewMode === 'grid' && (
        <div style={s.grid}>
          {visibleGroups.map((group, gi) => {
            const photos     = group.events.filter(e => e.event_type === 'image')
            const firstPhoto = photos[0]
            const extraCount = photos.length - 1
            const hasNotes   = group.events.some(e => anchorIds.has(e.id))
            const showPill   = dateFirsts.has(gi)
            const isMenuOpen = menuOpenIdx === gi
            const transcript = getFirstTranscript(group)

            return (
              <div key={gi} style={s.cell}>
                {/* 画像クリップレイヤー（overflow:hidden） */}
                <div style={s.cellInner}>
                  {firstPhoto && urlMap[firstPhoto.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={urlMap[firstPhoto.id]}
                      alt="現場写真"
                      style={s.cellImg}
                    />
                  ) : firstPhoto ? (
                    <div style={{ ...s.cellPlaceholder, background: '#E5E5EA' }}>
                      <span style={{ fontSize: 18 }}>⏳</span>
                    </div>
                  ) : (
                    <div style={s.cellPlaceholder}>
                      <span style={{ fontSize: 22 }}>🎙</span>
                    </div>
                  )}

                  {/* 日付ピル（その日最初のグループ） */}
                  {showPill && (
                    <div style={s.datePill}>{fmtDatePill(group.startTime)}</div>
                  )}

                  {/* 追加枚数バッジ */}
                  {extraCount > 0 && (
                    <div style={s.countBadge}>+{extraCount}</div>
                  )}

                  {/* 追記ありドット */}
                  {hasNotes && (
                    <div style={s.notesDot} />
                  )}
                </div>

                {/* タップ領域（詳細を開く） */}
                <div
                  style={s.cellTap}
                  onClick={() => openDetail(group)}
                  title={transcript ?? undefined}
                />

                {/* ︙ メニューボタン */}
                <button
                  style={s.menuBtn}
                  onClick={e => {
                    e.stopPropagation()
                    setMenuOpenIdx(isMenuOpen ? null : gi)
                  }}
                  aria-label="メニュー"
                >
                  ···
                </button>

                {/* ドロップダウン */}
                {isMenuOpen && (
                  <div style={s.dropdown}>
                    <button
                      style={s.dropdownItem}
                      onClick={() => openDetail(group, false)}
                    >
                      詳細を見る
                    </button>
                    <div style={s.dropdownDivider} />
                    <button
                      style={s.dropdownItem}
                      onClick={() => openDetail(group, true)}
                    >
                      追記を追加
                    </button>
                    {firstPhoto?.storage_path && (
                      <>
                        <div style={s.dropdownDivider} />
                        <button
                          style={{ ...s.dropdownItem, color: '#EF4444', opacity: deletingGridId === firstPhoto.id ? 0.5 : 1 }}
                          onClick={() => handleGridPhotoDelete(firstPhoto.id)}
                          disabled={deletingGridId === firstPhoto.id}
                        >
                          {deletingGridId === firstPhoto.id ? '削除中...' : '🗑 写真を削除'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── リスト表示（Google Drive style） ── */}
      {viewMode === 'list' && (
        <div>
          {visibleGroups.map((group, gi) => {
            const photos     = group.events.filter(e => e.event_type === 'image')
            const firstPhoto = photos[0]
            const extraCount = photos.length - 1
            const transcript = getFirstTranscript(group)
            const category   = getSingleCategory(group)
            const catColor   = category ? CATEGORY_COLORS[category] : null
            const hasNotes   = group.events.some(e => anchorIds.has(e.id))
            const showDate   = dateFirsts.has(gi)

            return (
              <div key={gi}>
                {/* 日付ヘッダー */}
                {showDate && (
                  <div style={s.listDateHeader}>{fmtDatePill(group.startTime)}</div>
                )}
                <button
                  style={s.listRow}
                  onClick={() => openDetail(group)}
                >
                  {/* サムネイル */}
                  <div style={s.listThumbWrap}>
                    {firstPhoto && urlMap[firstPhoto.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={urlMap[firstPhoto.id]}
                        alt="現場写真"
                        style={s.listThumb}
                      />
                    ) : firstPhoto ? (
                      <div style={{ ...s.listThumbPlaceholder, background: '#E5E5EA' }}>
                        <span style={{ fontSize: 14 }}>⏳</span>
                      </div>
                    ) : (
                      <div style={s.listThumbPlaceholder}>
                        <span style={{ fontSize: 18 }}>🎙</span>
                      </div>
                    )}
                    {extraCount > 0 && (
                      <div style={s.listCountBadge}>+{extraCount}</div>
                    )}
                  </div>

                  {/* テキスト情報 */}
                  <div style={s.listBody}>
                    <div style={s.listTitle}>
                      {transcript
                        ? transcript.slice(0, 40) + (transcript.length > 40 ? '…' : '')
                        : `写真 ${photos.length}枚`}
                    </div>
                    <div style={s.listSub}>
                      {fmtShortTime(group.startTime)}
                      {category && ` · ${category}`}
                      {hasNotes && ' · ✏ 追記あり'}
                    </div>
                    {catColor && (
                      <span style={{
                        display: 'inline-block',
                        marginTop: 4,
                        padding: '2px 7px', borderRadius: 5,
                        fontSize: 10, fontWeight: 600,
                        background: catColor.bg, color: catColor.text,
                      }}>
                        {category}
                      </span>
                    )}
                  </div>

                  {/* シェブロン */}
                  <svg width="7" height="12" viewBox="0 0 7 12" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M1 1l5 5-5 5" stroke="#C9D0DC" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* 詳細モーダル */}
      {openGroup && (
        <GroupDetailModal
          group={openGroup}
          urlMap={urlMap}
          groupNotes={notes
            .filter(n => openGroup.events.some(e => e.id === n.anchor_event_id))
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          }
          noteUrlMap={noteUrlMap}
          anchorEventId={openGroup.events[0].id}
          projectId={projectId}
          autoFocusNote={autoFocus}
          onNoteAdded={handleNoteAdded}
          onEventPhotoDelete={handleEventPhotoDeleted}
          onNoteDelete={handleNotePhotoDeleted}
          onClose={() => setOpenGroup(null)}
        />
      )}
    </>
  )
}

// ──────────────────────────────────────────────────────────
// アイコン
// ──────────────────────────────────────────────────────────

function GridIcon({ active }: { active: boolean }) {
  const color = active ? '#1967D2' : '#80868B'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="6" height="6" rx="1" fill={color} />
      <rect x="9" y="1" width="6" height="6" rx="1" fill={color} />
      <rect x="1" y="9" width="6" height="6" rx="1" fill={color} />
      <rect x="9" y="9" width="6" height="6" rx="1" fill={color} />
    </svg>
  )
}

function ListIcon({ active }: { active: boolean }) {
  const color = active ? '#1967D2' : '#80868B'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3" width="14" height="2" rx="1" fill={color} />
      <rect x="1" y="7" width="14" height="2" rx="1" fill={color} />
      <rect x="1" y="11" width="14" height="2" rx="1" fill={color} />
    </svg>
  )
}

// ──────────────────────────────────────────────────────────
// レスポンシブフック
// ──────────────────────────────────────────────────────────

function useIsNarrow(breakpoint = 600): boolean {
  const [narrow, setNarrow] = useState(true)
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < breakpoint)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])
  return narrow
}

// ──────────────────────────────────────────────────────────
// 詳細モーダル（中央固定カード）
// ──────────────────────────────────────────────────────────

function GroupDetailModal({
  group,
  urlMap,
  groupNotes,
  noteUrlMap,
  anchorEventId,
  projectId,
  autoFocusNote,
  onNoteAdded,
  onEventPhotoDelete,
  onNoteDelete,
  onClose,
}: {
  group:               EventGroup
  urlMap:              Record<string, string>
  groupNotes:          LineEventNote[]
  noteUrlMap:          Record<string, string>
  anchorEventId:       string
  projectId:           string
  autoFocusNote?:      boolean
  onNoteAdded:         (note: LineEventNote, photoUrl?: string) => void
  onEventPhotoDelete:  (eventId: string) => void
  onNoteDelete:        (noteId: string) => void
  onClose:             () => void
}) {
  const isNarrow    = useIsNarrow()
  const photos      = group.events.filter(e => e.event_type === 'image')
  const transcripts = group.events.filter(e => e.raw_content)
  const category    = getSingleCategory(group)
  const catColor    = category ? CATEGORY_COLORS[category] : null
  const hasPhotos   = photos.length > 0

  const [appendText,      setAppendText]      = useState('')
  const [appending,       setAppending]       = useState(false)
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null)
  const [deletingNoteId,  setDeletingNoteId]  = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef  = useRef<HTMLTextAreaElement>(null)

  async function handleDeleteEventPhoto(ev: LineEvent) {
    if (!window.confirm('この写真を削除しますか？\n\n削除後は元に戻せません。')) return
    setDeletingPhotoId(ev.id)
    try {
      const res = await fetch(`/api/line-events/${ev.id}/photo`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        alert(`削除に失敗しました: ${body?.error ?? `HTTP ${res.status}`}`)
        return
      }
      onEventPhotoDelete(ev.id)
    } finally {
      setDeletingPhotoId(null)
    }
  }

  async function handleDeleteNotePhoto(noteId: string) {
    if (!window.confirm('この追記写真を削除しますか？\n\n削除後は元に戻せません。')) return
    setDeletingNoteId(noteId)
    try {
      const res = await fetch(`/api/line-event-notes/${noteId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        alert(`削除に失敗しました: ${body?.error ?? `HTTP ${res.status}`}`)
        return
      }
      onNoteDelete(noteId)
    } finally {
      setDeletingNoteId(null)
    }
  }

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    if (autoFocusNote) {
      setTimeout(() => textareaRef.current?.focus(), 300)
    }
  }, [autoFocusNote])

  async function handleSubmitText() {
    if (!appendText.trim() || appending) return
    setAppending(true)
    try {
      const fd = new FormData()
      fd.append('note_type', 'text')
      fd.append('content', appendText.trim())
      fd.append('project_id', projectId)

      const res = await fetch(`/api/line-events/${anchorEventId}/notes`, {
        method: 'POST', body: fd,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const msg = body?.error ?? `HTTP ${res.status}`
        console.error('[notes] save failed:', msg)
        alert(`追記の保存に失敗しました。\n${msg}`)
        return
      }

      const note = (await res.json()) as LineEventNote
      onNoteAdded(note)
      setAppendText('')
    } catch (err) {
      console.error('[notes] unexpected error:', err)
      alert('追記の保存中にエラーが発生しました。')
    } finally {
      setAppending(false)
    }
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setAppending(true)
    try {
      const fd = new FormData()
      fd.append('note_type', 'photo')
      fd.append('file', file)
      fd.append('project_id', projectId)

      const res = await fetch(`/api/line-events/${anchorEventId}/notes`, {
        method: 'POST', body: fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const msg = body?.error ?? `HTTP ${res.status}`
        console.error('[notes] photo save failed:', msg)
        alert(`写真の保存に失敗しました。\n${msg}`)
        return
      }
      const note = (await res.json()) as LineEventNote

      let photoUrl: string | undefined
      if (note.storage_path) {
        const urlRes = await fetch('/api/files/signed-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storage_path: note.storage_path }),
        })
        const { url } = (await urlRes.json()) as { url?: string }
        photoUrl = url
      }
      onNoteAdded(note, photoUrl)
    } finally {
      setAppending(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // 2カラムにするか（デスクトップ幅 + 写真あり）
  const twoCol = !isNarrow && hasPhotos

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={ms.card} onClick={e => e.stopPropagation()}>

        {/* ── ヘッダー ── */}
        <div style={ms.header}>
          <span style={ms.headerTime}>{fmtDateTime(group.startTime)}</span>
          {catColor && (
            <span style={{
              padding: '2px 9px', borderRadius: 6,
              fontSize: 11, fontWeight: 600,
              background: catColor.bg, color: catColor.text,
            }}>
              {category}
            </span>
          )}
          <button style={ms.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* ── ボディ（2カラム or 縦積み） ── */}
        <div style={{
          display: 'flex',
          flexDirection: twoCol ? 'row' : 'column',
          flex: 1,
          minHeight: 0,
          overflow: twoCol ? 'hidden' : 'auto',
        }}>

          {/* 左カラム: 写真 */}
          {hasPhotos && (
            <div style={twoCol ? ms.photoColWide : ms.photoColNarrow}>
              {/* スワイパー */}
              <div style={twoCol ? ms.swiperWide : ms.swiperNarrow}>
                {photos.map(ev => (
                  <div
                    key={ev.id}
                    style={{
                      position: 'relative',
                      flexShrink: 0,
                      scrollSnapAlign: 'start',
                      ...(twoCol ? { width: '100%', height: '100%' } : {}),
                    }}
                  >
                    {urlMap[ev.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={urlMap[ev.id]}
                        alt="現場写真"
                        style={{
                          ...(twoCol ? ms.photoWide : ms.photoNarrow),
                          scrollSnapAlign: 'unset' as const,
                        }}
                      />
                    ) : (
                      <div style={twoCol ? ms.photoPlaceholderWide : ms.photoPlaceholderNarrow}>
                        <span style={{ fontSize: 24, color: '#8E8E93' }}>⏳</span>
                      </div>
                    )}
                    {urlMap[ev.id] && (
                      <button
                        onClick={() => handleDeleteEventPhoto(ev)}
                        disabled={!!deletingPhotoId}
                        title="写真を削除"
                        style={{
                          position: 'absolute', bottom: 10, right: 10,
                          width: 36, height: 36, borderRadius: '50%',
                          background: 'rgba(0,0,0,0.55)', color: '#FFFFFF',
                          border: 'none', cursor: 'pointer', fontSize: 16,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          opacity: deletingPhotoId ? 0.4 : 1,
                          transition: 'opacity 0.15s',
                          zIndex: 5,
                        }}
                      >
                        {deletingPhotoId === ev.id ? '⌛' : '🗑'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {/* ドット（複数枚） */}
              {photos.length > 1 && (
                <div style={ms.dotRow}>
                  {photos.map((_, i) => (
                    <div key={i} style={{ ...ms.dot, ...(i === 0 ? ms.dotActive : {}) }} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 右カラム（または下段）: テキスト・追記 */}
          <div style={twoCol ? ms.contentColWide : ms.contentColNarrow}>

            {/* 文字起こし・テキスト */}
            {transcripts.length > 0 && (
              <div style={ms.transcriptSection}>
                {transcripts.map(ev => (
                  <div key={ev.id} style={ms.transcriptBlock}>
                    <span style={ms.transcriptIcon}>
                      {ev.event_type === 'audio' ? '🎙' : '💬'}
                    </span>
                    <p style={ms.transcriptText}>{ev.raw_content}</p>
                  </div>
                ))}
              </div>
            )}

            {/* 追記リスト */}
            {groupNotes.length > 0 && (
              <>
                <div style={ms.notesDivider}>
                  <div style={ms.dividerLine} />
                  <span style={ms.dividerLabel}>後から書き足した内容</span>
                  <div style={ms.dividerLine} />
                </div>
                <div style={ms.notesList}>
                  {groupNotes.map(note => (
                    <div key={note.id} style={ms.noteCard}>
                      <div style={ms.noteCardHeader}>
                        <span style={ms.noteLabel}>✏ 追記</span>
                        <span style={ms.noteTime}>{fmtDateTime(note.created_at)}</span>
                        {note.note_type === 'photo' && (
                          <button
                            onClick={() => handleDeleteNotePhoto(note.id)}
                            disabled={!!deletingNoteId}
                            title="写真を削除"
                            style={{
                              marginLeft: 'auto',
                              width: 28, height: 28, borderRadius: 6,
                              background: 'none', border: 'none',
                              cursor: 'pointer', fontSize: 14,
                              color: deletingNoteId === note.id ? '#C7C7CC' : '#EF4444',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              opacity: deletingNoteId ? 0.5 : 1,
                              flexShrink: 0,
                            }}
                          >
                            {deletingNoteId === note.id ? '⌛' : '🗑'}
                          </button>
                        )}
                      </div>
                      {note.note_type === 'text' && note.content && (
                        <p style={ms.noteText}>{note.content}</p>
                      )}
                      {note.note_type === 'photo' && (
                        noteUrlMap[note.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={noteUrlMap[note.id]} alt="追記写真" style={ms.notePhoto} />
                        ) : (
                          <div style={ms.notePhotoPlaceholder}>
                            <span style={{ fontSize: 20, color: '#92400E' }}>⏳</span>
                          </div>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* コンテンツなしの場合 */}
            {transcripts.length === 0 && groupNotes.length === 0 && (
              <div style={{ padding: 16, color: '#8E8E93', fontSize: 14 }}>
                {hasPhotos ? '写真のみのグループです' : '内容がありません'}
              </div>
            )}
          </div>
        </div>

        {/* ── フッター: 操作ボタン + 追記フォーム ── */}
        <div style={ms.footer}>
          <div style={ms.footerLabel}>追記を書き足す</div>
          <div style={ms.appendRow}>
            <Textarea
              ref={textareaRef}
              inputSize="compact"
              className="resize-none"
              value={appendText}
              onChange={e => setAppendText(e.target.value)}
              placeholder="テキストメモを書き足す..."
              rows={2}
              disabled={appending}
            />
            <button
              onClick={handleSubmitText}
              disabled={!appendText.trim() || appending}
              style={{ ...ms.sendBtn, opacity: !appendText.trim() || appending ? 0.4 : 1 }}
            >
              送信
            </button>
          </div>
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={handlePhotoSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={appending}
            style={{ ...ms.photoAddBtn, opacity: appending ? 0.4 : 1 }}
          >
            {appending ? '送信中...' : '📷 写真を追加'}
          </button>
        </div>

      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// スタイル
// ──────────────────────────────────────────────────────────

const s = {
  empty: { padding: 40, textAlign: 'center' as const },

  // ── ツールバー（Google Drive style） ──
  toolbar: {
    height: 44,
    padding: '0 16px',
    borderBottom: '1px solid #E8EAED',
    background: '#FFFFFF',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  } as React.CSSProperties,
  sortLabel: {
    fontSize: 13, color: '#5F6368', fontWeight: 500,
  },
  toggleGroup: {
    display: 'flex', gap: 2,
  },
  toggleActive: {
    width: 34, height: 34, borderRadius: 8,
    background: '#E8F0FE', color: '#1967D2',
    border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as React.CSSProperties,
  toggleInactive: {
    width: 34, height: 34, borderRadius: 8,
    background: 'transparent', color: '#80868B',
    border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as React.CSSProperties,

  // ── グリッド（Google Photos style） ──
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)' as const,
    gap: 0,
  } as React.CSSProperties,

  // セル外枠（overflow: visible → ドロップダウンが外に出る）
  cell: {
    position: 'relative' as const,
    aspectRatio: '1/1' as const,
    overflow: 'visible',
  } as React.CSSProperties,

  // セル内クリップ領域（overflow: hidden → 画像が正方形にクリップされる）
  cellInner: {
    position: 'absolute' as const,
    inset: 0,
    overflow: 'hidden',
    background: '#F2F2F7',
  } as React.CSSProperties,

  cellImg: {
    width: '100%', height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
  },
  cellPlaceholder: {
    width: '100%', height: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#F2F2F7',
  },

  // 日付ピル（Google Photos style floating pill）
  datePill: {
    position: 'absolute' as const,
    top: 8, left: 8,
    borderRadius: 20,
    padding: '4px 12px',
    fontSize: 13,
    fontWeight: 600,
    color: '#1C1C1E',
    background: 'rgba(255,255,255,0.88)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
    lineHeight: 1.3,
  } as React.CSSProperties,

  countBadge: {
    position: 'absolute' as const,
    bottom: 6, right: 6,
    background: 'rgba(0,0,0,0.55)',
    color: '#FFFFFF', fontSize: 11, fontWeight: 700,
    padding: '2px 6px', borderRadius: 8,
    backdropFilter: 'blur(4px)',
    pointerEvents: 'none' as const,
  } as React.CSSProperties,

  notesDot: {
    position: 'absolute' as const,
    top: 6, left: 6,
    width: 8, height: 8,
    borderRadius: '50%',
    background: '#F59E0B',
    border: '1.5px solid rgba(255,255,255,0.8)',
    pointerEvents: 'none' as const,
  } as React.CSSProperties,

  // タップ領域（zIndex: 1 → ボタンより下）
  cellTap: {
    position: 'absolute' as const,
    inset: 0,
    zIndex: 1,
    cursor: 'pointer',
  } as React.CSSProperties,

  // ︙ メニューボタン（Google Photos style dark circle）
  menuBtn: {
    position: 'absolute' as const,
    top: 6, right: 6,
    width: 28, height: 28,
    borderRadius: 14,
    background: 'rgba(0,0,0,0.45)',
    color: '#FFFFFF',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2,
    lineHeight: 1,
    letterSpacing: '0.5px',
    padding: '0 0 2px',
  } as React.CSSProperties,

  // ドロップダウンメニュー（zIndex: 91 > overlay 90）
  dropdown: {
    position: 'absolute' as const,
    top: 36, right: 6,
    zIndex: 91,
    background: '#FFFFFF',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.05)',
    overflow: 'hidden',
    minWidth: 140,
  } as React.CSSProperties,

  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '11px 14px',
    fontSize: 14,
    color: '#202124',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
    lineHeight: 1.3,
  } as React.CSSProperties,

  dropdownDivider: {
    height: 1, background: '#F1F3F4', margin: '0',
  },

  // ── リスト表示（Google Drive style） ──
  listDateHeader: {
    fontSize: 13, fontWeight: 600, color: '#5F6368',
    padding: '10px 16px 4px',
  },
  listRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    minHeight: 56, padding: '0 16px',
    width: '100%',
    background: 'none', border: 'none',
    borderBottom: '1px solid #F1F3F4',
    cursor: 'pointer',
    textAlign: 'left' as const,
  } as React.CSSProperties,
  listThumbWrap: {
    position: 'relative' as const,
    width: 48, height: 48, flexShrink: 0,
  },
  listThumb: {
    width: 48, height: 48,
    borderRadius: 8,
    objectFit: 'cover' as const,
    display: 'block',
  },
  listThumbPlaceholder: {
    width: 48, height: 48, borderRadius: 8,
    background: '#F2F2F7',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  listCountBadge: {
    position: 'absolute' as const,
    bottom: 2, right: 2,
    background: 'rgba(0,0,0,0.55)',
    color: '#FFFFFF', fontSize: 9, fontWeight: 700,
    padding: '1px 4px', borderRadius: 5,
  } as React.CSSProperties,
  listBody: { flex: 1, minWidth: 0 },
  listTitle: {
    fontSize: 14, fontWeight: 500, color: '#202124',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  listSub: {
    fontSize: 12, color: '#5F6368', marginTop: 2,
  },
} as const

const ms = {
  // ── オーバーレイ（中央寄せ） ──
  overlay: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(0,0,0,0.72)',
    zIndex: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },

  // ── カード本体 ──
  card: {
    background: '#FFFFFF',
    borderRadius: 20,
    width: '100%',
    maxWidth: 680,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06)',
  },

  // ── ヘッダー ──
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '14px 16px 12px',
    borderBottom: '1px solid #E5E5EA',
    flexShrink: 0,
  },
  headerTime: { fontSize: 13, color: '#8E8E93', flex: 1 },
  closeBtn: {
    width: 30, height: 30, borderRadius: '50%',
    background: '#F2F2F7', border: 'none',
    fontSize: 14, color: '#3C3C43',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  // ── 写真カラム（デスクトップ: 左45%） ──
  photoColWide: {
    width: '45%',
    flexShrink: 0,
    borderRight: '1px solid #E5E5EA',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    background: '#111',
  },
  // 写真カラム（モバイル: 上段・全幅）
  photoColNarrow: {
    width: '100%',
    flexShrink: 0,
    borderBottom: '1px solid #E5E5EA',
    background: '#111',
  },

  // ── スワイパー（デスクトップ: 縦いっぱいに伸びる） ──
  swiperWide: {
    flex: 1,
    display: 'flex',
    overflowX: 'auto' as const,
    scrollSnapType: 'x mandatory' as const,
    WebkitOverflowScrolling: 'touch' as const,
    scrollbarWidth: 'none' as const,
  },
  // スワイパー（モバイル: 4:3アスペクト）
  swiperNarrow: {
    display: 'flex',
    overflowX: 'auto' as const,
    scrollSnapType: 'x mandatory' as const,
    WebkitOverflowScrolling: 'touch' as const,
    scrollbarWidth: 'none' as const,
  },

  // ── 写真（デスクトップ: 高さ100%・contain） ──
  photoWide: {
    flexShrink: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain' as const,
    scrollSnapAlign: 'start' as const,
    display: 'block',
  },
  // 写真（モバイル: 4:3アスペクト・cover）
  photoNarrow: {
    width: '100%',
    flexShrink: 0,
    aspectRatio: '4/3' as const,
    objectFit: 'cover' as const,
    scrollSnapAlign: 'start' as const,
    display: 'block',
  },

  photoPlaceholderWide: {
    flexShrink: 0,
    width: '100%', height: '100%',
    background: '#222',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    scrollSnapAlign: 'start' as const,
  },
  photoPlaceholderNarrow: {
    width: '100%', flexShrink: 0,
    aspectRatio: '4/3' as const,
    background: '#222',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    scrollSnapAlign: 'start' as const,
  },

  dotRow: {
    display: 'flex', justifyContent: 'center', gap: 5,
    padding: '8px 0',
    background: '#111',
    flexShrink: 0,
  },
  dot:       { width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.35)' },
  dotActive: { width: 8, height: 8, borderRadius: '50%', background: '#FFFFFF' },

  // ── コンテンツカラム（デスクトップ: 右側・スクロール） ──
  contentColWide: {
    flex: 1,
    overflowY: 'auto' as const,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  // コンテンツカラム（モバイル: 下段）
  contentColNarrow: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },

  // ── テキスト・音声 ──
  transcriptSection: {
    padding: '14px 16px 16px',
    display: 'flex', flexDirection: 'column' as const, gap: 12,
  },
  transcriptBlock: { display: 'flex', gap: 8, alignItems: 'flex-start' },
  transcriptIcon:  { fontSize: 16, flexShrink: 0, marginTop: 1 },
  transcriptText:  { margin: 0, fontSize: 15, color: '#1C1C1E', lineHeight: 1.6 },

  // ── 追記セクション ──
  notesDivider: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 16px 0',
  },
  dividerLine:  { flex: 1, height: 1, background: '#E5E5EA' },
  dividerLabel: { fontSize: 11, color: '#92400E', whiteSpace: 'nowrap' as const, fontWeight: 500 },

  notesList: {
    padding: '10px 16px 16px',
    display: 'flex', flexDirection: 'column' as const, gap: 8,
  },
  noteCard: {
    background: '#FFFBEB',
    borderLeft: '3px solid #F59E0B',
    borderRadius: '0 8px 8px 0',
    padding: '8px 12px',
  },
  noteCardHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
  },
  noteLabel: {
    fontSize: 10, fontWeight: 700, color: '#92400E',
    background: '#FDE68A', padding: '1px 6px', borderRadius: 4,
    flexShrink: 0,
  },
  noteTime: { fontSize: 11, color: '#92400E', opacity: 0.7 },
  noteText: { margin: 0, fontSize: 14, color: '#1C1C1E', lineHeight: 1.55 },
  notePhoto: {
    width: '100%', borderRadius: 8, display: 'block', marginTop: 2,
  },
  notePhotoPlaceholder: {
    width: '100%', aspectRatio: '4/3' as const,
    background: '#FEF3C7', borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // ── フッター（追記フォーム） ──
  footer: {
    borderTop: '1px solid #E5E5EA',
    padding: '12px 16px 16px',
    background: '#F8F8F8',
    flexShrink: 0,
    display: 'flex', flexDirection: 'column' as const, gap: 8,
  },
  footerLabel: { fontSize: 12, fontWeight: 600, color: '#8E8E93' },
  appendRow:   { display: 'flex', gap: 8, alignItems: 'flex-end' },
  sendBtn: {
    padding: '0 16px', height: 44, borderRadius: 10,
    background: '#1e3a5f', color: '#FFFFFF',
    border: 'none', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', flexShrink: 0, transition: 'opacity 0.15s',
  },
  photoAddBtn: {
    padding: '0 14px', height: 38, borderRadius: 10,
    background: '#FFFFFF', color: '#1e3a5f',
    border: '1px solid #1e3a5f', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', transition: 'opacity 0.15s',
  },
} as const
