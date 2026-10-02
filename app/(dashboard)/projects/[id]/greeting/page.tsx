import { getServerClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { supportsLegacyRugsDocuments } from '@/lib/company/templates'
import { GreetingDocument } from './GreetingDocument'

type Params = Promise<{ id: string }>

export default async function GreetingPage({ params }: { params: Params }) {
  const { id } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, site_address, construction_period, customer_name')
      .eq('id', id)
      .single(),
    supabase
      .from('company_members')
      .select('company_id, companies(name, display_name, template_id)')
      .eq('user_id', user.id)
      .single(),
  ])

  if (!project) redirect('/projects')

  const co = membership?.companies as { name?: string; display_name?: string | null; template_id?: string | null } | null
  // 挨拶回り文書はラグズ建築専用の legacy 帳票（ロゴ・住所・代表者名が埋め込まれている）。
  // 対象会社以外では、直接 URL を開いても表示しない
  if (!supportsLegacyRugsDocuments(co)) notFound()
  const companyName = co?.display_name ?? co?.name ?? ''

  return (
    <GreetingDocument
      projectId={id}
      projectName={project.name ?? ''}
      siteAddress={project.site_address ?? ''}
      constructionPeriod={project.construction_period ?? ''}
      companyName={companyName}
    />
  )
}
