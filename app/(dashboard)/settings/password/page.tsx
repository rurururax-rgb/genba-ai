import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase/server'
import { PasswordChangeForm } from '@/components/account/PasswordChangeForm'

export const metadata = { title: 'パスワード変更 — RUGZ' }

export default async function PasswordSettingsPage() {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <main style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto' }}>
      <Link href="/projects" style={{ fontSize: 13, color: '#4E7A5B', textDecoration: 'none' }}>
        ← 案件一覧に戻る
      </Link>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1E3A5F', margin: '16px 0 0', letterSpacing: '-0.02em' }}>
        パスワード変更
      </h1>
      <p style={{ margin: '6px 0 24px', fontSize: 13, color: '#8A96A8', lineHeight: 1.6 }}>
        ログイン中のアカウント（{user.email ?? 'メールアドレスなし'}）のパスワードを変更します。
        変更すると、ほかの端末ではログアウトされます。
      </p>
      <PasswordChangeForm email={user.email ?? ''} />
    </main>
  )
}
