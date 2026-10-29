import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase/server'

export const metadata = { title: '設定 — RUGZ' }

// 設定の一覧。実装済みの項目だけを並べる（未実装の項目は出さない）
const SECTIONS: { title: string; items: { href: string; label: string; description: string }[] }[] = [
  {
    title: 'アカウント設定',
    items: [
      { href: '/settings/password', label: 'パスワード変更', description: 'ログイン中のアカウントのパスワードを変更します' },
    ],
  },
]

export default async function SettingsPage() {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <main style={s.main}>
      <h1 style={s.title}>設定</h1>
      {SECTIONS.map(section => (
        <section key={section.title} style={s.section} aria-labelledby={`settings-${section.title}`}>
          <h2 id={`settings-${section.title}`} style={s.sectionTitle}>{section.title}</h2>
          <ul style={s.list}>
            {section.items.map(item => (
              <li key={item.href}>
                <Link href={item.href} style={s.item}>
                  <span style={s.itemText}>
                    <span style={s.itemLabel}>{item.label}</span>
                    <span style={s.itemDescription}>{item.description}</span>
                  </span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8AA491"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}

const s = {
  main: { padding: '24px 20px', maxWidth: 560, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: '#1E3A5F', margin: '0 0 20px', letterSpacing: '-0.02em' },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#8A96A8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    margin: '0 0 8px 4px',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    background: '#FFFFFF',
    borderRadius: 12,
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 56,
    padding: '10px 16px',
    textDecoration: 'none',
  },
  itemText: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  itemLabel: { fontSize: 15, fontWeight: 500, color: '#1A2E24' },
  itemDescription: { fontSize: 12, color: '#8A96A8' },
} as const
