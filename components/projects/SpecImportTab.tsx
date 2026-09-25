'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'

// ── 型定義 ────────────────────────────────────────────────

type SpecResult = {
  overview: string
  requirements: string[]
  cautions: string[]
  budget_notes: string | null
  todos: string[]
  raw_warning: string | null
}
type EditableSection = {
  overview: string
  requirements: string
  cautions: string
  budget_notes: string
  todos: string
}
type SpecPart = { part: string; spec: string; maker: string; product: string }
type SpecRoom = { room_name: string; parts: SpecPart[] }
type SpecDetailResult = { rooms: SpecRoom[]; unmatched: string | null; raw_warning: string | null }
type ProjectNote = { id: string; content: string; source: string; created_at: string }
type NoteGroup = { dateKey: string; dateLabel: string; notes: ProjectNote[] }
type ActionStatus = 'idle' | 'saving' | 'saved' | 'error'
type InputMode  = 'file' | 'text'
type OutputMode = 'memo' | 'spec'

// ラベル種別ごとの色
const LABEL_COLORS: Record<string, string> = {
  '工事概要':     '#2B5E40',
  '施主要望・仕様': '#1e3a5f',
  '注意・確認事項': '#9A3412',
  'ToDo・作業項目': '#5B21B6',
  '概算予算感':   '#92400E',
}
function labelColor(label: string) { return LABEL_COLORS[label] ?? '#4E6557' }

const PARTS_ORDER = ['天井', '壁', '床', '廻り縁', '巾木', '建具', '照明器具', '住宅設備', '他'] as const

// ── デザイントークン ──────────────────────────────────────

const G = {
  dark: '#2B5E40', med: '#3D7A55', light: '#E3EFE7', hover: '#EDF5EF',
  cardBg: '#FFFFFF', border: '#BDD1C3', borderLight: '#DFF0E4',
  textPri: '#192C1F', textSec: '#4E6557', textTer: '#8AA491',
} as const
const E = { bg: '#2B5E40', light: '#EFF6FF', border: '#BFDBFE' } as const

// ── ユーティリティ ────────────────────────────────────────

function buildNoteContent(label: string, body: string) { return `【${label}】\n${body.trim()}` }
function noteLabel(content: string) { return content.match(/^【(.+?)】/)?.[1] ?? '現場メモ' }
function noteBody(content: string) { return content.replace(/^【.+?】\n?/, '').trim() }
function parseNoteLines(content: string) {
  return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('【'))
}
function toEditableSection(r: SpecResult): EditableSection {
  return {
    overview: r.overview,
    requirements: r.requirements.join('\n'),
    cautions: r.cautions.join('\n'),
    budget_notes: r.budget_notes ?? '',
    todos: r.todos.join('\n'),
  }
}
function groupNotesByDate(notes: ProjectNote[]): NoteGroup[] {
  const map = new Map<string, ProjectNote[]>()
  for (const note of notes) {
    const d = new Date(note.created_at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(note)
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, ns]) => {
      const d = new Date(key)
      return {
        dateKey: key,
        dateLabel: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
        notes: ns,
      }
    })
}

// ── メインコンポーネント ──────────────────────────────────

