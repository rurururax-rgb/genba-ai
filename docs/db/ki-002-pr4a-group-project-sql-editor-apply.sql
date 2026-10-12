-- =====================================================================
-- KI-002 PR-4a: 見積行・工程の工種を同じ案件に限る（2 参照）の本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・前提: 20261014000001（KI-002 PR-3）が適用済み・履歴に記録済みであること。未記録ならガードで止まる。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、制約・migration 履歴の
--   どれも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・行うのは estimate_groups の UNIQUE (id, project_id) と、複合外部キー 2 つの追加だけ:
--     estimate_items (group_id, project_id)          → estimate_groups (id, project_id) ON DELETE SET NULL (group_id)
--     schedule_items (estimate_group_id, project_id) → estimate_groups (id, project_id) ON DELETE SET NULL (estimate_group_id)
--   RLS ポリシー・権限・列・既存の外部キーは変えない。業務データの INSERT / UPDATE / DELETE も行わない。
--   他の案件の工種を指す行・工種の無い行・案件が NULL の工種を指す行が 1 件でもあれば止まる。
-- ・制約の追加中は estimate_groups / estimate_items / schedule_items の書き込みが待たされる（コミットまで。
--   行数が少ないため数秒以内）。ロック待ちは lock_timeout = 5s で打ち切って全体を取り消す
--   （55P03 が出たら時間をおいて再実行する）。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261015000001_enforce_group_project_match.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/ki-002-pr4a-group-project-match.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'group-project-1 apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000001') THEN
    RAISE EXCEPTION 'group-project-1 apply aborted: version 20261014000001 is not recorded (apply it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261015000001') THEN
    RAISE EXCEPTION 'group-project-1 apply aborted: version 20261015000001 is already recorded';
  END IF;
  -- 履歴なしで制約だけある（想定外の状態）なら触らない
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_groups_id_project_id_key',
    'estimate_items_group_project_fkey',
    'schedule_items_estimate_group_project_fkey'
  )) THEN
    RAISE EXCEPTION 'group-project-1 apply aborted: constraints already exist (history is missing)';
  END IF;
  -- 適用後に RLS ポリシー・テーブル権限・既存の制約が変わっていないことを確かめるため、適用前の状態を記録する
  PERFORM set_config('gpm1.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public'
  ), true);
  PERFORM set_config('gpm1.grants', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), ';'
                                   ORDER BY table_name, grantee, privilege_type)), '')
    FROM information_schema.role_table_grants WHERE table_schema = 'public'
  ), true);
  PERFORM set_config('gpm1.constraints', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s', conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)), ';'
                                   ORDER BY conrelid::regclass::text, conname)), '')
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  ), true);
END
$guard$;

