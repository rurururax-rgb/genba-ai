import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function main() {
  const { data, error } = await sb
    .from('projects')
    .select('id, name, status')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) { console.error(error.message); process.exit(1) }
  console.log(JSON.stringify(data, null, 2))
}

main()
