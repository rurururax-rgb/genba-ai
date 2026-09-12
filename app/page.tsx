'use client'

/**
 * ルートページ兼 Auth コールバックハンドラー
 *
 * Supabase から届くメールリンクはすべてこのページ（{SITE_URL}）に飛ぶ。
 * クライアント側で URL ハッシュ／クエリを解析し、フローに応じて振り分ける。
 *
 * ① #access_token + type=recovery  → パスワード再設定フォームを表示
 * ② #access_token + type=その他   → セッション確立 → /projects にリダイレクト
 * ③ ?code=...（PKCE flow）         → exchangeCodeForSession → /projects
 * ④ #error / #error_code           → リンク失効エラー画面を表示
 * ⑤ ハッシュなし                   → セッション確認 → /projects or /login
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClient } from '@/lib/supabase/client'

type Phase = 'loading' | 'reset' | 'error'

export default function AuthCallbackPage() {
  const supabase = useRef(getClient()).current
  const router   = useRouter()

  const [phase,      setPhase]      = useState<Phase>('loading')
  const [errMsg,     setErrMsg]     = useState('')
  const [pwd,        setPwd]        = useState('')
  const [pwdLoading, setPwdLoading] = useState(false)
  const [pwdError,   setPwdError]   = useState('')

  useEffect(() => {
    async function run() {
      // ──────────────────────────────────────────────────────────────
      // ① PKCE flow: ?code=... がある場合
      // ──────────────────────────────────────────────────────────────
      const search = new URLSearchParams(window.location.search)
      const code   = search.get('code')
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          setErrMsg('リンクの有効期限が切れました。もう一度お試しください。')
          setPhase('error')
          return
        }
        router.replace('/projects')
        return
      }

      // ──────────────────────────────────────────────────────────────
      // ② Implicit flow: URL ハッシュを解析
      // ──────────────────────────────────────────────────────────────
      const raw  = window.location.hash.slice(1) // '#' を除く
      if (!raw) {
        // ハッシュなし → 既存セッションを確認して振り分け
        const { data: { session } } = await supabase.auth.getSession()
        router.replace(session ? '/projects' : '/login')
        return
      }

      const p = new URLSearchParams(raw)

      // エラーパラメータの確認
      const errCode = p.get('error_code') ?? p.get('error')
      if (errCode) {
        const expired = errCode === 'otp_expired' || errCode === 'access_denied'
        setErrMsg(
          expired
            ? 'リンクの有効期限が切れました。もう一度お試しください。'
            : (p.get('error_description') ?? 'リンクが無効です。').replace(/\+/g, ' ')
        )
        setPhase('error')
        return
      }

      const accessToken  = p.get('access_token')
      const refreshToken = p.get('refresh_token')
      if (!accessToken || !refreshToken) {
        router.replace('/login')
        return
      }

      // セッション確立
      const { error: sessErr } = await supabase.auth.setSession({
        access_token:  accessToken,
        refresh_token: refreshToken,
      })
      if (sessErr) {
        setErrMsg('セッションの確立に失敗しました。もう一度お試しください。')
        setPhase('error')
        return
      }

      // type=recovery → パスワード再設定フォームへ
      if (p.get('type') === 'recovery') {
        setPhase('reset')
        return
      }

      // その他（magiclink / signup / invite など） → ダッシュボードへ
      router.replace('/projects')
    }

    run()
  }, [supabase, router])

  // ── パスワード再設定実行 ──────────────────────────────────
  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    if (pwd.length < 8) {
      setPwdError('パスワードは8文字以上で設定してください')
      return
    }
    setPwdLoading(true)
    setPwdError('')
    const { error } = await supabase.auth.updateUser({ password: pwd })
    if (error) {
      setPwdError('パスワードの更新に失敗しました。もう一度お試しください。')
      setPwdLoading(false)
      return
    }
    router.replace('/projects')
  }

  // ── レンダリング ──────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <div style={S.bg}>
        <div style={S.card}>
          <p style={S.logo}>現場AI</p>
          <div style={S.loadingRow}>
            <svg style={S.spinner} viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span style={S.loadingText}>認証情報を確認中…</span>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div style={S.bg}>
        <div style={S.card}>
          <p style={S.logo}>現場AI</p>
          <div style={S.errBox}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#D12953" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8"  x2="12"    y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p style={S.errText}>{errMsg}</p>
          </div>
          <a href="/login" style={S.backBtn}>
            ログイン画面へ戻る
          </a>
        </div>
      </div>
    )
  }

  // phase === 'reset'
  return (
    <div style={S.bg}>
      <div style={S.card}>
        <div style={S.top}>
          <p style={S.logo}>現場AI</p>
          <p style={S.sub}>新しいパスワードを設定してください</p>
        </div>
        <form onSubmit={handleReset} style={S.form}>
          <div style={S.field}>
            <label htmlFor="new-password" style={S.label}>
              新しいパスワード
            </label>
            <input
              id="new-password"
              type="password"
              required
              autoFocus
              autoComplete="new-password"
              placeholder="8文字以上"
              value={pwd}
              onChange={e => setPwd(e.target.value)}
              style={S.input}
            />
          </div>
          {pwdError && <p style={S.errInline}>{pwdError}</p>}
          <button
            type="submit"
            disabled={pwdLoading}
            style={{ ...S.btn, ...(pwdLoading ? S.btnDisabled : {}) }}
          >
            {pwdLoading ? '更新中…' : 'パスワードを更新'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────────

const ACCENT = '#0083B0'

const S = {
  bg: {
    minHeight: '100vh',
    background: '#FAFAFA',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  } as React.CSSProperties,

  card: {
    width: '100%',
    maxWidth: 360,
    background: '#FFFFFF',
    borderRadius: 20,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
    padding: '40px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  } as React.CSSProperties,

  logo: {
    fontSize: 28,
    fontWeight: 700,
    color: '#1C1C1E',
    letterSpacing: '-1px',
    margin: 0,
    textAlign: 'center',
  } as React.CSSProperties,

  top: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  } as React.CSSProperties,

  sub: {
    fontSize: 13,
    color: '#8E8E93',
    margin: 0,
    textAlign: 'center',
  } as React.CSSProperties,

  loadingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '8px 0',
  } as React.CSSProperties,

  spinner: {
    width: 18,
    height: 18,
    animation: 'spin 1s linear infinite',
    flexShrink: 0,
  } as React.CSSProperties,

  loadingText: {
    fontSize: 14,
    color: '#8E8E93',
  } as React.CSSProperties,

  errBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '16px 0 8px',
  } as React.CSSProperties,

  errText: {
    fontSize: 14,
    color: '#3C3C43',
    margin: 0,
    textAlign: 'center',
    lineHeight: '1.6',
  } as React.CSSProperties,

  backBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 14,
    background: 'linear-gradient(135deg, #00B4DB, #0083B0)',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 600,
    textDecoration: 'none',
  } as React.CSSProperties,

  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  } as React.CSSProperties,

  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as React.CSSProperties,

  label: {
    fontSize: 13,
    fontWeight: 500,
    color: '#3C3C43',
  } as React.CSSProperties,

  input: {
    height: 44,
    padding: '0 14px',
    borderRadius: 10,
    border: '1.5px solid #E5E5EA',
    fontSize: 15,
    color: '#1C1C1E',
    background: '#FFFFFF',
    outline: 'none',
  } as React.CSSProperties,

  errInline: {
    fontSize: 13,
    color: '#FF3B30',
    margin: 0,
    textAlign: 'center',
  } as React.CSSProperties,

  btn: {
    height: 50,
    borderRadius: 14,
    border: 'none',
    background: 'linear-gradient(135deg, #00B4DB, #0083B0)',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  } as React.CSSProperties,

  btnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  } as React.CSSProperties,
} as const
