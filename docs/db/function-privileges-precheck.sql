-- RAGZ: DB 関数の権限修正の前後確認（読み取り専用・何も変更しない）
-- 本番「現場愛」の SQL Editor で、適用前と適用後に 1 回ずつ実行する。結果は 1 つの表（section / item / detail）。
-- 接続情報・秘密情報は出力しない。会社・ユーザーは件数だけを出す。

WITH fn AS (
  SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
         p.proconfig, p.proacl, p.proowner, md5(p.prosrc) AS src_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')  -- 拡張機能（pg_trgm）の関数は除く
)
SELECT '1 function' AS section, sig AS item,
       concat_ws(' | ',
         CASE WHEN prosecdef THEN 'DEFINER' ELSE 'invoker' END,
         'owner=' || owner,
         'config=' || coalesce(array_to_string(proconfig, ','), '(none)'),
         -- PUBLIC（grantee=0）: proacl が NULL のときは既定の権限（PUBLIC に EXECUTE）を見る
         'PUBLIC=' || CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl, acldefault('f', proowner))) a
                                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'X' ELSE '-' END,
         'anon=' || CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'X' ELSE '-' END,
         'authenticated=' || CASE WHEN has_function_privilege('authenticated', oid, 'EXECUTE') THEN 'X' ELSE '-' END,
         'service_role=' || CASE WHEN has_function_privilege('service_role', oid, 'EXECUTE') THEN 'X' ELSE '-' END,
         'src_md5=' || left(src_md5, 12)) AS detail
FROM fn
UNION ALL
SELECT '2 event_trigger', evtname,
       concat_ws(' | ', 'event=' || evtevent, 'func=' || evtfoid::regproc::text, 'enabled=' || evtenabled::text,
                 'owner=' || pg_get_userbyid(evtowner), 'tags=' || coalesce(array_to_string(evttags, ','), '(all)'))
FROM pg_event_trigger
UNION ALL
SELECT '3 extension', extname, 'schema=' || extnamespace::regnamespace::text || ' | version=' || extversion
FROM pg_extension WHERE extname IN ('pg_trgm', 'pgcrypto', 'uuid-ossp')
UNION ALL
SELECT '4 default_acl', defaclrole::regrole::text || ' / ' || coalesce(defaclnamespace::regnamespace::text, '(all)') || ' / ' || defaclobjtype::text,
       defaclacl::text
FROM pg_default_acl WHERE defaclobjtype = 'f'
UNION ALL
SELECT '5 company_members', conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass AND contype IN ('u', 'p')
UNION ALL
SELECT '5 company_members', indexrelid::regclass::text, pg_get_indexdef(indexrelid)
FROM pg_index WHERE indrelid = 'public.company_members'::regclass
UNION ALL
SELECT '6 counts', 'companies', count(*)::text FROM public.companies
UNION ALL
SELECT '6 counts', 'company_members', count(*)::text FROM public.company_members
UNION ALL
SELECT '6 counts', 'members_user_id_null', count(*)::text FROM public.company_members WHERE user_id IS NULL
UNION ALL
SELECT '6 counts', 'users_with_2plus_companies', count(*)::text
FROM (SELECT user_id FROM public.company_members GROUP BY user_id HAVING count(*) > 1) x
UNION ALL
SELECT '6 counts', 'auth_users_without_company', count(*)::text
FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = u.id)
UNION ALL
-- Storage の RLS も get_my_company_ids() を使う（権限は変えないので、適用前後で同じであること）
SELECT '8 storage_policy', policyname, cmd || ' | uses_get_my_company_ids=' || (coalesce(qual, '') || coalesce(with_check, '') LIKE '%get_my_company_ids%')::text
FROM pg_policies WHERE schemaname = 'storage'
UNION ALL
SELECT '7 migrations', 'latest', coalesce(max(version), '(none)') || ' / rows=' || count(*)
FROM supabase_migrations.schema_migrations
ORDER BY 1, 2;