-- ── 1. migration 本体（事前確認・一意制約・複合外部キー） ──
-- >>> MIGRATION BODY
-- ============================================================
-- KI-002 PR-4a: 見積行・工程が指す工種を「同じ案件の工種」に DB で限る
--
-- 抜け道:
--   estimate_items.group_id・schedule_items.estimate_group_id は単独の外部キー → estimate_groups(id) で、
--   工種の案件・会社を見ない。RLS は行の company_id しか見ず、外部キーの確認は RLS を通らないため、
--   PostgREST（/rest/v1/...）や service_role から、他の案件（他社を含む）の工種を指す行を INSERT / UPDATE できる。
--   API 側の確認（KI-002 PR-2）は API を通る書き込みしか止められない。
--
-- 修正（最小限）:
--   estimate_groups に UNIQUE (id, project_id) を足し、次の複合外部キーを足す:
--     estimate_items (group_id, project_id)          → estimate_groups (id, project_id) ON DELETE SET NULL (group_id)
--     schedule_items (estimate_group_id, project_id) → estimate_groups (id, project_id) ON DELETE SET NULL (estimate_group_id)
--   - 同じ案件なら会社も同じ（20261013000002 / 20261014000001 で、各行の (project_id, company_id) は projects と一致する）。
--     会社の列は含めない。
--   - ON DELETE SET NULL (列) は PostgreSQL 15 以上。工種の列だけを NULL にし、NOT NULL の project_id には触れない
--     （素の SET NULL は project_id まで NULL にしようとして失敗する）。既存の単独の外部キーと同じ動き。
--   - MATCH SIMPLE（既定）: 工種が NULL（未分類）の行は確かめない（従来どおり）。参照元の project_id は NOT NULL
--     （事前確認で確かめる）なので、NULL の抜け道は無い。
--   - 外部キーは deleted_at を見ない。論理削除済みの工種を指す既存の行（工種の削除 API は工程の参照を NULL にしない）は
--     DB 上は同じ案件の工種なので、そのまま許す。
--
--   既存の単独の外部キー・RLS ポリシー・テーブル権限・列・トリガー・関数は変えない。
--
-- 安全方針:
--   - 既存データの UPDATE / DELETE / TRUNCATE なし。食い違いの自動補正もしない。
--   - 次のどれかに当てはまれば、何も作らずに止まる（1 つのメッセージにまとめて出す）:
--       PostgreSQL 15 未満／テーブル・列が無い・型が uuid でない／参照元の project_id が NULL を許す／
--       既存の単独の外部キーが無い・ON DELETE が SET NULL でない／同じ名前の制約が想定と違う定義で既にある／
--       参照先の工種が無い行・工種の project_id が NULL の行・工種の案件が違う行が 1 件でもある
--   - 制約は NOT VALID で追加してから VALIDATE する（同じトランザクション内。途中で失敗すれば何も残らない）
--   - 再適用できる（定義が一致する制約が既にあれば作らない。増えない）
--   - ロック待ちは lock_timeout で打ち切る（取り消して時間をおいて再実行する）
--
-- 影響:
--   - 工種を指す行がある間は、その工種の project_id を変更できなくなる（アプリに変更する経路は無い）。
--   - 工種を指したまま見積行・工程の project_id を別の案件へ変えることはできなくなる（同上）。
-- ============================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 事前確認 ──
DO $$
DECLARE
  t          record;
  problems   text[] := '{}';
  v_type     text;
  v_nullable text;
  v_dels     text[];
  v_orphan   bigint;
  v_tnull    bigint;
  v_mismatch bigint;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'group-project-1 precondition failed: PostgreSQL 15 or later is required (ON DELETE SET NULL (column))';
  END IF;

  IF to_regclass('public.estimate_groups') IS NULL THEN
    problems := problems || 'estimate_groups: table missing'::text;
  ELSE
    SELECT string_agg(format('%s=%s', c.column_name, c.data_type), ',' ORDER BY c.column_name) INTO v_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'estimate_groups' AND c.column_name IN ('id', 'project_id');
    IF v_type IS DISTINCT FROM 'id=uuid,project_id=uuid' THEN
      problems := problems || format('estimate_groups: unexpected columns (%s)', coalesce(v_type, 'none'));
    END IF;
    -- 同じ名前の一意制約が既にあるなら、(id, project_id) の UNIQUE であること
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.estimate_groups'::regclass AND c.conname = 'estimate_groups_id_project_id_key'
        AND NOT (c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['id', 'project_id'])
    ) THEN
      problems := problems || 'estimate_groups: constraint estimate_groups_id_project_id_key exists with a different definition'::text;
    END IF;
  END IF;

  FOR t IN
    SELECT * FROM (VALUES
      ('estimate_items', 'group_id',          'estimate_items_group_project_fkey'),
      ('schedule_items', 'estimate_group_id', 'schedule_items_estimate_group_project_fkey')
    ) AS v(tbl, col, fk)
    ORDER BY tbl
  LOOP
    IF to_regclass(format('public.%I', t.tbl)) IS NULL THEN
      problems := problems || format('%s: table missing', t.tbl);
      CONTINUE;
    END IF;

    -- 列と型
    SELECT string_agg(format('%s=%s', c.column_name, c.data_type), ',' ORDER BY c.column_name) INTO v_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name IN (t.col, 'project_id');
    IF v_type IS DISTINCT FROM (SELECT string_agg(x || '=uuid', ',' ORDER BY x) FROM unnest(ARRAY[t.col, 'project_id']) x) THEN
      problems := problems || format('%s: unexpected columns (%s)', t.tbl, coalesce(v_type, 'none'));
      CONTINUE;
    END IF;

    -- 参照元の project_id は NOT NULL であること（NULL だと MATCH SIMPLE が一致を確かめない）
    SELECT c.is_nullable INTO v_nullable FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'project_id';
    IF v_nullable <> 'NO' THEN
      problems := problems || format('%s: project_id is nullable', t.tbl);
    END IF;

    -- 既存の単独の外部キー（工種の列 → estimate_groups(id)）と、その ON DELETE（n = SET NULL）
    SELECT array_agg(DISTINCT c.confdeltype::text) INTO v_dels
    FROM pg_constraint c
    WHERE c.conrelid = format('public.%I', t.tbl)::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.estimate_groups'::regclass
      AND (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k(n)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY[t.col];
    IF v_dels IS DISTINCT FROM ARRAY['n'] THEN
      problems := problems || format('%s: existing %s fkey on delete is %s (expected n)', t.tbl, t.col, coalesce(v_dels::text, 'missing'));
    END IF;

    -- 同じ名前の制約が既にあるなら、定義が想定どおりであること（名前だけで判断しない）
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = format('public.%I', t.tbl)::regclass AND c.conname = t.fk
        AND NOT (
          c.contype = 'f' AND c.confrelid = 'public.estimate_groups'::regclass
          AND c.confdeltype = 'n' AND c.confupdtype = 'a' AND c.confmatchtype = 's'
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY[t.col, 'project_id']
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) = ARRAY['id', 'project_id']
          AND (SELECT array_agg(a.attname::text) FROM unnest(c.confdelsetcols) k(n)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY[t.col]
        )
    ) THEN
      problems := problems || format('%s: constraint %s exists with a different definition', t.tbl, t.fk);
    END IF;

    -- 既存データ（参照先の工種が無い・工種の project_id が NULL・工種の案件が違う）。論理削除済みの行も数える
    IF to_regclass('public.estimate_groups') IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FILTER (WHERE g.id IS NULL),
                count(*) FILTER (WHERE g.id IS NOT NULL AND g.project_id IS NULL),
                count(*) FILTER (WHERE g.project_id <> x.project_id)
         FROM public.%I x LEFT JOIN public.estimate_groups g ON g.id = x.%I
         WHERE x.%I IS NOT NULL', t.tbl, t.col, t.col)
        INTO v_orphan, v_tnull, v_mismatch;
      IF v_orphan > 0 OR v_tnull > 0 OR v_mismatch > 0 THEN
        problems := problems || format('%s: orphan=%s group_project_null=%s mismatched=%s', t.tbl, v_orphan, v_tnull, v_mismatch);
      END IF;
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'group-project-1 precondition failed: %', array_to_string(problems, '; ');
  END IF;
