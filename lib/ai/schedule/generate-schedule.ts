import Anthropic from '@anthropic-ai/sdk'
import {
  buildScheduleDates as buildScheduleDatesFromSlots,
  type SchedulePeriod,
  type ScheduleCalendarOptions,
  DEFAULT_CALENDAR,
} from '@/lib/services/schedule-slots'

export type { SchedulePeriod }
export type { ScheduleCalendarOptions }

export type AIScheduleDraftItem = {
  _draft_id: string           // クライアント側の一時ID（Reactキー用）
  name: string
  category: string | null
  vendor_name: string | null
  duration_slots: number      // 半日単位
  memo: string | null
  estimate_group_id: string | null
  // buildScheduleDates() により補完
  start_date: string | null
  end_date: string | null
  start_period: SchedulePeriod
  end_period: SchedulePeriod
}

export type AIScheduleInput = {
  projectName: string
  estimateGroups: Array<{
    id: string
    label: string
    items: Array<{ name: string; quantity: number; unit: string }>
  }>
  startDate: string
  conditions?: string
  calendarOptions?: ScheduleCalendarOptions
}

type RawAIItem = {
  name: string
  category?: string | null
  vendor_name?: string | null
  duration_slots: number
  memo?: string | null
}

// duration_slots から start/end 日付を確定させる。schedule-slots.ts に委譲。
export function buildScheduleDates(
  items: Omit<AIScheduleDraftItem, 'start_date' | 'end_date' | 'start_period' | 'end_period' | '_draft_id'>[],
  startDate: string,
  options: ScheduleCalendarOptions = DEFAULT_CALENDAR,
): Omit<AIScheduleDraftItem, '_draft_id'>[] {
  return buildScheduleDatesFromSlots(items, startDate, options)
}

// ── AI 呼び出し ───────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function generateScheduleDraft(
  input: AIScheduleInput,
): Promise<Omit<AIScheduleDraftItem, '_draft_id'>[]> {
  const prompt = buildPrompt(input)

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AIからの応答を解析できませんでした')

  let parsed: { items: RawAIItem[] }
  try {
    parsed = JSON.parse(jsonMatch[0]) as { items: RawAIItem[] }
  } catch {
    throw new Error('AIからの応答がJSON形式ではありません')
  }
  if (!Array.isArray(parsed?.items) || parsed.items.length === 0) {
    throw new Error('AIからの工程案が空です')
  }

  const calendarOptions: ScheduleCalendarOptions = input.calendarOptions ?? DEFAULT_CALENDAR

  const raw = buildScheduleDates(
    parsed.items.map(i => ({
      name:               String(i.name ?? '').trim() || '（工程名なし）',
      category:           i.category     ?? null,
      vendor_name:        i.vendor_name  ?? null,
      duration_slots:     typeof i.duration_slots === 'number' && i.duration_slots > 0 ? Math.round(i.duration_slots) : 2,
      memo:               i.memo         ?? null,
      estimate_group_id:  null,
    })),
    input.startDate,
    calendarOptions,
  )

  return raw
}

// ── プロンプト ─────────────────────────────────────────────────

function buildPrompt(input: AIScheduleInput): string {
  const estimateSection =
    input.estimateGroups.length > 0
      ? input.estimateGroups
          .map(g =>
            `【${g.label}】\n` +
            g.items.map(i => `  - ${i.name} ${i.quantity}${i.unit}`).join('\n'),
          )
          .join('\n\n')
      : '（見積データなし。一般的な工事工程で作成してください）'

  return `あなたは工務店の工程表作成アシスタントです。
以下の見積内容をもとに、工事の工程案を作成してください。

案件名: ${input.projectName}
着工予定日: ${input.startDate}
${input.conditions ? `施工条件・備考: ${input.conditions}` : ''}

【見積内容】
${estimateSection}

以下のJSON形式で工程案を返してください。他のテキストは一切不要です。
duration_slotsは半日単位（1=半日、2=1日、4=2日、6=3日など）で指定してください。

{
  "items": [
    {
      "name": "工程名",
      "category": "大工またはnull（大工/電気/設備/クロス/塗装/左官/外構/解体/基礎/その他）",
      "vendor_name": "業者名またはnull",
      "duration_slots": 2,
      "memo": "備考またはnull"
    }
  ]
}

注意事項:
- 工程は施工順序（下地→仕上げ）で並べること
- 金額・単価・原価は含めないこと
- duration_slotsは見積の量・規模に応じて現実的な日数を設定すること
- これはあくまで叩き台です。最終判断は担当者が行ってください。`
}
