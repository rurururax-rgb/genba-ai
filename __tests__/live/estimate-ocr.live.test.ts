import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import Anthropic from '@anthropic-ai/sdk'
import { needsReview, reviewEstimateItem, type EstimateOcrFile, type EstimateOcrItem } from '@/lib/estimate/ocr-extraction'

/**
 * 見積書 OCR（POST /api/ai/extract-estimate）を本物の Claude API で検証する。vitest.live.config.ts から実行する。
 * 画像はすべて架空の見積書（scripts/ocr-live/make-estimates.mjs で作成）。DB には接続しない（認証だけ模擬）。
 *
 * 各ケースの読み取り結果を正解データと比べ、行数・品名・数量・単価・金額・要確認の表示を採点する。
 * 必ず守るべき条件（失敗にする）:
 *   - 原本と違う単価が「要確認」なしで正常扱いされない（silent wrong = 0）
 *   - 「含む」・0 円・値引きの行を明細に入れない
 *   - 値引きは adjustments として読み、画像全体の警告に出す
 *   - 明細の読み落としは、画像全体の警告に出るか、途中終了のエラーになる
 */

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'live-test' } } }) } }),
}))

// 出力トークン数と終了理由を記録する（出力上限 8192 までの余裕を見るため。AI の応答そのものは変えない）
const usageLog: Array<{ output_tokens: number; input_tokens: number; stop_reason: string | null }> = []
const origCreate = Anthropic.Messages.prototype.create
Anthropic.Messages.prototype.create = function (this: unknown, ...args: unknown[]) {
  const p = (origCreate as (...a: unknown[]) => Promise<Anthropic.Message>).apply(this, args)
  p.then(m => usageLog.push({ output_tokens: m.usage.output_tokens, input_tokens: m.usage.input_tokens, stop_reason: m.stop_reason }), () => {})
  return p
} as typeof origCreate

const FIX = path.resolve('__tests__/live/fixtures')
// 結果（AI の応答）はリポジトリの外に書く
const OUT = process.env.OCR_OUT ?? path.join(tmpdir(), 'genba-ocr-live')
const ONLY = (process.env.OCR_CASES ?? '').split(',').filter(Boolean)
const hasKey = !!process.env.ANTHROPIC_API_KEY

type ExpectedRow = {
  name: string; unit: string; quantity: number; list_price: number | null; rate: number | null
  unit_price: number | null; amount: number | null; cost_price: number | null; review: boolean
}
type Expected = { id: string; supplier: string; subtotal: number; adjustments: Array<{ label: string; amount: number }>; excludedNames: string[]; separateNames: string[]; rows: ExpectedRow[] }

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const eq = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-6

type RowScore = {
  name: string; found: boolean; name_exact: boolean; quantity: boolean; cost: boolean; amount: boolean
  list_rate: boolean; review_expected: boolean; review_actual: boolean; silent_wrong: boolean
  actual?: Partial<EstimateOcrItem>; messages?: string[]
}

function score(expected: Expected, file: EstimateOcrFile) {
  const pool = [...file.items]
  const rows: RowScore[] = expected.rows.map(e => {
    const i = pool.findIndex(a => norm(a.name) === norm(e.name))
    const j = i >= 0 ? i : pool.findIndex(a => norm(a.name).includes(norm(e.name).slice(0, 4)))
    const a = j >= 0 ? pool.splice(j, 1)[0] : undefined
    if (!a) return { name: e.name, found: false, name_exact: false, quantity: false, cost: false, amount: false, list_rate: false, review_expected: e.review, review_actual: false, silent_wrong: false }
    // 画面と同じ照合（数量は原本で読めた値）
    const msgs = reviewEstimateItem(a)
    const review = needsReview(msgs)
    const cost = eq(a.cost_price, e.cost_price)
    return {
      name: e.name, found: true, name_exact: norm(a.name) === norm(e.name),
      quantity: eq(a.quantity, e.quantity), cost, amount: eq(a.amount, e.amount),
      list_rate: eq(a.list_price, e.list_price) && eq(a.rate, e.rate),
      review_expected: e.review, review_actual: review,
      // 単価が正解と違う（または数量が違う）のに要確認になっていない
      silent_wrong: (!cost || !eq(a.quantity, e.quantity)) && !review,
      actual: a, messages: msgs.map(m => `${m.level}: ${m.text}`),
    }
  })
  const extra = pool.map(a => a.name)
  const pct = (k: keyof RowScore) => Math.round((rows.filter(r => r[k] === true).length / rows.length) * 1000) / 10
  return {
    rows, extra,
    summary: {
      expected_rows: expected.rows.length, read_rows: file.items.length, found: rows.filter(r => r.found).length,
      name_exact_pct: pct('name_exact'), quantity_pct: pct('quantity'), cost_pct: pct('cost'), amount_pct: pct('amount'), list_rate_pct: pct('list_rate'),
      review_match_pct: Math.round((rows.filter(r => r.found && r.review_expected === r.review_actual).length / rows.length) * 1000) / 10,
      silent_wrong: rows.filter(r => r.silent_wrong).map(r => r.name),
      extra_rows: extra,
      file_warnings: file.messages.map(m => m.text),
      adjustments: file.adjustments, subtotal: file.subtotal, items_total: file.items_total, supplier: file.supplier,
    },
  }
}

