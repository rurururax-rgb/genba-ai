/**
 * lib/services/briefing-summarizer.ts
 *
 * 日次ブリーフィングの AI 要約レイヤー。
 *
 * ── 設計方針 ──────────────────────────────────────────────────────────
 * - AI の役割は「文章整形だけ」。業務判断・件数・金額・優先度の再計算は禁止。
 * - AI 失敗時は必ず fallback する。AI 障害で通知が止まる設計は禁止。
 * - timeout は 5 秒。応答が遅ければ待たずに fallback。
 * - モデルは claude-haiku-4-5-20251001（低コスト）。
 * - API key・顧客詳細情報はログに出さない。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TodayActionItem } from './daily-briefing'

const MODEL         = 'claude-haiku-4-5-20251001'
const AI_TIMEOUT_MS = 5_000
const MAX_TOKENS    = 500

/** AI 要約への入力（最小限の情報だけ渡す）*/
type SummaryInput = {
  projectName:       string
  title:             string
  reason:            string
  recommendedAction: string
}

export type SummarizeResult =
  | { ok: true;  text: string; source: 'ai' }
  | { ok: false; reason: string }

/**
 * TodayActionItem[] → LINE 通知文を AI で生成する。
 *
 * - header（【現場AI｜今日の要対応】など）はこの関数内で付与する。
 * - 失敗時は ok:false を返す。fallback は呼び出し元が行う。
 */
export async function summarizeBriefingWithAI(
  items: TodayActionItem[],
  jstDateStr: string,
): Promise<SummarizeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY not set' }
  }

  const [, mm, dd] = jstDateStr.split('-')
  const dateLabel = `${mm}/${dd}`
  const count = items.length

  // AI に渡す項目（内部 ID・DB レコード全体は渡さない）
  const inputs: SummaryInput[] = items.map(item => ({
    projectName:       item.projectName,
    title:             item.title,
    reason:            item.reason,
    recommendedAction: item.recommendedAction,
  }))

  const itemsText = inputs
    .map((item, i) =>
      `${i + 1}. 案件: ${item.projectName}\n   状況: ${item.title}\n   理由: ${item.reason}\n   次のアクション: ${item.recommendedAction}`
    )
    .join('\n\n')

  const systemPrompt =
    'あなたは工務店の管理者向け業務通知文を作成するアシスタントです。' +
    '与えられた情報だけを使って文章を整形してください。' +
    '新しい業務判断の追加、金額・件数・期限の変更は禁止です。'

  const userPrompt =
    `以下の案件について、LINEで送る短い通知文の本文を作成してください。\n\n` +
    `件数: ${count}件\n\n` +
    `${itemsText}\n\n` +
    `---\n` +
    `【出力ルール】\n` +
    `- ①②③などの丸数字で各案件を区切る\n` +
    `- 各案件は3行以内（案件名・状況・アクション）\n` +
    `- 本文全体は150文字以内\n` +
    `- 最後の行は「詳細は現場AIで確認できます。」\n` +
    `- ヘッダー行（【現場AI…】）は出力しない（別途追加される）\n` +
    `- 説明文・前置き不要。通知文のみ出力`

  const client = new Anthropic({ apiKey })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

  try {
    const response = await client.messages.create(
      {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal },
    )

    clearTimeout(timeoutId)

    const body = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    if (!body) {
      return { ok: false, reason: 'empty AI response' }
    }

    // ヘッダーを付与して完成
    const text = `【現場AI｜今日の要対応】\n${dateLabel}\n\n${body}`
    return { ok: true, text, source: 'ai' }

  } catch (err) {
    clearTimeout(timeoutId)
    const reason = err instanceof Error ? err.message : String(err)
    // API key の値・顧客情報はログに出さない
    const safeReason = reason.includes('abort') ? 'timeout' : 'api_error'
    return { ok: false, reason: safeReason }
  }
}
