import { configDefaults, defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // 隔離 PostgreSQL を起動する DB 検証は npm run test:db で別に実行する
    exclude: [...configDefaults.exclude, '__tests__/db/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
