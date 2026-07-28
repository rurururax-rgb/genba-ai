import { createClient } from '@supabase/supabase-js'

// service_role クライアント — RLSをバイパスする
// このファイルをimportできるのは以下3箇所のみ（CLAUDE.md セキュリティ原則）:
//   app/api/auth/create-company/route.ts
//   app/api/webhook/line/route.ts
//   app/api/share/[token]/route.ts
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

export { supabaseAdmin }
