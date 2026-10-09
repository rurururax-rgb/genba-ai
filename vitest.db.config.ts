import { defineConfig } from 'vitest/config'
import path from 'path'

// DB 検証（隔離されたローカル PostgreSQL に実際の migration を適用して確かめる）
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/db/**/*.db.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
