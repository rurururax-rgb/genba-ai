import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase/server'
import { MaterialMasterList } from '@/components/materials/MaterialMasterList'

export const metadata = { title: '資材マスター — 現場AI' }

export default async function MaterialsPage() {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) redirect('/login')

  const { data: items } = await supabase
    .from('company_estimate_items')
    .select('id, name, spec, unit, selling_price, cost_price, url, category, usage_count, updated_at')
    .eq('company_id', membership.company_id)
    .order('updated_at', { ascending: false })

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto' }}>

      {/* ── ヘッダー ── */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 22, fontWeight: 700, color: '#1E3A5F',
          margin: 0, letterSpacing: '-0.02em',
        }}>
          資材マスター
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8A96A8', lineHeight: 1.6 }}>
          よく使う建材・資材の参考単価・URL を管理します。
          チャットAI から「○○を資材マスターに登録して」と指示して追加することもできます。
        </p>
      </div>

      {/* ── リスト ── */}
      <MaterialMasterList initialItems={items ?? []} />

    </main>
  )
}