END
$$;

-- ── 参照先の一意制約 ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.estimate_groups'::regclass AND conname = 'estimate_groups_id_project_id_key') THEN
    ALTER TABLE public.estimate_groups ADD CONSTRAINT estimate_groups_id_project_id_key UNIQUE (id, project_id);
  END IF;
  COMMENT ON CONSTRAINT estimate_groups_id_project_id_key ON public.estimate_groups IS
    '見積行・工程の複合外部キー (工種, project_id) の参照先（id は主キーなので常に一意）';
END
$$;

-- ── 複合外部キー（NOT VALID で追加してから VALIDATE。定義の一致する制約が既にあれば作らない） ──
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('estimate_items', 'group_id',          'estimate_items_group_project_fkey'),
      ('schedule_items', 'estimate_group_id', 'schedule_items_estimate_group_project_fkey')
    ) AS v(tbl, col, fk)
    ORDER BY tbl
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = format('public.%I', t.tbl)::regclass AND conname = t.fk) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I, project_id)
           REFERENCES public.estimate_groups (id, project_id) ON DELETE SET NULL (%I) NOT VALID',
        t.tbl, t.fk, t.col, t.col);
    END IF;
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t.tbl, t.fk);
    EXECUTE format('COMMENT ON CONSTRAINT %I ON public.%I IS %L', t.fk, t.tbl,
      '工種は同じ案件の工種であること（RLS は company_id しか見ないため DB で保証する。工種が NULL の行は対象外。'
      || '工種の物理削除では工種の列だけを NULL にする）');
  END LOOP;
