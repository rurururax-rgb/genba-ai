import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import path from 'path'

/**
 * 見積書 OCR を本物の Claude API で検証する（架空の見積書のみ。費用がかかるので通常の npm test では実行しない）。
 *
 *   OCR_ENV_FILE=../genba-ai/.env.local OCR_OUT=/tmp/ocr-live npx vitest run --config vitest.live.config.ts
 *   OCR_CASES=case4-traps …   で一部のケースだけ実行できる
 *
 * OCR_ENV_FILE からは ANTHROPIC_API_KEY / ANTHROPIC_MODEL だけを読む（Supabase などほかの値は読み込まない）。
 */
function anthropicEnv(): Record<string, string> {
  const file = process.env.OCR_ENV_FILE
  if (!file) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(ANTHROPIC_API_KEY|ANTHROPIC_MODEL)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return env
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/live/**/*.live.test.ts'],
    testTimeout: 300_000,
    env: anthropicEnv(),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
