import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
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
      .select('company_id, companies(name, display_name)')
      .eq('user_id', user.id)
      .single(),
  ])

  if (!project) redirect('/projects')

  const co = membership?.companies as { name?: string; display_name?: string | null } | null
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