export function SpecImportTab({ projectId }: { projectId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [outputMode, setOutputMode] = useState<OutputMode>('memo')

  // 保存済みメモ
  const [notes, setNotes]           = useState<ProjectNote[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  const [noteEstimate, setNoteEstimate] = useState<Record<string, ActionStatus>>({})

  // 日付アコーディオン（最新グループをデフォルト展開）
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

  // インポートパネル表示
  const [showImport, setShowImport] = useState(false)

  // インポートフォーム
  const [inputMode, setInputMode]   = useState<InputMode>('file')
  const [files, setFiles]           = useState<File[]>([])
  const [text, setText]             = useState('')
  const [dragging, setDragging]     = useState(false)
  const [loading, setLoading]       = useState(false)
  const [result, setResult]         = useState<SpecResult | null>(null)
  const [edited, setEdited]         = useState<EditableSection | null>(null)
  const [noteStatus, setNoteStatus] = useState<Record<string, ActionStatus>>({})
  const [estimateStatus, setEstimateStatus] = useState<Record<string, ActionStatus>>({})
  const [error, setError]           = useState<string | null>(null)

  // 仕様書Excelモード
  const [specText, setSpecText]       = useState('')
  const [specLoading, setSpecLoading] = useState(false)
  const [specResult, setSpecResult]   = useState<SpecDetailResult | null>(null)
  const [specEdited, setSpecEdited]   = useState<SpecRoom[]>([])
  const [specError, setSpecError]     = useState<string | null>(null)
  const [exporting, setExporting]     = useState<'大' | '中' | null>(null)

  const noteGroups = useMemo(() => groupNotesByDate(notes), [notes])

  useEffect(() => { fetchNotes() }, [projectId])

  async function fetchNotes() {
    setNotesLoading(true)
    let groups: NoteGroup[] = []
    try {
      const res = await fetch(`/api/project-notes?project_id=${projectId}`)
      if (res.ok) {
        const data: ProjectNote[] = await res.json()
        groups = groupNotesByDate(data)
        setNotes(data)
      }
    } finally {
      setNotesLoading(false)
      if (groups.length > 0) {
        setExpandedDates(new Set([groups[0].dateKey]))
      } else {
        setShowImport(true)
      }
    }
  }

  function toggleDate(key: string) {
    setExpandedDates(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function addFiles(fl: FileList | File[]) {
    const arr = Array.from(fl).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf').slice(0, 5)
    setFiles(arr); setResult(null); setEdited(null); setError(null)
  }

  async function extract() {
    if (inputMode === 'file' && !files.length) return
    if (inputMode === 'text' && !text.trim()) return
    setLoading(true); setError(null)
    try {
      const fd = new FormData()
      if (inputMode === 'file') files.forEach(f => fd.append('files', f))
      else fd.append('text', text)
      const res = await fetch('/api/ai/extract-spec', { method: 'POST', body: fd })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      const data: SpecResult = await res.json()
      setResult(data); setEdited(toEditableSection(data))
      setNoteStatus({}); setEstimateStatus({})
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み取りに失敗しました')
    } finally { setLoading(false) }
  }

  async function addNote(key: string, label: string, body: string) {
    if (!body.trim()) return
    setNoteStatus(prev => ({ ...prev, [key]: 'saving' }))
    try {
      const res = await fetch('/api/project-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, content: buildNoteContent(label, body) }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      setNoteStatus(prev => ({ ...prev, [key]: 'saved' }))
      fetchNotes()
    } catch { setNoteStatus(prev => ({ ...prev, [key]: 'error' })) }
  }

  async function addToEstimate(key: string, body: string) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) return
    setEstimateStatus(prev => ({ ...prev, [key]: 'saving' }))
    try {
      await Promise.all(lines.map(line =>
        fetch('/api/estimate-items/manual', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, name: line }),
        })
      ))
      setEstimateStatus(prev => ({ ...prev, [key]: 'saved' }))
    } catch { setEstimateStatus(prev => ({ ...prev, [key]: 'error' })) }
  }

  async function addNoteToEstimate(noteId: string, content: string) {
    const lines = parseNoteLines(content)
    if (!lines.length) return
    setNoteEstimate(prev => ({ ...prev, [noteId]: 'saving' }))
    try {
      await Promise.all(lines.map(line =>
        fetch('/api/estimate-items/manual', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, name: line }),
        })
      ))
      setNoteEstimate(prev => ({ ...prev, [noteId]: 'saved' }))
    } catch { setNoteEstimate(prev => ({ ...prev, [noteId]: 'error' })) }
  }

  function updateEdited(patch: Partial<EditableSection>) {
    setEdited(prev => prev ? { ...prev, ...patch } : prev)
  }

  const canExtract = inputMode === 'file' ? files.length > 0 : text.trim().length > 0

  // ── 仕様書Excel ──────────────────────────────────────────

  async function extractSpec() {
    if (!specText.trim()) return
    setSpecLoading(true); setSpecError(null)
    try {
      const res = await fetch('/api/ai/extract-spec-detail', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: specText }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      const data: SpecDetailResult = await res.json()
      setSpecResult(data)
      setSpecEdited(data.rooms.map(r => ({
        room_name: r.room_name,
        parts: PARTS_ORDER.map(p => {
          const f = r.parts.find(x => x.part === p)
          return { part: p, spec: f?.spec ?? '', maker: f?.maker ?? '', product: f?.product ?? '' }
        }),
      })))
    } catch (e) { setSpecError(e instanceof Error ? e.message : 'AI抽出に失敗しました')
    } finally { setSpecLoading(false) }
  }

  function updateSpecCell(ri: number, pi: number, field: 'spec' | 'maker' | 'product', value: string) {
    setSpecEdited(prev => prev.map((r, i) =>
      i === ri ? { ...r, parts: r.parts.map((p, j) => j === pi ? { ...p, [field]: value } : p) } : r
    ))
  }

  async function exportExcel(sheetType: '大' | '中') {
    if (!specResult) return
    setExporting(sheetType)
    try {
      const payload = {
        ...specResult,
        rooms: specEdited.map(r => ({
          room_name: r.room_name,
          parts: r.parts.filter(p => p.spec || p.maker || p.product).map(p => ({
            part: p.part, spec: p.spec || null, maker: p.maker || null, product: p.product || null,
          })),
        })).filter(r => r.parts.length > 0),
      }
      const res = await fetch('/api/spec-sheet/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: payload, sheet_type: sheetType }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `仕様書${sheetType}.xlsx`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { setSpecError(e instanceof Error ? e.message : 'Excel出力に失敗しました')
    } finally { setExporting(null) }
  }

  // ══════════════════════════════════════════════════════════

  return (
    <div style={s.root}>
      <style>{`
        @keyframes ei-spin { to { transform: rotate(360deg); } }
        @keyframes ei-progress { 0%{transform:translateX(-100%)} 50%{transform:translateX(0%)} 100%{transform:translateX(100%)} }
      `}</style>

      {/* 出力モード切替 */}
      <div style={s.topBar}>
        <div style={s.modeToggle}>
          {(['memo', 'spec'] as OutputMode[]).map(m => (
            <button key={m}
              style={{ ...s.modeBtn, ...(outputMode === m ? s.modeBtnActive : {}) }}
              onClick={() => setOutputMode(m)}
            >
              {m === 'memo' ? '現場メモ整理' : '仕様書Excel出力'}
            </button>
          ))}
        </div>
      </div>

      {/* ════ 現場メモ整理モード ════ */}
      {outputMode === 'memo' && (
        <>
          {/* 新しいメモを追加ボタン */}
          <button
            style={{ ...s.addBtn, ...(showImport ? s.addBtnOpen : {}) }}
            onClick={() => { setShowImport(p => !p); if (showImport) { setResult(null); setFiles([]); setText('') } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              {showImport
                ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                : <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>
              }
            </svg>
            {showImport ? 'キャンセル' : '新しいメモを追加'}
          </button>

          {/* インポートパネル（折りたたみ） */}
          {showImport && (
            <div style={s.importPanel}>
              {/* 入力タイプ切替 */}
              <div style={s.subToggle}>
                {(['file', 'text'] as InputMode[]).map(m => (
                  <button key={m}
                    style={{ ...s.subBtn, ...(inputMode === m ? s.subBtnActive : {}) }}
                    onClick={() => setInputMode(m)}
                  >
                    {m === 'file' ? 'ファイル読み込み' : 'テキスト貼り付け'}
                  </button>
                ))}
              </div>

              {/* ファイルモード */}
              {inputMode === 'file' && (
                <>
                  <div
                    style={{ ...s.dropZone, ...(dragging ? s.dropActive : {}) }}
                    onDragOver={e => { e.preventDefault(); setDragging(true) }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
                  >
                    <input ref={fileInputRef} type="file" multiple
                      accept="application/pdf,image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      onChange={e => e.target.files && addFiles(e.target.files)}
                    />
                    <div style={s.dropIcon}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                        stroke={G.med} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 16V8m0 0l-3 3m3-3l3 3"/>
                        <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
                      </svg>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: G.textPri }}>
                      ドラッグ＆ドロップ、またはクリック
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: G.textTer }}>PDF・JPEG・PNG・WebP（最大5件）</p>
                    <button style={s.browseBtn}
                      onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}>
                      ファイルを選択
                    </button>
                  </div>

                  {files.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {files.map((f, i) => (
                        <div key={i} style={s.fileRow}>
                          <span style={{ fontSize: 13, color: G.textPri, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.name}
                          </span>
                          <span style={{ fontSize: 11, color: G.textTer, flexShrink: 0 }}>
                            {(f.size / 1024).toFixed(0)} KB
                          </span>
                          {!loading && (
                            <button style={s.fileRemove}
                              onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}>
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* テキストモード */}
              {inputMode === 'text' && (
                <Textarea rows={8}
                  placeholder="打ち合わせメモ・ToDoリストのテキストをここに貼り付けてください…"
                  value={text} onChange={e => setText(e.target.value)}
                />
              )}

              {/* 実行ボタン */}
              <button
                style={{ ...s.runBtn, ...(!canExtract || loading ? s.runBtnDis : {}) }}
                onClick={extract} disabled={!canExtract || loading}
              >
                {loading
                  ? <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'ei-spin 1s linear infinite', marginRight: 6 }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>整理中…</>
                  : 'AIで整理する'
                }
              </button>

              {error && <div style={s.errorBox}>{error}</div>}

              {/* 整理結果（インポートパネル内に表示） */}
              {result && edited && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={s.resultBanner}>
                    <div style={s.resultDot} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: G.textPri }}>整理結果</span>
                    <span style={{ fontSize: 11, color: G.textTer }}>
                      内容を確認・修正してから保存してください
                    </span>
                  </div>

                  {result.raw_warning && <div style={s.warnBox}>⚠ {result.raw_warning}</div>}

                  {edited.overview && (
                    <ResultCard label="工事概要" noteKey="overview"
                      nSt={noteStatus} eSt={estimateStatus}
                      onNote={() => addNote('overview', '工事概要', edited.overview)}
                      onEstimate={() => addToEstimate('overview', edited.overview)}
                    >
                      <Textarea inputSize="compact" rows={3} value={edited.overview}
                        onChange={e => updateEdited({ overview: e.target.value })} />
                    </ResultCard>
                  )}
                  {result.requirements.length > 0 && (
                    <ResultCard label="施主要望・仕様" noteKey="requirements"
                      nSt={noteStatus} eSt={estimateStatus}
                      onNote={() => addNote('requirements', '施主要望・仕様', edited.requirements)}
                      onEstimate={() => addToEstimate('requirements', edited.requirements)}
                    >
                      <Textarea inputSize="compact" rows={Math.min(result.requirements.length + 1, 7)}
                        value={edited.requirements} onChange={e => updateEdited({ requirements: e.target.value })} />
                    </ResultCard>
                  )}
                  {result.cautions.length > 0 && (
                    <ResultCard label="注意・確認事項" noteKey="cautions"
                      nSt={noteStatus} eSt={estimateStatus}
                      onNote={() => addNote('cautions', '注意・確認事項', edited.cautions)}
                      onEstimate={() => addToEstimate('cautions', edited.cautions)}
                    >
                      <Textarea inputSize="compact" style={{ borderLeft: '3px solid #F97316' }}
                        rows={Math.min(result.cautions.length + 1, 7)}
                        value={edited.cautions} onChange={e => updateEdited({ cautions: e.target.value })} />
                    </ResultCard>
                  )}
                  {result.todos.length > 0 && (
                    <ResultCard label="ToDo・作業項目" noteKey="todos"
                      nSt={noteStatus} eSt={estimateStatus}
                      onNote={() => addNote('todos', 'ToDo・作業項目', edited.todos)}
                      onEstimate={() => addToEstimate('todos', edited.todos)}
                    >
                      <Textarea inputSize="compact" rows={Math.min(result.todos.length + 1, 7)}
                        value={edited.todos} onChange={e => updateEdited({ todos: e.target.value })} />
                    </ResultCard>
                  )}
                  {result.budget_notes && (
                    <ResultCard label="概算予算感" noteKey="budget"
                      nSt={noteStatus} eSt={estimateStatus}
                      onNote={() => addNote('budget', '概算予算感', edited.budget_notes)}
                    >
                      <div style={s.budgetWarning}>※打ち合わせ時の概算。正式見積前の参考値</div>
                      <Textarea inputSize="compact" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}
                        rows={3} value={edited.budget_notes}
                        onChange={e => updateEdited({ budget_notes: e.target.value })} />
                    </ResultCard>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── メモ一覧（日付グループ） ── */}
          {notesLoading ? (
            <div style={s.emptyState}>
              <p style={{ margin: 0, fontSize: 14, color: G.textTer }}>読み込み中…</p>
            </div>
          ) : noteGroups.length === 0 ? (
            <div style={s.emptyState}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                stroke={G.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <p style={{ margin: '8px 0 0', fontSize: 14, color: G.textTer }}>まだメモがありません</p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: G.textTer }}>
                上の「新しいメモを追加」からAI整理を始めてください
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {noteGroups.map(group => (
                <div key={group.dateKey}>
                  {/* 日付ヘッダー（タップで折りたたみ） */}
                  <button
                    style={s.dateHeader}
                    onClick={() => toggleDate(group.dateKey)}
                  >
                    <span style={s.dateLine} />
                    <span style={s.dateLabel}>{group.dateLabel}</span>
                    <span style={s.dateLine} />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke={G.textTer} strokeWidth="2.5" strokeLinecap="round"
                      style={{ flexShrink: 0, transform: expandedDates.has(group.dateKey) ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>

                  {/* その日のメモカード */}
                  {expandedDates.has(group.dateKey) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, marginBottom: 12 }}>
                      {group.notes.map(note => {
                        const label = noteLabel(note.content)
                        const body  = noteBody(note.content)
                        const lines = parseNoteLines(note.content)
                        const est   = noteEstimate[note.id] ?? 'idle'
                        const d     = new Date(note.created_at)
                        const time  = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
                        const color = labelColor(label)
                        return (
                          <div key={note.id} style={{ ...s.noteCard, borderLeft: `4px solid ${color}` }}>
                            <div style={s.noteCardTop}>
                              <span style={{ ...s.labelBadge, background: color + '18', color, borderColor: color + '40' }}>
                                {label}
                              </span>
                              <span style={{ fontSize: 11, color: G.textTer }}>{time}</span>
                            </div>
                            <p style={s.noteCardBody}>{body}</p>
                            {lines.length > 0 && (
                              <div style={s.noteCardFooter}>
                                {est === 'saved' ? (
                                  <span style={s.estDoneBadge}>✓ 見積に追加済み</span>
                                ) : (
                                  <button
                                    style={{ ...s.estBtn, ...(est === 'saving' ? { opacity: 0.5 } : {}) }}
                                    onClick={() => addNoteToEstimate(note.id, note.content)}
                                    disabled={est === 'saving'}
                                  >
                                    {est === 'saving' ? '追加中…' : `見積エディタに追加（${lines.length}件）`}
                                  </button>
                                )}
                                {est === 'error' && <span style={{ fontSize: 11, color: '#991B1B' }}>失敗</span>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ════ 仕様書Excelモード ════ */}
      {outputMode === 'spec' && (
        <>
          <p style={{ fontSize: 13, color: G.textSec, margin: 0, lineHeight: 1.7 }}>
            打ち合わせの音声テキスト・要約メモを貼り付けてください。<br />
            「トイレの壁はサンゲツの○○で、LDKの床は…」のような会話をそのまま貼り付けてOKです。
          </p>
          <Textarea rows={10}
            placeholder={'例：\nトイレの天井と壁はサンゲツのAA級壁紙にします。品番はSP-2865。\nLDKの床はウッドワンのフローリング（ナチュラルオーク）。\n玄関ホールはサンゲツSP級。\n洋室①の照明はシーリングライト。'}
            value={specText} onChange={e => setSpecText(e.target.value)}
          />
          <button
            style={{ ...s.runBtn, ...(!specText.trim() || specLoading ? s.runBtnDis : {}) }}
            onClick={extractSpec} disabled={!specText.trim() || specLoading}
          >
            {specLoading ? '抽出中…' : 'AIで仕様書を抽出する'}
          </button>

          {specError && <div style={s.errorBox}>{specError}</div>}

          {specResult && specEdited.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={s.resultBanner}>
                <div style={s.resultDot} />
                <span style={{ fontSize: 14, fontWeight: 700, color: G.textPri }}>AI抽出結果</span>
                <span style={{ fontSize: 11, color: G.textTer }}>確認・編集してからExcel出力してください</span>
              </div>
              {specResult.raw_warning && <div style={s.warnBox}>⚠ {specResult.raw_warning}</div>}

              {specEdited.map((room, ri) => (
                <div key={ri} style={{ background: G.cardBg, border: `1.5px solid ${G.borderLight}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ background: G.light, padding: '8px 14px', fontSize: 13, fontWeight: 700, color: G.dark, borderBottom: `1px solid ${G.borderLight}` }}>
                    {room.room_name}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#FAFDFB' }}>
                          <th style={{ ...thStyle, width: 72 }}>部位</th>
                          <th style={thStyle}>仕様</th>
                          <th style={thStyle}>メーカー・商品</th>
                          <th style={thStyle}>品番・色</th>
                        </tr>
                      </thead>
                      <tbody>
                        {room.parts.map((part, pi) => (
                          <tr key={pi} style={{ borderBottom: `1px solid ${G.borderLight}`, background: pi % 2 === 0 ? '#fff' : '#FAFDFB' }}>
                            <td style={{ padding: '4px 10px', fontWeight: 600, color: G.textSec, whiteSpace: 'nowrap', fontSize: 11 }}>{part.part}</td>
                            {(['spec', 'maker', 'product'] as const).map(field => (
                              <td key={field} style={{ padding: '3px 6px' }}>
                                <input value={part[field]}
                                  onChange={e => updateSpecCell(ri, pi, field, e.target.value)}
                                  placeholder="—"
                                  style={{ width: '100%', border: '1px solid transparent', borderRadius: 4, padding: '4px 6px', fontSize: 12, background: 'transparent', color: G.textPri, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                                  onFocus={e => { e.target.style.borderColor = G.border; e.target.style.background = G.hover }}
                                  onBlur={e => { e.target.style.borderColor = 'transparent'; e.target.style.background = 'transparent' }}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {specResult.unmatched && (
                <div style={{ ...s.warnBox, background: '#F0FDF4', borderColor: G.borderLight, color: G.textSec }}>
                  <strong>テンプレート外の情報：</strong> {specResult.unmatched}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button style={{ ...s.runBtn, width: 'auto', padding: '0 20px', background: exporting ? G.border : G.med, fontSize: 13 }}
                  onClick={() => exportExcel('中')} disabled={!!exporting}>
                  {exporting === '中' ? '出力中...' : 'Excel出力（仕様書中）'}
                </button>
                <button style={{ ...s.runBtn, width: 'auto', padding: '0 20px', background: exporting ? G.border : G.dark, fontSize: 13 }}
                  onClick={() => exportExcel('大')} disabled={!!exporting}>
                  {exporting === '大' ? '出力中...' : 'Excel出力（仕様書大）'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── 整理結果カード ────────────────────────────────────────

function ResultCard({ label, noteKey, nSt, eSt, onNote, onEstimate, children }: {
  label: string
  noteKey: string
  nSt: Record<string, ActionStatus>
  eSt: Record<string, ActionStatus>
  onNote: () => void
  onEstimate?: () => void
  children: React.ReactNode
}) {
  const ns = nSt[noteKey] ?? 'idle'
  const es = eSt[noteKey] ?? 'idle'
  const color = labelColor(label)
  return (
    <div style={{ border: `1px solid ${G.border}`, borderRadius: 10, overflow: 'hidden', background: G.cardBg, borderLeft: `4px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: G.hover, borderBottom: `1px solid ${G.borderLight}`, gap: 8 }}>
        <span style={{ ...rc.label, color }}>{label}</span>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {onEstimate && (
            es === 'saved'
              ? <span style={rc.estDone}>✓ 見積追加済み</span>
              : <button style={{ ...rc.btn, background: E.bg, ...(es === 'saving' ? { opacity: 0.5 } : {}) }}
                  onClick={onEstimate} disabled={es === 'saving'}>
                  {es === 'saving' ? '追加中…' : '見積に追加'}
                </button>
          )}
          {ns === 'saved'
            ? <span style={rc.noteDone}>✓ 保存済み</span>
            : <button style={{ ...rc.btn, ...(ns === 'saving' ? { opacity: 0.5 } : {}) }}
                onClick={onNote} disabled={ns === 'saving'}>
                {ns === 'saving' ? '保存中…' : 'メモへ保存'}
              </button>
          }
        </div>
      </div>
      <div style={{ padding: '10px 12px 12px' }}>{children}</div>
    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 20px 40px', background: G.hover, minHeight: 400 },

  topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  modeToggle: { display: 'flex', background: G.cardBg, border: `1px solid ${G.border}`, borderRadius: 8, padding: 3, gap: 3 },
  modeBtn: { padding: '7px 16px', fontSize: 13, fontWeight: 600, color: G.textTer, background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s' },
  modeBtnActive: { color: G.dark, background: G.light },

  // 新しいメモを追加ボタン
  addBtn: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 18px', borderRadius: 10,
    background: '#E3EFE7', color: '#2B5E40',
    border: '1px solid #BDD1C3', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    width: '100%', justifyContent: 'center',
    transition: 'background 0.15s, color 0.15s',
  },
  addBtnOpen: { background: G.hover, color: G.textSec, border: `1px solid ${G.borderLight}` },

  // インポートパネル
  importPanel: {
    background: G.cardBg, border: `1.5px solid ${G.border}`,
    borderRadius: 14, padding: '16px 16px 20px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  subToggle: { display: 'flex', background: G.hover, border: `1px solid ${G.borderLight}`, borderRadius: 6, padding: 3, gap: 3 },
  subBtn: { flex: 1, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: G.textTer, background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s' },
  subBtnActive: { color: G.dark, background: G.cardBg, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  dropZone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: 160, border: `2px dashed ${G.border}`, borderRadius: 12,
    padding: '24px 20px', cursor: 'pointer', background: G.hover,
    transition: 'border-color 0.15s, background 0.15s', gap: 6,
  },
  dropActive: { borderColor: G.dark, background: G.light },
  dropIcon: {
    width: 52, height: 52, borderRadius: '50%', background: G.light,
    border: `1.5px solid ${G.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  browseBtn: {
    marginTop: 4, padding: '7px 20px', background: G.cardBg,
    border: `1.5px solid ${G.border}`, borderRadius: 8,
    fontSize: 13, fontWeight: 600, color: G.textSec, cursor: 'pointer',
  },

  fileRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px', background: G.hover, borderRadius: 8,
  },
  fileRemove: { background: 'none', border: 'none', cursor: 'pointer', color: G.textTer, fontSize: 13, padding: '2px 4px', flexShrink: 0 },

  textarea: {
    width: '100%', padding: '12px 14px', border: `1px solid ${G.border}`,
    borderRadius: 10, fontSize: 13, lineHeight: 1.6, resize: 'vertical',
    outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: G.cardBg, color: G.textPri,
  },

  runBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 44, padding: '0 20px', borderRadius: 10,
    fontSize: 14, fontWeight: 700, border: 'none', cursor: 'pointer',
    width: '100%', background: G.dark, color: '#FFFFFF',
  },
  runBtnDis: { opacity: 0.45, cursor: 'not-allowed' },

  errorBox: { padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 13, color: '#991B1B' },
  warnBox: { padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 13, color: '#92400E' },

  resultBanner: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  resultDot: { width: 8, height: 8, borderRadius: '50%', background: G.dark, flexShrink: 0 },
  sectionTA: {
    width: '100%', padding: '10px 12px', border: `1px solid ${G.borderLight}`,
    borderRadius: 7, fontSize: 13, lineHeight: 1.6, resize: 'vertical',
    outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: G.hover, color: G.textPri,
  },
  budgetWarning: { fontSize: 11, color: '#92400E', fontWeight: 600, marginBottom: 6, padding: '3px 8px', background: '#FEF3C7', borderRadius: 4, display: 'inline-block' },

  // 日付グループ
  dateHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', background: 'none', border: 'none', cursor: 'pointer',
    padding: '10px 0 6px', marginTop: 6,
  },
  dateLine: { flex: 1, height: 1, background: G.border },
  dateLabel: { fontSize: 12, fontWeight: 700, color: G.textSec, whiteSpace: 'nowrap', flexShrink: 0 },

  // メモカード
  noteCard: {
    background: G.cardBg, borderRadius: 10,
    border: `1px solid ${G.borderLight}`,
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  noteCardTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderBottom: `1px solid ${G.borderLight}` },
  labelBadge: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, border: '1px solid' },
  noteCardBody: { margin: 0, padding: '10px 14px', fontSize: 13, color: G.textSec, lineHeight: 1.7, whiteSpace: 'pre-wrap' },
  noteCardFooter: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '8px 14px 10px', borderTop: `1px solid ${G.borderLight}` },

  estBtn: {
    padding: '6px 14px', background: E.bg, color: '#fff',
    border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  estDoneBadge: { fontSize: 12, fontWeight: 600, color: E.bg, background: E.light, border: `1px solid ${E.border}`, padding: '4px 10px', borderRadius: 6 },

  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '48px 24px', background: G.cardBg, borderRadius: 14,
    border: `1.5px dashed ${G.border}`,
  },
}

const rc: Record<string, React.CSSProperties> = {
  label: { fontSize: 13, fontWeight: 700, flex: 1 },
  btn: { padding: '5px 12px', background: G.dark, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  noteDone: { fontSize: 12, fontWeight: 600, color: G.dark, background: G.light, border: `1px solid ${G.border}`, padding: '4px 10px', borderRadius: 6, flexShrink: 0 },
  estDone: { fontSize: 12, fontWeight: 600, color: E.bg, background: E.light, border: `1px solid ${E.border}`, padding: '4px 10px', borderRadius: 6, flexShrink: 0 },
}

const thStyle: React.CSSProperties = {
  padding: '6px 10px', fontSize: 11, fontWeight: 700, color: G.textSec,
  textAlign: 'left', borderBottom: `1px solid ${G.borderLight}`, whiteSpace: 'nowrap',
}
