'use client'

/**
 * CompanyChat.tsx
 *
 * 案件一覧ページ用の「会社全体AIチャット」モーダル。
 * project_id なしで /api/ai/chat を呼び出し（会社全体モード）。
 * ChatPanel.tsx から SSE 消費ロジックを継承し、モーダル形式で表示する。
 *
 * 使用するツール: list_projects_status / get_project_summary /
 *   get_invoice_status / get_unpaid_milestones / create_invoice_draft
 *
 * セキュリティ: project_id をリクエストに含めない。
 *   companyId はサーバー側認証コンテキストから自動取得。
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import type { ConfirmableChange, QuickReply } from '@/lib/ai/chat/types'

// ─────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────

type Role = 'user' | 'assistant'

type Message = {
  role:           Role
  content:        string
  streaming?:     boolean
  pendingChanges?: ConfirmableChange[]
  quickReplies?:  QuickReply[]
}

type ChangeStatus = 'idle' | 'confirming' | 'confirmed' | 'cancelled' | 'error'

type Props = {
  onClose:        () => void
  /** 開いた直後にインプット欄へ入力する文字列（ユーザーが送信ボタンを押すまで送信しない） */
  initialMessage?: string
}

// ─────────────────────────────────────────────────────────
// スタイル定数
// ─────────────────────────────────────────────────────────

const C = {
  bg:           '#FAF9F7',
  panelBorder:  '#E8E5DF',
  userBubble:   '#1E3A5F',
  userText:     '#FFFFFF',
  aiBg:         'transparent',
  aiText:       '#1A1A18',
  inputBg:      '#FFFFFF',
  inputBorder:  '#D5DED8',
  sendBtn:      '#2B5E40',
  sendDisabled: '#C8D3E8',
  divider:      '#EAE7E1',
  muted:        '#9B968E',
  headerBg:     '#FFFFFF',
  headerBorder: '#EAE7E1',
  cardBg:       '#FFFBEB',
  cardBorder:   '#F59E0B',
  cardTitle:    '#92400E',
  confirmBtn:   '#166534',
  confirmBg:    '#DCFCE7',
  cancelBg:     '#F3F4F6',
  cancelBtn:    '#6B7280',
  confirmedBg:  '#EAF3DE',
  confirmedText:'#166534',
  errorBg:      '#FEF2F2',
  errorText:    '#B91C1C',
  qrBorder:     '#D9D6CF',
  qrBg:         '#FFFFFF',
  qrText:       '#1A1A18',
  qrPrimaryBg:  '#1E3A5F',
  qrPrimaryText:'#FFFFFF',
}

const FONT = "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif"

// 変更カード表示用フィールドラベル
const CHANGE_LABELS: Record<string, string> = {
  project_name:  '案件名',
  customer_name: '顧客名',
  status:        'ステータス',
  note:          '備考',
}

function fmtChangeValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  return String(v)
}

// ─────────────────────────────────────────────────────────
// 変更確認カード
// ─────────────────────────────────────────────────────────