const cases = ['case1-rate', 'case2-discount', 'case3-long65', 'case4-traps', 'case5-photo', 'case6-unit-only']
  .filter(id => !ONLY.length || ONLY.includes(id))
  .filter(id => existsSync(path.join(FIX, `${id}.png`)))

describe.skipIf(!hasKey)('見積書 OCR（本物の Claude API・架空の見積書）', async () => {
  const { POST } = await import('@/app/api/ai/extract-estimate/route')
  mkdirSync(OUT, { recursive: true })

  for (const id of cases) {
    it(id, async () => {
      const expected = JSON.parse(readFileSync(path.join(FIX, `${id}.expected.json`), 'utf8')) as Expected
      const fd = new FormData()
      fd.append('files', new File([readFileSync(path.join(FIX, `${id}.png`))], `${id}.png`, { type: 'image/png' }))
      const started = Date.now()
      const res = await POST(new NextRequest('http://localhost/api/ai/extract-estimate', { method: 'POST', body: fd }))
      const body = await res.json() as { files?: EstimateOcrFile[]; code?: string; error?: string }
      const elapsed_ms = Date.now() - started
      const usage = usageLog.at(-1)

      if (res.status !== 200) {
        // 途中終了などは、明細を返さず案内を出していれば「安全な失敗」（正常扱いしていない）
        writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ status: res.status, elapsed_ms, usage, body }, null, 2))
        console.log(`[${id}] status=${res.status} code=${body.code} ${elapsed_ms}ms`)
        expect(body.files).toBeUndefined()
        expect(['ai_truncated', 'ai_timeout', 'ai_incomplete', 'ai_invalid_response']).toContain(body.code)
        return
      }

      const file = body.files![0]
      const result = score(expected, file)
      writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ status: 200, elapsed_ms, usage, ...result, raw: file }, null, 2))
      console.log(`[${id}] ${elapsed_ms}ms`, JSON.stringify(result.summary, null, 1))

      // 安全条件: 違う単価・数量を無警告で正常扱いしない
      expect.soft(result.summary.silent_wrong, '無警告の誤り').toEqual([])
      // 「含む」・0 円の行・値引きの行を明細に入れない
      for (const name of expected.excludedNames) expect.soft(file.items.map(i => norm(i.name)), `除外行 ${name}`).not.toContain(norm(name))
      expect.soft(file.items.some(i => /値引/.test(i.name)), '値引きの行が明細に入った').toBe(false)
      // 「別途」の行は原価に入っていないと警告する
      for (const name of expected.separateNames ?? []) {
        expect.soft(file.messages.some(m => m.level === 'warn' && m.text.includes(name) && m.text.includes('別途')), `別途 ${name} の警告`).toBe(true)
      }
      // 金額・定価の列がない見積書は、照合できないと警告する
      if (expected.rows.every(r => r.amount == null && r.list_price == null)) {
        expect.soft(file.messages.some(m => m.text.includes('照合で見つけられません')), '照合不能の警告').toBe(true)
      }
      // 値引きは原価に入れず、画像全体の警告に出す
      for (const adj of expected.adjustments) {
        expect.soft(file.adjustments.map(a => a.amount), '値引きの金額').toContain(adj.amount)
        expect.soft(file.messages.some(m => m.text.includes('反映していません')), '値引きの警告').toBe(true)
      }
      // 読み落としがあれば画像全体の警告に出る
      if (file.items.length < expected.rows.length) {
        expect.soft(file.messages.some(m => m.level === 'warn'), '読み落としの警告').toBe(true)
      }
    })
  }
})
