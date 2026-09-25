import { createClient } from '@supabase/supabase-js'

// service_role クライアント — RLSをバイパスする
// このファイルをimportできるのは以下4箇所のみ（CLAUDE.md セキュリティ原則）:
//   app/api/webhook/line/route.ts
//   app/api/share/[token]/route.ts
//   app/api/pdf/route.ts（必要時のみ）
//   app/api/cron/daily-briefing/route.ts（Phase 3 承認済み）

// Lazy initialization — module import 時ではなく呼び出し時に生成する。
// next build の静的評価フェーズで SUPABASE_SERVICE_ROLE_KEY が未設定の環境でも
// module evaluation がクラッシュしないようにするため。
export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('[admin] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set')
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
