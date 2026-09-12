'use client'

/**
 * DashboardSummarySection.tsx
 *
 * 案件一覧ページの「今日やること」セクション。
 *
 * 設計方針:
 * - 数字・状態はサーバー側（lib/services/daily-briefing.ts）で決定論的に判定済み
 * - AIに数字を生成・推測させない。取得した値をそのまま表示する
 * - 各項目から「次にすべきアクション」へ直接進める導線を提供する
 * - チャットは補助機能。AIが主役のUIにしない
 */

import { useState } from 'react'
import Link from 'next/link'
import type { TodayActionItem } from '@/lib/services/daily-briefing'
import type { CompanySummary } from '@/lib/services/company-summary'
import { CompanyChat } from './CompanyChat'

type Props = {
  summary:     CompanySummary
  actionItems: TodayActionItem[]
}

// ── 優先度ごとの配色 ────────────────────────────────────────────────

const PRIORITY_STYLE: Record<number, {
  dot:    string
  badge:  string
  badgeBg: string
  label:  string
}> = {
  1: { dot: '#EF4444', badge: '#B91C1C', badgeBg: '#FEE2E2', label: '最優先' },
  2: { dot: '#F97316', badge: '#92400E', badgeBg: '#FEF3C7', label: '高'     },
  3: { dot: '#3B82F6', badge: '#1E40AF', badgeBg: '#DBEAFE', label: '中'     },
  4: { dot: '#10B981', badge: '#065F46', badgeBg: '#D1FAE5', label: '低'     },
  5: { dot: '#9CA3AF', badge: '#374151', badgeBg: '#F3F4F6', label: '参考'   },
}

// ── CompanyChat を開くときの初期メッセージ生成 ──────────────────────

function makeChatMessage(item: TodayActionItem): string {
  switch (item.type) {
    case 'invoice_overdue':
      return `${item.projectName}の入金確認の連絡文を作成して`
    case 'invoice_issued_unpaid':
      return `${item.projectName}の入金状況を確認したい`
    case 'billing_missing':
    case 'invoice_draft':
      return `${item.projectName}の請求書作成を手伝って`
    default:
      return `${item.projectName}について確認したい`
  }
}

/** AIチャットボタンを表示する種別 */
const TYPES_WITH_CHAT = new Set<TodayActionItem['type']>([
  'invoice_overdue',
  'invoice_issued_unpaid',
  'billing_missing',
  'invoice_draft',
])

// ── アクションカード ────────────────────────────────────────────────

type CardProps = {
  item:       TodayActionItem
  onOpenChat: (initialMessage: string) => void
}

function ActionCard({ item, onOpenChat }: CardProps) {
  const ps = PRIORITY_STYLE[item.priority] ?? PRIORITY_STYLE[5]
  const showChat = TYPES_WITH_CHAT.has(item.type)

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      gap:           8,
      padding:       '12px 16px',
      background:    '#FFFFFF',
      borderRadius:  10,
      border:        '1px solid #E5E7EB',
      borderLeft:    `3px solid ${ps.dot}`,
      fontFamily:    'system-ui, -apple-system, sans-serif',
    }}>

      {/* 上段：案件名 + タイトル + 優先度バッジ */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{
            fontSize:    13,
            fontWeight:  700,
            color:       '#192C1F',
            overflow:    'hidden',
            textOverflow: 'ellipsis',
            whiteSpace:  'nowrap',
          }}>
            {item.projectName}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            {item.title}
          </span>
        </div>
        <span style={{
          fontSize:     10,
          fontWeight:   700,
          color:        ps.badge,
          background:   ps.badgeBg,
          borderRadius: 4,
          padding:      '2px 6px',
          whiteSpace:   'nowrap',
          flexShrink:   0,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {ps.label}
        </span>
      </div>

      {/* 中段：理由 */}
      <p style={{ fontSize: 12, color: '#6B7280', margin: 0, lineHeight: 1.5 }}>
        {item.reason}
      </p>

      {/* 下段：アクションボタン */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>

        {/* プライマリ：AI相談（特定種別のみ） */}
        {showChat && (
          <button
            onClick={() => onOpenChat(makeChatMessage(item))}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          5,
              padding:      '6px 12px',
              borderRadius: 8,
              background:   '#1E3A5F',
              color:        '#FFFFFF',
              border:       'none',
              cursor:       'pointer',
              fontSize:     12,
              fontWeight:   600,
              fontFamily:   'system-ui, -apple-system, sans-serif',
              minHeight:    32,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {item.recommendedAction}
          </button>
        )}

        {/* セカンダリ：案件を見る */}
        <Link
          href={item.actionUrl}
          style={{
            display:      'flex',
            alignItems:   'center',
            gap:          4,
            padding:      '6px 12px',
            borderRadius: 8,
            background:   '#F3F4F6',
            color:        '#374151',
            textDecoration: 'none',
            fontSize:     12,
            fontWeight:   600,
            minHeight:    32,
          }}
        >
          {showChat ? '案件を見る' : item.recommendedAction}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </Link>
      </div>
    </div>
  )
}

// ── 優先度グループのヘッダー ────────────────────────────────────────

function PriorityGroup({
  priority,
  label,
  items,
  onOpenChat,
}: {
  priority:   number
  label:      string
  items:      TodayActionItem[]
  onOpenChat: (msg: string) => void
}) {
  if (items.length === 0) return null
  const ps = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE[5]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: ps.dot, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>{items.length}件</span>
      </div>
      {items.map((item, i) => (
        <ActionCard key={`${item.type}-${item.projectId}-${i}`} item={item} onOpenChat={onOpenChat} />
      ))}
    </div>
  )
}

