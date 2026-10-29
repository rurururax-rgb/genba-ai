'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy'

type Status =
  | { kind: 'idle' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; otherSessionsSignedOut: boolean }

// パスワード変更フォーム。判定はすべて POST /api/account/password で行い、ここでは入力の取りまとめと表示だけを行う
export function PasswordChangeForm({ email }: { email: string }) {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [nonce, setNonce] = useState('')
  // Supabase が本人確認コードを求めたときだけコード入力欄を出す
  const [needsNonce, setNeedsNonce] = useState(false)
  const [nonceSent, setNonceSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function sendNonce() {
    setLoading(true)
    setStatus({ kind: 'idle' })
    try {
      const res = await fetch('/api/account/password/reauthenticate', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setStatus({ kind: 'error', message: body.error ?? '確認コードを送れませんでした' })
        return
      }
      setNonceSent(true)
    } catch {
      setStatus({ kind: 'error', message: '通信に失敗しました。もう一度お試しください' })
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (next.length < PASSWORD_MIN_LENGTH) {
      setStatus({ kind: 'error', message: `新しいパスワードは${PASSWORD_MIN_LENGTH}文字以上で設定してください` })
      return
    }
    if (next !== confirm) {
      setStatus({ kind: 'error', message: '新しいパスワード（確認）が一致しません' })
      return
    }

    setLoading(true)
    setStatus({ kind: 'idle' })
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: current,
          new_password: next,
          ...(needsNonce && nonce.trim() ? { nonce: nonce.trim() } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (body.code === 'reauthentication_needed') setNeedsNonce(true)
        if (body.code === 'unauthorized') {
          router.replace('/login')
          return
        }
        setStatus({ kind: 'error', message: body.error ?? 'パスワードの変更に失敗しました' })
        return
      }
      setCurrent('')
      setNext('')
      setConfirm('')
      setNonce('')
      setNeedsNonce(false)
      setNonceSent(false)
      setStatus({ kind: 'done', otherSessionsSignedOut: body.other_sessions_signed_out !== false })
    } catch {
      setStatus({ kind: 'error', message: '通信に失敗しました。もう一度お試しください' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.card}>
      {/* パスワード管理ツールがどのアカウントのパスワードか判別できるようにする */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />

      <div style={s.field}>
        <label htmlFor="current-password" style={s.label}>現在のパスワード</label>
        <Input
          id="current-password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={e => setCurrent(e.target.value)}
        />
      </div>

      <div style={s.field}>
        <label htmlFor="new-password" style={s.label}>新しいパスワード</label>
        <Input
          id="new-password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          placeholder={`${PASSWORD_MIN_LENGTH}文字以上`}
          value={next}
          onChange={e => setNext(e.target.value)}
        />
      </div>

      <div style={s.field}>
        <label htmlFor="confirm-password" style={s.label}>新しいパスワード（確認）</label>
        <Input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
        />
      </div>

      {needsNonce && (
        <div style={s.reauth}>
          <p style={s.reauthText}>
            本人確認のため、登録メールアドレスに届く確認コードを入力してください。
          </p>
          <button type="button" onClick={sendNonce} disabled={loading} style={s.secondaryBtn}>
            {nonceSent ? '確認コードを再送する' : '確認コードを送る'}
          </button>
          {nonceSent && <p style={s.hint}>確認コードを送りました。メールをご確認ください。</p>}
          <div style={s.field}>
            <label htmlFor="reauth-nonce" style={s.label}>確認コード</label>
            <Input
              id="reauth-nonce"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={nonce}
              onChange={e => setNonce(e.target.value)}
            />
          </div>
        </div>
      )}

      {status.kind === 'error' && <p role="alert" style={s.error}>{status.message}</p>}
      {status.kind === 'done' && (
        <p role="status" style={s.done}>
          パスワードを変更しました。
          {status.otherSessionsSignedOut
            ? 'ほかの端末ではログアウトされました。'
            : 'ほかの端末のログアウトに失敗しました。必要なら各端末でログアウトしてください。'}
        </p>
      )}

      <button type="submit" disabled={loading} style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }}>
        {loading ? '処理中…' : 'パスワードを変更'}
      </button>
    </form>
  )
}

const s = {
  card: {
    background: '#FFFFFF',
    borderRadius: 16,
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: '#3C3C43' },
  reauth: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    padding: 14,
    borderRadius: 10,
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
  },
  reauthText: { fontSize: 13, color: '#92400E', margin: 0, lineHeight: 1.6 },
  hint: { fontSize: 12, color: '#92400E', margin: 0 },
  error: { fontSize: 13, color: '#D12953', margin: 0 },
  done: { fontSize: 13, color: '#3B6D11', background: '#EAF3DE', borderRadius: 8, padding: '10px 12px', margin: 0 },
  btn: {
    height: 48,
    borderRadius: 8,
    border: 'none',
    background: '#2B5E40',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.6, cursor: 'not-allowed' },
  secondaryBtn: {
    height: 44,
    borderRadius: 8,
    border: '1px solid #D5DED8',
    background: '#FFFFFF',
    color: '#2B5E40',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
} as const