function ChangeCard({
  change,
  onConfirm,
  onCancel,
}: {
  change: ConfirmableChange
  onConfirm: (changeId: string) => Promise<void>
  onCancel: (changeId: string) => void
}) {
  const [status, setStatus] = useState<ChangeStatus>('idle')
  const [errMsg, setErrMsg] = useState('')

  const proposed = change.proposed ?? {}
  const rows = Object.entries(proposed)
    .filter(([k]) => k !== 'project_id')
    .map(([k, v]) => ({ label: CHANGE_LABELS[k] ?? k, value: fmtChangeValue(k, v) }))

  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.cardBorder}`, borderRadius: 10, padding: '12px 14px', margin: '6px 0', fontFamily: FONT }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.cardTitle, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {change.change_type === 'create' ? '✦ 請求書下書き作成の提案' : '変更提案'}
      </div>

      <div style={{ fontSize: 13, color: '#374151', marginBottom: 10 }}>{change.diff_summary}</div>

      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
          <tbody>
            {rows.map(row => (
              <tr key={row.label} style={{ borderBottom: `1px solid #F3F4F6` }}>
                <td style={{ padding: '4px 0', fontSize: 11, color: '#6B7280', width: '36%' }}>{row.label}</td>
                <td style={{ padding: '4px 0', fontSize: 13, color: '#111827', fontWeight: 500 }}>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status === 'confirming' && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>送信中…</div>
      )}
      {status === 'confirmed' && (
        <div style={{ fontSize: 12, fontWeight: 600, color: C.confirmedText, background: C.confirmedBg, borderRadius: 6, padding: '5px 10px' }}>
          ✓ 請求書の下書きを作成しました
        </div>
      )}
      {status === 'cancelled' && (
        <div style={{ fontSize: 12, color: C.muted }}>キャンセルしました</div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 12, color: C.errorText, background: C.errorBg, borderRadius: 6, padding: '5px 10px' }}>{errMsg}</div>
      )}

      {status === 'idle' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={async () => {
              setStatus('confirming')
              try { await onConfirm(change.id) ; setStatus('confirmed') }
              catch (e) { setStatus('error') ; setErrMsg(e instanceof Error ? e.message : String(e)) }
            }}
            style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: C.confirmBg, color: C.confirmBtn, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            作成する
          </button>
          <button
            onClick={() => { onCancel(change.id) ; setStatus('cancelled') }}
            style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: C.cancelBg, color: C.cancelBtn, fontSize: 13, cursor: 'pointer' }}
          >
            キャンセル
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// メッセージバブル
// ─────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  onConfirmChange,
  onCancelChange,
  onQuickReply,
}: {
  msg: Message
  onConfirmChange: (changeId: string) => Promise<void>
  onCancelChange: (changeId: string) => void
  onQuickReply: (text: string) => void
}) {
  const isUser = msg.role === 'user'

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
      <div style={{ maxWidth: '88%' }}>
        {isUser ? (
          <div style={{ background: C.userBubble, color: C.userText, padding: '8px 14px', borderRadius: '16px 16px 4px 16px', fontSize: 13, lineHeight: 1.5, fontFamily: FONT, wordBreak: 'break-word' }}>
            {msg.content}
          </div>
        ) : (
          <div style={{ color: C.aiText, fontSize: 13, lineHeight: 1.7, fontFamily: FONT, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
            {msg.content}
            {msg.streaming && <span style={{ display: 'inline-block', width: 6, height: 13, background: '#1E3A5F', marginLeft: 2, verticalAlign: 'middle', animation: 'blink 1s step-end infinite' }} />}
          </div>
        )}

        {/* 変更確認カード */}
        {(msg.pendingChanges ?? []).map(ch => (
          <ChangeCard key={ch.id} change={ch} onConfirm={onConfirmChange} onCancel={onCancelChange} />
        ))}

        {/* クイックリプライ */}
        {!isUser && (msg.quickReplies ?? []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {(msg.quickReplies ?? []).map(qr => (
              <button
                key={qr.label}
                onClick={() => onQuickReply(qr.message)}
                style={{
                  padding: '6px 12px', borderRadius: 20, border: `1px solid ${qr.variant === 'primary' ? C.qrPrimaryBg : C.qrBorder}`,
                  background: qr.variant === 'primary' ? C.qrPrimaryBg : C.qrBg,
                  color: qr.variant === 'primary' ? C.qrPrimaryText : C.qrText,
                  fontSize: 12, cursor: 'pointer', fontFamily: FONT,
                }}
              >
                {qr.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// メインコンポーネント
// ─────────────────────────────────────────────────────────

const INITIAL_MESSAGES: Message[] = [
  {
    role:    'assistant',
    content: '会社全体の状況についてお答えします。\n例：「未入金の案件を教えて」「今月請求書を出すべき案件は？」',
  },
]

export function CompanyChat({ onClose, initialMessage }: Props) {
  const [messages,   setMessages]   = useState<Message[]>(INITIAL_MESSAGES)
  const [input,      setInput]      = useState(initialMessage ?? '')
  const [isStreaming, setIsStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef  = useRef<AbortController | null>(null)

  // 最下部スクロール
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // ESC でモーダルを閉じる
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // ── SSE 送受信 ────────────────────────────────────────

  const sendMessage = useCallback(async (userText: string) => {
    if (!userText.trim() || isStreaming) return

    const userMsg: Message = { role: 'user', content: userText }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)

    // SSE 用メッセージ履歴（AIへ渡す形式）
    const history = [...messages, userMsg].map(m => ({
      role:    m.role,
      content: m.content,
    }))

    const aiMsgIndex = messages.length + 1
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const res = await fetch('/api/ai/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // project_id を含めない → 会社全体モード
        body:    JSON.stringify({ messages: history }),
        signal:  abort.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let aiText    = ''
      let pendingChanges: ConfirmableChange[] = []
      let quickReplies:   QuickReply[]        = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice(6).trim()
          if (!json) continue

          let evt: Record<string, unknown>
          try { evt = JSON.parse(json) } catch { continue }

          if (evt.type === 'text') {
            aiText += (evt.delta as string) ?? ''
            setMessages(prev => {
              const next = [...prev]
              next[aiMsgIndex] = { role: 'assistant', content: aiText, streaming: true }
              return next
            })
          } else if (evt.type === 'done') {
            pendingChanges = (evt.pending_changes as ConfirmableChange[]) ?? []
            quickReplies   = (evt.suggestions as QuickReply[]) ?? []
          }
        }
      }

      setMessages(prev => {
        const next = [...prev]
        next[aiMsgIndex] = {
          role:    'assistant',
          content: aiText,
          streaming: false,
          pendingChanges,
          quickReplies,
        }
        return next
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setMessages(prev => {
        const next = [...prev]
        next[aiMsgIndex] = { role: 'assistant', content: 'エラーが発生しました。もう一度お試しください。' }
        return next
      })
    } finally {
      setIsStreaming(false)
    }
  }, [messages, isStreaming])

  // ── 変更確定 ──────────────────────────────────────────

  const handleConfirmChange = useCallback(async (changeId: string) => {
    // 全メッセージから該当 change を探す
    let targetChange: ConfirmableChange | undefined
    for (const msg of messages) {
      targetChange = (msg.pendingChanges ?? []).find(c => c.id === changeId)
      if (targetChange) break
    }
    if (!targetChange) throw new Error('変更が見つかりません')

    const res = await fetch('/api/ai/chat/confirm-change', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ change: targetChange }),
    })
    if (!res.ok) {
      const json = await res.json() as { error?: string }
      throw new Error(json.error ?? `HTTP ${res.status}`)
    }
  }, [messages])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleCancelChange = useCallback((_changeId: string) => {
    // キャンセルは UI ステートのみ（DB 操作なし）
  }, [])

  // ── UI ────────────────────────────────────────────────

  return (
    <>
      {/* 背景オーバーレイ */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000 }}
      />

      {/* モーダル本体 */}
      <div style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(90vw, 520px)',
        height: 'min(80vh, 640px)',
        background: C.bg,
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 48px rgba(0,0,0,0.20)',
        zIndex: 1001,
        fontFamily: FONT,
      }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: C.headerBg, borderBottom: `1px solid ${C.headerBorder}` }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1A1A18' }}>AIに相談</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>会社全体の状況を確認できます</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.muted, padding: 4 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* メッセージエリア */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
          {messages.map((msg, i) => (
            <MessageBubble
              key={i}
              msg={msg}
              onConfirmChange={handleConfirmChange}
              onCancelChange={handleCancelChange}
              onQuickReply={text => sendMessage(text)}
            />
          ))}
        </div>

        {/* 入力エリア */}
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.divider}`, background: C.inputBg }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault() ; sendMessage(input) }
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = '#2B5E40'
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(43,94,64,0.12)'
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = C.inputBorder
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder="例: 未入金の案件は？  請求書を作って"
              rows={2}
              disabled={isStreaming}
              style={{ flex: 1, resize: 'none', border: `1px solid ${C.inputBorder}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: FONT, outline: 'none', background: isStreaming ? '#F9F9F9' : C.inputBg }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isStreaming}
              aria-label="送信"
              style={{ width: 44, height: 44, borderRadius: 8, border: 'none', background: !input.trim() || isStreaming ? C.sendDisabled : C.sendBtn, cursor: !input.trim() || isStreaming ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 5, textAlign: 'center' }}>
            AIによる整理結果です。最終判断は担当者が行ってください。
          </div>
        </div>
      </div>

      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </>
  )
}