// ── メインコンポーネント ─────────────────────────────────────────────

export function DashboardSummarySection({ summary, actionItems }: Props) {
  const [chatMessage, setChatMessage] = useState<string | null>(null)

  const handleOpenChat = (msg: string) => setChatMessage(msg)
  const handleCloseChat = () => setChatMessage(null)

  const highItems   = actionItems.filter(i => i.priority <= 1)
  const medHiItems  = actionItems.filter(i => i.priority === 2)
  const medItems    = actionItems.filter(i => i.priority === 3)
  const lowItems    = actionItems.filter(i => i.priority === 4)
  const refItems    = actionItems.filter(i => i.priority === 5)

  const hasActions = actionItems.length > 0

  return (
    <>
      <div style={{ padding: '0 32px 24px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

        {/* セクションヘッダー */}
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          marginBottom:   14,
        }}>
          <div>
            <p style={{
              fontSize:      10,
              fontWeight:    700,
              color:         '#6CB382',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              margin:        '0 0 2px',
            }}>
              TODAY
            </p>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#192C1F', margin: 0 }}>
              今日やること
              {hasActions && (
                <span style={{ fontSize: 14, fontWeight: 400, color: '#6B7280', marginLeft: 8 }}>
                  {actionItems.length}件
                </span>
              )}
            </h2>
          </div>

          {/* AI相談ボタン（会社全体に聞く） */}
          <button
            onClick={() => handleOpenChat('')}
            style={{
              display:    'flex',
              alignItems: 'center',
              gap:        6,
              padding:    '8px 14px',
              borderRadius: 10,
              background: '#1E3A5F',
              color:      '#FFFFFF',
              border:     'none',
              cursor:     'pointer',
              fontSize:   13,
              fontWeight: 600,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            AIに相談する →
          </button>
        </div>

        {/* 要対応なし */}
        {!hasActions ? (
          <div style={{
            padding:     '14px 16px',
            borderRadius: 10,
            background:  '#EAF3DE',
            border:      '1px solid #BDD1C3',
            fontSize:    13,
            color:       '#166534',
            display:     'flex',
            alignItems:  'center',
            gap:         8,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            現在、要対応の項目はありません。進行中 {summary.active_projects}件
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <PriorityGroup priority={1} label="最優先"  items={highItems}  onOpenChat={handleOpenChat} />
            <PriorityGroup priority={2} label="高"      items={medHiItems} onOpenChat={handleOpenChat} />
            <PriorityGroup priority={3} label="中"      items={medItems}   onOpenChat={handleOpenChat} />
            <PriorityGroup priority={4} label="低"      items={lowItems}   onOpenChat={handleOpenChat} />
            <PriorityGroup priority={5} label="参考"    items={refItems}   onOpenChat={handleOpenChat} />
          </div>
        )}

        {/* 進行中件数フッター */}
        {hasActions && (
          <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 12, margin: '12px 0 0' }}>
            進行中 {summary.active_projects}件
          </p>
        )}
      </div>

      {/* CompanyChat モーダル（initialMessage で対象プロジェクトを文脈付け） */}
      {chatMessage !== null && (
        <CompanyChat
          onClose={handleCloseChat}
          initialMessage={chatMessage || undefined}
        />
      )}
    </>
  )
}
