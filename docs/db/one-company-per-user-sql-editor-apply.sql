-- =====================================================================
-- 1 ユーザー 1 社の制約 本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後に、このファイルの全文を本番「現場愛」の SQL Editor に貼り付けて 1 回だけ実行する。
-- ・関数の権限修正（function-privileges-sql-editor-apply.sql）とは独立している。どちらを先に適用してもよい。
-- ・全体を 1 つのトランザクションで実行する。2 社以上に所属するユーザーがいる・ロック待ちが 5 秒を超える
--   などで失敗しても、制約も履歴も残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・行うのは company_members への UNIQUE (user_id) の追加だけ。既存の行・制約・RLS ポリシーは変えない。
--   会社・所属の追加・削除・移動はしない。
-- ・制約の追加中（一瞬）は company_members がロックされ、画面操作が待たされる。利用者が少ない時間に実行する。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261121000002_one_company_per_user.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/function-privileges.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('public.qa_environment_marker') IS NOT NULL THEN
    RAISE EXCEPTION 'one-company-per-user apply aborted: QA marker found (this is not production)';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'one-company-per-user apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261016000001') THEN
    RAISE EXCEPTION 'one-company-per-user apply aborted: version 20261016000001 is not recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261121000002') THEN
    RAISE EXCEPTION 'one-company-per-user apply aborted: version 20261121000002 is already recorded';
  END IF;
  PERFORM set_config('oc.rows', (
    SELECT coalesce(md5(string_agg(m::text, '|' ORDER BY m.id)), '') FROM public.company_members m
  ), true);
  PERFORM set_config('oc.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public'
  ), true);
  PERFORM set_config('oc.constraints', (
    SELECT md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname))
    FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass
  ), true);
END
$guard$;

-- ── 1. migration 本体（事前確認・制約の追加） ──
-- >>> MIGRATION BODY
-- ============================================================
-- 1 ユーザーの所属を 1 社までにする（company_members.user_id に UNIQUE 制約）
--
-- 背景:
--   アプリは 1 ユーザー 1 社を前提にしている（getCurrentCompany() は company_members を .single() で読む。
--   多くの API ルートも maybeSingle() で所属を 1 件だけ読む）。
--   company_members には UNIQUE (company_id, user_id) しか無く、同じユーザーが 2 社に所属する行を作れる。
--   2 社目の所属ができると、そのユーザーはログイン後の画面・API がエラーになる。
--
-- 変更すること:
--   company_members に UNIQUE (user_id) を追加する（制約名 company_members_user_id_key）。
--   （user_id は NOT NULL。仮に NULL の行があっても UNIQUE は NULL を重複とみなさない）
--   既存の UNIQUE (company_id, user_id)・外部キー・RLS ポリシー・行は変えない。
--
-- 既存データ:
--   すでに 2 社以上に所属するユーザーがいれば、何も変えずにエラーで止まる（行の削除・移動はしない）。
--
-- 試用アカウントの移行（info@rugs-reform.jp を B 社から試用会社へ）への影響:
--   移行 SQL は 1 つのトランザクションで「B 社の所属を DELETE → 試用会社に INSERT」の順に行うため、
--   この制約があっても通る（DELETE が先なので重複の瞬間が無い）。
--   逆の順（INSERT → DELETE）や、所属を残したまま別の会社に追加する操作はこの制約で拒否される。
--
-- ロック:
--   制約の追加はインデックスを作る間 company_members に ACCESS EXCLUSIVE ロックを取る。
--   RLS の確認（get_my_company_ids()）が company_members を読むため、その間の画面操作は待たされる。
--   行数が少ない（本番 3 行）ので一瞬で終わる。
-- ============================================================

DO $$
DECLARE
  dup int;
BEGIN
  SELECT count(*) INTO dup
  FROM (
    SELECT user_id FROM public.company_members
    WHERE user_id IS NOT NULL
    GROUP BY user_id HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'one-company-per-user precondition failed: % user(s) belong to 2+ companies', dup;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.company_members'::regclass AND conname = 'company_members_user_id_key'
  ) THEN
    RAISE EXCEPTION 'one-company-per-user precondition failed: constraint company_members_user_id_key already exists';
  END IF;
END
$$;

ALTER TABLE public.company_members
  ADD CONSTRAINT company_members_user_id_key UNIQUE (user_id);

COMMENT ON CONSTRAINT company_members_user_id_key ON public.company_members IS
  '1 ユーザーの所属は 1 社まで（getCurrentCompany() の .single() 前提）。所属を移すときは DELETE してから INSERT する';
-- <<< MIGRATION BODY

-- ── 2. 適用後の検証（どれかが外れればトランザクション全体を取り消す） ──
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.company_members'::regclass AND conname = 'company_members_user_id_key'
      AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (user_id)'
  ) THEN
    RAISE EXCEPTION 'one-company-per-user verify failed: constraint not found';
  END IF;
  -- 既存の制約（主キー・UNIQUE (company_id, user_id)・外部キー）は変わらない
  IF (SELECT md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname))
      FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass AND conname <> 'company_members_user_id_key')
     IS DISTINCT FROM current_setting('oc.constraints', true) THEN
    RAISE EXCEPTION 'one-company-per-user verify failed: other constraints changed';
  END IF;
  IF (SELECT coalesce(md5(string_agg(m::text, '|' ORDER BY m.id)), '') FROM public.company_members m)
     IS DISTINCT FROM current_setting('oc.rows', true) THEN
    RAISE EXCEPTION 'one-company-per-user verify failed: company_members rows changed';
  END IF;
  IF (SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                     ORDER BY tablename, policyname)), '')
      FROM pg_policies WHERE schemaname = 'public') IS DISTINCT FROM current_setting('oc.policies', true) THEN
    RAISE EXCEPTION 'one-company-per-user verify failed: RLS policies changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録 ──
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261121000002');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'one_company_per_user', '20261121000002';
  END IF;
END
$history$;

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, constraint_exists = true, users_with_2plus_companies = 0） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261121000002') AS history_rows,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass
          AND conname = 'company_members_user_id_key') AS constraint_exists,
  (SELECT count(*) FROM (SELECT user_id FROM public.company_members WHERE user_id IS NOT NULL
                         GROUP BY user_id HAVING count(*) > 1) x) AS users_with_2plus_companies;