END
$$;
-- <<< MIGRATION BODY

-- ── 2. 適用後の検証（どれかが外れればトランザクション全体を取り消す） ──
DO $verify$
DECLARE
  v_text text;
BEGIN
  IF (SELECT count(*) FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'estimate_groups_id_project_id_key',
    'estimate_items_group_project_fkey',
    'schedule_items_estimate_group_project_fkey'
  )) <> 3 THEN
    RAISE EXCEPTION 'group-project-1 verify failed: constraints missing or not validated';
  END IF;
  -- 定義（列の順・参照先・ON DELETE SET NULL の列）
  SELECT string_agg(format('%s|%s', conname, pg_get_constraintdef(oid)), ';' ORDER BY conname) INTO v_text
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_groups_id_project_id_key',
    'estimate_items_group_project_fkey',
    'schedule_items_estimate_group_project_fkey'
  );
  IF v_text IS DISTINCT FROM
       'estimate_groups_id_project_id_key|UNIQUE (id, project_id);'
    || 'estimate_items_group_project_fkey|FOREIGN KEY (group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (group_id);'
    || 'schedule_items_estimate_group_project_fkey|FOREIGN KEY (estimate_group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (estimate_group_id)'
  THEN
    RAISE EXCEPTION 'group-project-1 verify failed: unexpected definitions (%)', v_text;
  END IF;
  -- 既存の制約（単独の外部キー・PR #35・PR-3 を含む）は変わっていない。増えたのは上の 3 つだけ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s', conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)), ';'
                                   ORDER BY conrelid::regclass::text, conname)), '')
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname NOT IN (
    'estimate_groups_id_project_id_key',
    'estimate_items_group_project_fkey',
    'schedule_items_estimate_group_project_fkey'
  ) INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('gpm1.constraints', true) THEN
    RAISE EXCEPTION 'group-project-1 verify failed: existing constraints changed';
  END IF;
  -- RLS ポリシー・テーブル権限は適用前と同じ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public' INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('gpm1.policies', true) THEN
    RAISE EXCEPTION 'group-project-1 verify failed: RLS policies changed';
  END IF;
  SELECT coalesce(md5(string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), ';'
                                   ORDER BY table_name, grantee, privilege_type)), '')
    FROM information_schema.role_table_grants WHERE table_schema = 'public' INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('gpm1.grants', true) THEN
    RAISE EXCEPTION 'group-project-1 verify failed: table privileges changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261015000001');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'enforce_group_project_match', '20261015000001';
  END IF;
END
$history$;

-- PostgREST に制約の変更を読み込ませる（通知はコミット時に送られる。取り消された場合は送られない）
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, valid_constraints = 3, prior_constraints = 21） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261015000001') AS history_rows,
  (SELECT count(*) FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'estimate_groups_id_project_id_key',
    'estimate_items_group_project_fkey',
    'schedule_items_estimate_group_project_fkey'
  )) AS valid_constraints,
  (SELECT count(*) FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey',
    'line_events_project_requires_company_check',
    'ai_summaries_project_company_fkey', 'cost_ledger_items_project_company_fkey', 'estimate_documents_project_company_fkey',
    'estimate_groups_project_company_fkey', 'invoice_documents_project_company_fkey', 'line_event_notes_project_company_fkey',
    'project_billing_milestones_project_company_fkey', 'project_files_project_company_fkey', 'project_notes_project_company_fkey',
    'schedule_draft_adoptions_project_company_fkey', 'schedule_items_project_company_fkey', 'share_links_project_company_fkey',
    'cost_ledger_items_project_requires_company_check', 'estimate_groups_project_requires_company_check',
    'invoice_documents_project_requires_company_check', 'project_billing_milestones_project_requires_company_check',
    'schedule_draft_adoptions_project_requires_company_check'
  )) AS prior_constraints;
