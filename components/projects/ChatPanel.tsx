'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { ConfirmableChange, QuickReply } from '@/lib/ai/chat/types'
import { Button } from '@/components/ui/button'

// ─────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────

type Role = 'user' | 'assistant'

type Message = {
  role: Role
  content: string
  streaming?: boolean
  pendingChanges?: ConfirmableChange[]
  quickReplies?: QuickReply[]
}

type ChangeStatus = 'idle' | 'confirming' | 'confirmed' | 'cancelled' | 'error'

type Props = { projectId: string }

// ─────────────────────────────────────────────────────────
// デザイントークン（RAGZ Green系）
// ─────────────────────────────────────────────────────────

const C = {
  bg:           '#F3F7F4',
  panelBorder:  '#D4E4D9',
  userBubble:   '#2B5E40',
  userText:     '#FFFFFF',
  aiBg:         'transparent',
  aiText:       '#1A1A18',
  inputBg:      '#FFFFFF',
  inputBorder:  '#D5DED8',
  inputFocus:   '#2B5E40',
  sendBtn:      '#3D7A55',
  sendDisabled: '#A8D4B5',
  divider:      '#DDEAE0',
  muted:        '#7A9185',
  headerBg:     '#FFFFFF',
  headerBorder: '#D4E4D9',
  // 変更カード（意味を持つ色：変更しない）
  cardBg:       '#FFFBEB',
  cardBorder:   '#F59E0B',
  cardTitle:    '#92400E',
  confirmBtn:   '#166534',
  confirmBg:    '#DCFCE7',
  cancelBg:     '#F3F4F6',
  cancelBtn:    '#6B7280',
  deleteBtn:    '#B91C1C',
  deleteBg:     '#FEE2E2',
  confirmedBg:  '#EAF3DE',
  confirmedText:'#166534',
  errorBg:      '#FEF2F2',
  errorText:    '#B91C1C',
  tableHead:    '#F0F6F2',
  tableBorder:  '#D4E4D9',
  tableStripe:  '#FAFCFA',
  // クイックリプライ
  qrBorder:     '#C8D9CC',
  qrBg:         '#FFFFFF',
  qrText:       '#1A1A18',
  qrPrimaryBg:  '#3D7A55',
  qrPrimaryText:'#FFFFFF',
}

const FONT = "'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif"

const CURRENCY_FIELDS = new Set(['selling_price', 'cost_price', 'budget_cost', 'actual_cost', 'amount', 'estimate_cost'])
const FIELD_LABELS: Record<string, string> = {
  name: '品名', quantity: '数量', unit: '単位',
  selling_price: '単価', memo: '備考',
  cost_price: '原価', vendor_name: '業者名',
  budget_cost: '実行予算', actual_cost: '実績原価', note: 'メモ',
  group_id: 'グループ',
}
function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (CURRENCY_FIELDS.has(key) && typeof v === 'number') return `¥${v.toLocaleString('ja-JP')}`
  return String(v)
}

// ─────────────────────────────────────────────────────────
// Markdown パーサー（Claude 風レンダリング）
// ─────────────────────────────────────────────────────────

type MDSpan =
  | { type: 'text';   text: string }
  | { type: 'bold';   text: string }
  | { type: 'italic'; text: string }
  | { type: 'code';   text: string }
  | { type: 'link';   text: string; href: string }

type MDBlock =
  | { type: 'paragraph'; spans: MDSpan[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'ul'; items: MDSpan[][] }
  | { type: 'ol'; items: MDSpan[][] }
  | { type: 'code'; lang: string; content: string }

function parseInline(text: string): MDSpan[] {
  const spans: MDSpan[] = []
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0; let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ type: 'text', text: text.slice(last, m.index) })
    if (m[1]) spans.push({ type: 'link',   text: m[1], href: m[2] })
    else if (m[3]) spans.push({ type: 'code',   text: m[3] })
    else if (m[4]) spans.push({ type: 'bold',   text: m[4] })
    else if (m[5]) spans.push({ type: 'italic', text: m[5] })
    last = re.lastIndex
  }
  if (last < text.length) spans.push({ type: 'text', text: text.slice(last) })
  return spans
}

