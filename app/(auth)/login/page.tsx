'use client'

// ⚠️ デモ用簡易版ログイン画面
// 本来の Step 3 実装（サインアップ・会社作成フロー）に置き換えること
// デモ要件: 栗本様1社・たかしさん1人を想定。新規登録UIは意図的に省略。

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const supabase = getClient()
  const router   = useRouter()

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError('メールアドレスまたはパスワードが正しくありません')
      setLoading(false)
      return
    }

    // ミドルウェアがセッションを確認して /projects にリダイレクトするが、
    // クライアント側でも明示的に push する
    router.push('/projects')
    router.refresh()
  }

  return (
    <div style={styles.bg}>
      <div style={styles.card}>
        {/* ロゴ / タイトル */}
        <div style={styles.logoArea}>
          <p style={styles.logoText}>現場AI</p>
          <p style={styles.subtitle}>ラグズ建築 管理ツール</p>
        </div>

        {/* ログインフォーム */}
        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label htmlFor="email" style={styles.label}>メールアドレス</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              placeholder="example@email.com"
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="password" style={styles.label}>パスワード</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              placeholder="パスワード"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            style={{ ...styles.button, ...(loading ? styles.buttonLoading : {}) }}
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── スタイル（CLAUDE.md デザイントークン準拠） ──

const styles = {
  bg: {
    minHeight: '100vh',
    background: '#FAFAFA',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    background: '#FFFFFF',
    borderRadius: 20,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
    padding: '40px 32px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 28,
  },
  logoArea: { textAlign: 'center' as const },
  logoText: {
    fontSize: 28,
    fontWeight: 700,
    color: '#1C1C1E',
    letterSpacing: '-1px',
    margin: 0,
  },
  subtitle: { fontSize: 13, color: '#8E8E93', marginTop: 4 },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: '#3C3C43' },
  input: {
    height: 44,
    padding: '0 14px',
    borderRadius: 10,
    border: '1.5px solid #E5E5EA',
    fontSize: 15,
    color: '#1C1C1E',
    background: '#FFFFFF',
    outline: 'none',
  },
  error: {
    fontSize: 13,
    color: '#FF3B30',
    margin: 0,
    textAlign: 'center' as const,
  },
  button: {
    height: 50,
    borderRadius: 14,
    border: 'none',
    background: 'linear-gradient(135deg, #00B4DB, #0083B0)',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
  buttonLoading: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
} as const