function parseMarkdown(text: string): MDBlock[] {
  const lines  = text.split('\n')
  const blocks: MDBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // コードブロック
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const content: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { content.push(lines[i]); i++ }
      blocks.push({ type: 'code', lang, content: content.join('\n') })
      i++; continue
    }

    // テーブル
    if (line.startsWith('|')) {
      const headerCells = line.split('|').slice(1, -1).map(c => c.trim())
      if (i + 1 < lines.length && lines[i + 1].startsWith('|')) {
        i += 2
        const rows: string[][] = []
        while (i < lines.length && lines[i].startsWith('|')) {
          rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()))
          i++
        }
        blocks.push({ type: 'table', headers: headerCells, rows })
        continue
      }
    }

    // 箇条書き
    if (/^[-*] /.test(line)) {
      const items: MDSpan[][] = []
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(parseInline(lines[i].slice(2)))
        i++
      }
      blocks.push({ type: 'ul', items }); continue
    }

    // 番号リスト
    if (/^\d+\. /.test(line)) {
      const items: MDSpan[][] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, '')))
        i++
      }
      blocks.push({ type: 'ol', items }); continue
    }

    // 空行スキップ
    if (line.trim() === '') { i++; continue }

    // 段落
    const pLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') &&
           !lines[i].startsWith('|') && !/^[-*] /.test(lines[i]) && !/^\d+\. /.test(lines[i])) {
      pLines.push(lines[i]); i++
    }
    if (pLines.length) blocks.push({ type: 'paragraph', spans: parseInline(pLines.join('\n')) })
  }
  return blocks
}

function RenderSpan({ span }: { span: MDSpan }) {
  if (span.type === 'bold')   return <strong style={{ fontWeight: 600 }}>{span.text}</strong>
  if (span.type === 'italic') return <em>{span.text}</em>
  if (span.type === 'code')   return (
    <code style={{ background: '#EDE9E3', borderRadius: 4, padding: '1px 5px', fontSize: '0.88em', fontFamily: 'monospace', color: '#7C3AED' }}>
      {span.text}
    </code>
  )
  if (span.type === 'link')   return (
    <a href={span.href} target="_blank" rel="noopener noreferrer"
      style={{ color: '#7C3AED', textDecoration: 'underline', textDecorationColor: '#C4B5FD' }}>
      {span.text}
    </a>
  )
  return <>{span.text}</>
}

function RenderSpans({ spans }: { spans: MDSpan[] }) {
  return <>{spans.map((s, i) => <RenderSpan key={i} span={s} />)}</>
}

function RenderCellContent({ cell }: { cell: string }) {
  const spans = parseInline(cell)
  return <RenderSpans spans={spans} />
}

function MarkdownBlock({ block }: { block: MDBlock }) {
  if (block.type === 'code') return (
    <div style={{ background: '#EDE9E3', borderRadius: 8, overflow: 'hidden', fontSize: 13, fontFamily: 'monospace' }}>
      {block.lang && <div style={{ padding: '4px 12px', background: '#D6D1C9', fontSize: 11, color: '#6B6860', letterSpacing: '0.04em' }}>{block.lang}</div>}
      <pre style={{ margin: 0, padding: '10px 12px', overflowX: 'auto', lineHeight: 1.6, color: '#1A1A18' }}>{block.content}</pre>
    </div>
  )
  if (block.type === 'ul') return (
    <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {block.items.map((spans, i) => (
        <li key={i} style={{ fontSize: 14, lineHeight: 1.65, color: C.aiText }}><RenderSpans spans={spans} /></li>
      ))}
    </ul>
  )
  if (block.type === 'ol') return (
    <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {block.items.map((spans, i) => (
        <li key={i} style={{ fontSize: 14, lineHeight: 1.65, color: C.aiText }}><RenderSpans spans={spans} /></li>
      ))}
    </ol>
  )
  if (block.type === 'table') return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${C.tableBorder}` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontFamily: FONT }}>
        <thead>
          <tr style={{ background: C.tableHead }}>
            {block.headers.map((h, i) => (
              <th key={i} style={{ padding: '7px 11px', textAlign: 'left', fontWeight: 600, color: '#464038', borderBottom: `1px solid ${C.tableBorder}`, whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? '#fff' : C.tableStripe }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: '6px 11px', borderBottom: ri < block.rows.length - 1 ? `1px solid ${C.tableBorder}` : 'none', color: '#2D2C29', lineHeight: 1.5, maxWidth: 220, wordBreak: 'break-word' }}>
                  <RenderCellContent cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.aiText }}>
      <RenderSpans spans={block.spans} />
    </p>
  )
}

function MarkdownContent({ text, streaming }: { text: string; streaming?: boolean }) {
  // ストリーミング中は生テキストのみ表示（parseMarkdown は重いので完了後だけ呼ぶ）
  if (streaming) {
    return (
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
        <span style={{
          display: 'inline-block', width: 2, height: '1em',
          background: '#9B8EA0', borderRadius: 1,
          verticalAlign: 'text-bottom', marginLeft: 1,
          animation: 'cursorBlink 0.9s ease-in-out infinite',
        }} />
      </p>
    )
  }
  const blocks = parseMarkdown(text)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((block, i) => <MarkdownBlock key={i} block={block} />)}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// ChatPanel
// ─────────────────────────────────────────────────────────

export function ChatPanel({ projectId }: Props) {
  const [open, setOpen]         = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [changeStatuses, setChangeStatuses] = useState<Record<string, ChangeStatus>>({})
  const [usedSuggestionIdxs, setUsedSuggestionIdxs] = useState<Set<number>>(new Set())
  const bottomRef       = useRef<HTMLDivElement>(null)
  const inputRef        = useRef<HTMLTextAreaElement>(null)
  // streaming delta のバッファ — 一定量溜まるか 30ms 経過したら setMessages に流す
  const deltaBufferRef  = useRef('')
  const rafRef          = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 80) }
  }, [open])

  useEffect(() => {
    const handler = () => setOpen(prev => !prev)
    window.addEventListener('genba:open-chat', handler)
    return () => window.removeEventListener('genba:open-chat', handler)
  }, [])

  const setChangeStatus = useCallback((id: string, status: ChangeStatus) => {
    setChangeStatuses(prev => ({ ...prev, [id]: status }))
  }, [])

  const confirmChange = useCallback(async (change: ConfirmableChange) => {
    setChangeStatus(change.id, 'confirming')
    try {
      const res = await fetch('/api/ai/chat/confirm-change', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ change }),
      })
      if (!res.ok) { setChangeStatus(change.id, 'error'); return }
      setChangeStatus(change.id, 'confirmed')
      window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: change.target_table } }))
    } catch {
      setChangeStatus(change.id, 'error')
    }
  }, [setChangeStatus])

  const sendMessage = useCallback(async (text: string) => {
    if (loading) return

    const userMsg: Message = { role: 'user', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setLoading(true)

    // ストリーミング用の空メッセージを追加
    const streamingMsg: Message = { role: 'assistant', content: '', streaming: true }
    setMessages(prev => [...prev, streamingMsg])

    try {
      const res = await fetch('/api/ai/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          project_id: projectId,
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
        }),
      })

      if (!res.ok || !res.body) throw new Error('fetch failed')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          let event: {
            type: string
            delta?: string
            text?: string
            pending_changes?: ConfirmableChange[]
            suggestions?: QuickReply[]
            message?: string
          }
          try { event = JSON.parse(jsonStr) } catch { continue }

          if (event.type === 'text' && event.delta) {
            deltaBufferRef.current += event.delta
            // 30ms ごと、または 80文字以上溜まったらフラッシュ（滑らかさとCPU負荷のバランス）
            const flush = () => {
              const chunk = deltaBufferRef.current
              deltaBufferRef.current = ''
              rafRef.current = null
              if (!chunk) return
              setMessages(prev => {
                const updated = [...prev]
                const last    = updated[updated.length - 1]
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + chunk }
                }
                return updated
              })
            }
            if (deltaBufferRef.current.length >= 80) {
              // バッファが溜まったら即フラッシュ
              if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null }
              flush()
            } else if (rafRef.current === null) {
              rafRef.current = setTimeout(flush, 30)
            }
          } else if (event.type === 'done') {
            // 残りバッファをフラッシュしてから done を処理
            if (rafRef.current !== null) {
              clearTimeout(rafRef.current)
              rafRef.current = null
            }
            if (deltaBufferRef.current) {
              const chunk = deltaBufferRef.current
              deltaBufferRef.current = ''
              setMessages(prev => {
                const updated = [...prev]
                const last    = updated[updated.length - 1]
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + chunk }
                }
                return updated
              })
            }
            setMessages(prev => {
              const updated = [...prev]
              const last    = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  streaming:      false,
                  pendingChanges: event.pending_changes?.length ? event.pending_changes : undefined,
                  quickReplies:   event.suggestions?.length     ? event.suggestions     : undefined,
                }
              }
              return updated
            })
          } else if (event.type === 'error') {
            if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null }
            deltaBufferRef.current = ''
            setMessages(prev => {
              const updated = [...prev]
              const last    = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = { ...last, streaming: false, content: `エラーが発生しました: ${event.message ?? '不明なエラー'}` }
              }
              return updated
            })
          }
        }
      }
    } catch {
      if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null }
      deltaBufferRef.current = ''
      setMessages(prev => {
        const updated = [...prev]
        const last    = updated[updated.length - 1]
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = { ...last, streaming: false, content: 'ネットワークエラーが発生しました。もう一度お試しください。' }
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }, [loading, messages, projectId])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setInput('')
    sendMessage(text)
  }, [input, sendMessage])

  const handleSuggestionClick = useCallback((msgIndex: number, reply: QuickReply) => {
    if (reply.url) { window.open(reply.url, '_blank', 'noopener,noreferrer'); return }
    setUsedSuggestionIdxs(prev => new Set([...prev, msgIndex]))
    sendMessage(reply.message)
  }, [sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME変換中のEnterでは送信しない（日本語変換確定のEnterを除外）
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <style>{`
        @keyframes cursorBlink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }
        @keyframes msgFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .chat-msg-enter { animation: msgFadeIn 0.18s ease-out forwards; }
      `}</style>

      {/* ── チャットパネル ── */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 80, right: 12,
          width: 'min(780px, calc(100vw - 24px))',
          height: 'min(700px, calc(100vh - 100px))',
          background: C.bg,
          borderRadius: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)',
          border: `1px solid ${C.panelBorder}`,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden', zIndex: 1000, fontFamily: FONT,
        }}>

          {/* ── ヘッダー ── */}
          <div style={{
            background: C.headerBg, flexShrink: 0,
            padding: '0 16px', height: 52,
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: `1px solid ${C.headerBorder}`,
          }}>
            <AiLogo size={26} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A18', lineHeight: 1.2 }}>現場AI アシスタント</div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1 }}>見積・カタログ・原価を質問できます</div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="チャットを閉じる"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: C.muted, display: 'flex', borderRadius: 8, transition: 'background 0.12s' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#EAE7E1')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <CloseIcon />
            </button>
          </div>

          {/* ── メッセージ一覧 ── */}
          <div style={{
            flex: 1, overflowY: 'auto', padding: '20px 20px 8px',
            display: 'flex', flexDirection: 'column', gap: 0,
          }}>
            {messages.length === 0 && <EmptyState onHintClick={sendMessage} />}

            {messages.map((msg, i) => (
              <div key={i} className="chat-msg-enter" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                <MessageBubble msg={msg} />
                {msg.role === 'assistant' && msg.quickReplies && !usedSuggestionIdxs.has(i) && (
                  <QuickReplyButtons
                    replies={msg.quickReplies}
                    onSelect={(reply) => handleSuggestionClick(i, reply)}
                    disabled={loading}
                  />
                )}
                {msg.pendingChanges?.map(change => (
                  <PendingChangeCard
                    key={change.id}
                    change={change}
                    status={changeStatuses[change.id] ?? 'idle'}
                    onConfirm={() => confirmChange(change)}
                    onCancel={() => setChangeStatus(change.id, 'cancelled')}
                  />
                ))}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* ── 入力エリア ── */}
          <div style={{
            borderTop: `1px solid ${C.divider}`, padding: '8px 12px 10px',
            background: C.bg, flexShrink: 0,
          }}>
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-end',
              background: C.inputBg,
              border: `1.5px solid ${C.inputBorder}`,
              borderRadius: 8,
              padding: '6px 6px 6px 12px',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            }}
              onFocusCapture={e => {
                e.currentTarget.style.borderColor = C.inputFocus
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(43,94,64,0.12)'
              }}
              onBlurCapture={e => {
                e.currentTarget.style.borderColor = C.inputBorder
                e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  e.target.style.height = '22px'
                  const next = Math.min(e.target.scrollHeight, 120)
                  e.target.style.height = next + 'px'
                  e.target.style.overflowY = next >= 120 ? 'auto' : 'hidden'
                }}
                onKeyDown={handleKeyDown}
                placeholder="メッセージを入力… (Enterで送信)"
                disabled={loading}
                rows={1}
                style={{
                  flex: 1, background: 'transparent',
                  border: 'none', outline: 'none',
                  fontSize: 14, fontFamily: FONT,
                  color: '#1A1A18', resize: 'none',
                  lineHeight: 1.6, height: '22px', maxHeight: 120, overflowY: 'hidden',
                  padding: 0,
                }}
              />
              <Button
                type="button"
                variant="primary"
                size="icon"
                aria-label="送信"
                onClick={send}
                disabled={!input.trim() || loading}
                className="flex-shrink-0 self-end"
              >
                <SendIcon />
              </Button>
            </div>
            <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 7 }}>
              AIによる整理結果です。最終判断は担当者が行ってください。
            </div>
          </div>
        </div>
      )}

    </>
  )
}

// ─────────────────────────────────────────────────────────
// MessageBubble — Claude 風
// ─────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'

  if (isUser) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          maxWidth: '75%',
          background: C.userBubble,
          color: C.userText,
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 16px',
          fontSize: 14, lineHeight: 1.65,
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</span>
        </div>
      </div>
    )
  }

  // AI レスポンス: アイコン + テキスト（バブルなし）
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        <AiLogo size={28} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.content || msg.streaming ? (
          <MarkdownContent text={msg.content} streaming={msg.streaming} />
        ) : (
          <ThinkingDots />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// ThinkingDots — ツール実行中など空content時
// ─────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', height: 24 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%', background: '#C5BFB8',
          display: 'inline-block',
          animation: `thinkPulse 1.4s ease-in-out ${i * 0.18}s infinite`,
        }} />
      ))}
      <style>{`
        @keyframes thinkPulse {
          0%, 60%, 100% { transform: scale(1); opacity: 0.5; }
          30%            { transform: scale(1.4); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// PendingChangeCard
// ─────────────────────────────────────────────────────────

function PendingChangeCard({
  change, status, onConfirm, onCancel,
}: {
  change: ConfirmableChange
  status: ChangeStatus
  onConfirm: () => void
  onCancel: () => void
}) {
  if (status === 'cancelled') return null

  const isDelete     = change.change_type === 'delete'
  const isCreate     = change.change_type === 'create' || change.change_type === 'bulk_create'
  const isBulkCreate = change.change_type === 'bulk_create'
  const typeLabel: Record<string, string> = { create: '追加', update: '変更', delete: '削除', bulk_create: '一括コピー' }
  const typeIcon:  Record<string, string> = { create: '＋', update: '✎', delete: '✕', bulk_create: '⊕' }
  const label = typeLabel[change.change_type] ?? '変更'
  const icon  = typeIcon[change.change_type]  ?? '✎'

  if (status === 'confirmed') {
    return (
      <div style={{
        background: C.confirmedBg, border: `1px solid #86EFAC`,
        borderRadius: 10, padding: '9px 14px', marginLeft: 40,
        fontSize: 13, color: C.confirmedText,
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <span style={{ fontSize: 15 }}>✓</span>
        <div>
          <span style={{ fontWeight: 600 }}>確定しました — </span>
          <span style={{ color: '#3B6D11' }}>{change.diff_summary}</span>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={{
        background: C.errorBg, border: `1px solid #FCA5A5`,
        borderRadius: 10, padding: '9px 14px', marginLeft: 40,
        fontSize: 13, color: C.errorText,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 3 }}>確定に失敗しました</div>
        <div>もう一度お試しいただくか、チャットで再度指示してください。</div>
      </div>
    )
  }

  const diffRows = buildDiffRows(change)

  return (
    <div style={{
      background: C.cardBg, border: `1px solid ${C.cardBorder}`,
      borderRadius: 10, overflow: 'hidden', marginLeft: 40,
      opacity: status === 'confirming' ? 0.7 : 1, transition: 'opacity 0.2s',
    }}>
      <div style={{
        padding: '9px 14px', background: '#FFFBEB',
        borderBottom: `1px solid ${C.cardBorder}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.cardTitle }}>{icon} {label}の提案</span>
        <span style={{ fontSize: 12, color: '#B45309', flex: 1 }}>{change.diff_summary}</span>
      </div>
      {diffRows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#FEF3C7' }}>
              <th style={thStyle}>項目</th>
              {!isCreate && <th style={thStyle}>変更前</th>}
              <th style={thStyle}>{isCreate ? '値' : '変更後'}</th>
            </tr>
          </thead>
          <tbody>
            {diffRows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? '#FFFBEB' : '#FFF7D6' }}>
                <td style={tdLabelStyle}>{row.label}</td>
                {!isCreate && (
                  <td style={{ ...tdStyle, color: '#9A3412', textDecoration: row.after !== null ? 'line-through' : 'none' }}>
                    {row.before}
                  </td>
                )}
                <td style={{ ...tdStyle, color: isDelete ? '#9A3412' : '#166534', fontWeight: 600 }}>{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ padding: '8px 14px 12px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={status === 'confirming'}
        >
          キャンセル
        </Button>
        <Button
          type="button"
          variant={isDelete ? 'danger' : 'primary'}
          size="sm"
          onClick={onConfirm}
          disabled={status === 'confirming'}
        >
          {status === 'confirming' ? '処理中…' : isDelete ? '確定（削除）' : isBulkCreate ? '確定（一括追加）' : '確定する'}
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// diff 行の構築
// ─────────────────────────────────────────────────────────

type DiffRow = { label: string; before: string | null; after: string }

function buildDiffRows(change: ConfirmableChange): DiffRow[] {
  const { change_type, proposed, original } = change
  const SKIP = new Set(['id', 'project_id', 'company_id'])

  if (change_type === 'bulk_create') {
    const items = (proposed.items as Record<string, unknown>[] | undefined) ?? []
    const preview = items.slice(0, 5)
    const more = items.length - preview.length
    return [
      ...preview.map(item => ({
        label: `${item.quantity ?? 1}${item.unit ?? '式'}`,
        before: null,
        after:  `${item.name}　${fmtValue('selling_price', item.selling_price)}`,
      })),
      ...(more > 0 ? [{ label: '他', before: null, after: `…他${more}件` }] : []),
    ]
  }
  if (change_type === 'create') {
    return Object.entries(proposed)
      .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ({ label: FIELD_LABELS[k] ?? k, before: null, after: fmtValue(k, v) }))
  }
  if (change_type === 'delete') {
    const orig = original ?? {}
    return Object.entries(orig)
      .filter(([k]) => !SKIP.has(k) && orig[k] !== null && orig[k] !== undefined)
      .slice(0, 5)
      .map(([k, v]) => ({ label: FIELD_LABELS[k] ?? k, before: fmtValue(k, v), after: '（削除）' }))
  }
  return Object.entries(proposed)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, newVal]) => ({
      label:  FIELD_LABELS[k] ?? k,
      before: fmtValue(k, original ? original[k] : undefined),
      after:  fmtValue(k, newVal),
    }))
}

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', fontSize: 11,
  fontWeight: 600, color: '#92400E', borderBottom: '1px solid #F59E0B',
}
const tdStyle: React.CSSProperties = { padding: '4px 8px', fontSize: 12 }
const tdLabelStyle: React.CSSProperties = {
  ...tdStyle, color: '#464F60', fontWeight: 500, whiteSpace: 'nowrap',
}

// ─────────────────────────────────────────────────────────
// QuickReplyButtons
// ─────────────────────────────────────────────────────────

function QuickReplyButtons({
  replies, onSelect, disabled,
}: {
  replies: QuickReply[]
  onSelect: (reply: QuickReply) => void
  disabled: boolean
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginLeft: 40 }}>
      {replies.map((r, i) => {
        const isUrl     = Boolean(r.url)
        const isPrimary = r.variant === 'primary'
        const bg        = isUrl ? '#EFF6FF' : isPrimary ? C.qrPrimaryBg : C.qrBg
        const color     = isUrl ? '#1D4ED8' : isPrimary ? C.qrPrimaryText : C.qrText
        const border    = isUrl ? '#93C5FD' : isPrimary ? '#1E3A5F' : C.qrBorder

        return (
          <button key={i} onClick={() => onSelect(r)} disabled={disabled && !isUrl} style={{
            position: 'relative',
            padding: '6px 14px',
            paddingRight: r.badge ? 44 : 14,
            borderRadius: 20,
            border: `1.5px solid ${border}`,
            background: bg, color,
            fontSize: 13, fontFamily: FONT, fontWeight: 500,
            cursor: (disabled && !isUrl) ? 'default' : 'pointer',
            opacity: (disabled && !isUrl) ? 0.5 : 1,
            transition: 'background 0.12s, opacity 0.12s',
            whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center', gap: 5,
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}>
            {isUrl && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            )}
            {r.label}
            {r.badge && (
              <span style={{
                position: 'absolute', top: -6, right: 6,
                background: '#3B82F6', color: '#fff',
                fontSize: 9, fontWeight: 700,
                padding: '1px 5px', borderRadius: 6, lineHeight: 1.5,
              }}>{r.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────────────────

const HINTS = [
  '「水回りのシステムバスをカタログから追加して」',
  '「防水工事の見積を調べて」',
  '「システムバスの相場はいくら？」',
  '「この見積で足りない項目はある？」',
]

function EmptyState({ onHintClick }: { onHintClick: (text: string) => void }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 20, padding: '32px 16px',
      color: C.muted, textAlign: 'center',
    }}>
      <AiLogo size={48} />
      <div>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: '#1A1A18' }}>
          現場AI アシスタント
        </p>
        <p style={{ fontSize: 13, margin: 0, lineHeight: 1.7, color: C.muted }}>
          見積・原価・カタログを検索したり、<br />変更提案を出すことができます
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 480 }}>
        {HINTS.map((h, i) => (
          <button key={i} onClick={() => {
            // ダブルクォーテーションを除いたテキストで送信
            onHintClick(h.replace(/^「|」$/g, ''))
          }} style={{
            fontSize: 13, background: C.inputBg,
            border: `1px solid ${C.divider}`,
            borderRadius: 10, padding: '9px 14px',
            color: '#464038', textAlign: 'left',
            cursor: 'pointer', fontFamily: FONT,
            transition: 'border-color 0.12s, background 0.12s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = C.inputFocus
              e.currentTarget.style.background = '#F5F3F0'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = C.divider
              e.currentTarget.style.background = C.inputBg
            }}
          >
            {h}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// アイコン
// ─────────────────────────────────────────────────────────

function AiLogo({ size = 28, color }: { size?: number; color?: string }) {
  if (color) {
    // FAB 用シンプルアイコン
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    )
  }
  // Avatar ロゴ: 現場AI のブランドカラーの円
  return (
    <div style={{
      width: size, height: size,
      borderRadius: size / 2,
      background: 'linear-gradient(135deg, #2B5E40 0%, #3D7A55 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
    }}>
      <svg width={size * 0.54} height={size * 0.54} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
    </div>
  )
}

function CloseIcon({ color = '#9B968E' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  )
}
