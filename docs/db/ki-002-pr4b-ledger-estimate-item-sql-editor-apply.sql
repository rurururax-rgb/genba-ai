-- =====================================================================
-- KI-002 PR-4b: 原価台帳の行が指す見積行を同じ案件に限る（1 参照）の本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・前提: 20261014000001（KI-002 PR-3）が適用済み・履歴に記録済みであること。未記録ならガードで止まる。
--   PR-4a（20261015000001）とは独立している（適用の有無を問わない。順序は PR-4a → PR-4b を推奨）。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、制約・migration 履歴の
--   どれも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・行うのは estimate_items の UNIQUE (id, project_id) と、複合外部キー 1 つの追加だけ:
--     cost_ledger_items (estimate_item_id, project_id) → estimate_items (id, project_id) ON DELETE SET NULL (estimate_item_id)
--   RLS ポリシー・権限・列・既存の外部キー・トリガーは変えない。業務データの INSERT / UPDATE / DELETE も行わない。
--   他の案件の見積行を指す台帳行・見積行の無い台帳行・案件が NULL の見積行を指す台帳行が 1 件でもあれば止まる。
-- ・一意制約の追加中は estimate_items の読み書きが止まる（ACCESS EXCLUSIVE。コミットまで）。外部キーの追加中は
--   estimate_items / cost_ledger_items の書き込みが待たされる（コミットまで。行数が少ないため数秒以内）。
--   ロック待ちは lock_timeout = 5s で打ち切って全体を取り消す（55P03 が出たら時間をおいて再実行する）。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261016000001_enforce_ledger_estimate_item_project_match.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/ki-002-pr4b-ledger-estimate-item-match.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'ledger-item-project-1 apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000001') THEN
    RAISE EXCEPTION 'ledger-item-project-1 apply aborted: version 20261014000001 is not recorded (apply it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261016000001') THEN
    RAISE EXCEPTION 'ledger-item-project-1 apply aborted: version 20261016000001 is already recorded';
  END IF;
  -- 履歴なしで制約だけある（想定外の状態）なら触らない
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  )) THEN
    RAISE EXCEPTION 'ledger-item-project-1 apply aborted: constraints already exist (history is missing)';
  END IF;
  -- 適用後に RLS ポリシー・テーブル権限・既存の制約・トリガーが変わっていないことを確かめるため、適用前の状態を記録する
  PERFORM set_config('lip1.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public'
  ), true);
  PERFORM set_config('lip1.grants', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), ';'
                                   ORDER BY table_name, grantee, privilege_type)), '')
    FROM information_schema.role_table_grants WHERE table_schema = 'public'
  ), true);
  PERFORM set_config('lip1.constraints', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s', conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)), ';'
                                   ORDER BY conrelid::regclass::text, conname)), '')
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  ), true);
  PERFORM set_config('lip1.triggers', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s', tgrelid::regclass, tgname, tgenabled), ';'
                                   ORDER BY tgrelid::regclass::text, tgname)), '')
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (to_regclass('public.cost_ledger_items'), to_regclass('public.estimate_items'))
  ), true);
END
$guard$;

-- ── 1. migration 本体（事前確認・一意制約・複合外部キー） ──
-- >>> MIGRATION BODY
-- ============================================================
-- KI-002 PR-4b: 原価台帳の行が指す見積行を「同じ案件の見積行」に DB で限る
--
-- 抜け道:
--   cost_ledger_items.estimate_item_id は単独の外部キー → estimate_items(id) で、見積行の案件・会社を見ない。
--   RLS は行の company_id しか見ず、外部キーの確認は RLS を通らないため、PostgREST（/rest/v1/...）や
--   service_role から、他の案件（他社を含む）の見積行を指す台帳行を INSERT / UPDATE できる。
--   原価台帳の同期（app/api/cost-ledger/sync）は estimate_item_id で見積行と台帳行を突き合わせるため、
--   他の案件の見積行を指す行は「見積から消えた行」として扱われる。
--   API（cost-ledger/init・sync）は同じ案件の見積行からしか estimate_item_id を入れない。API を通らない書き込みは止められない。
--
-- 修正（最小限）:
--   estimate_items に UNIQUE (id, project_id) を足し、次の複合外部キーを足す:
--     cost_ledger_items (estimate_item_id, project_id) → estimate_items (id, project_id) ON DELETE SET NULL (estimate_item_id)
--   - 同じ案件なら会社も同じ（20261013000002 / 20261014000001 で、各行の (project_id, company_id) は projects と一致する）。
--     会社の列は含めない。
--   - ON DELETE SET NULL (列) は PostgreSQL 15 以上。estimate_item_id だけを NULL にし、NOT NULL の project_id には触れない
--     （素の SET NULL は project_id まで NULL にしようとして失敗する）。既存の単独の外部キーと同じ動き。
--   - MATCH SIMPLE（既定）: estimate_item_id が NULL（手動で追加した行）の行は確かめない（従来どおり）。
--     参照元の project_id は NOT NULL（事前確認で確かめる）なので、NULL の抜け道は無い。
--   - 外部キーは deleted_at を見ない。論理削除済みの見積行を指す台帳行（sync が論理削除した行・同期前の行）は
--     DB 上は同じ案件の見積行なので、そのまま許す。
--
--   既存の単独の外部キー・RLS ポリシー・テーブル権限・列・トリガー・関数は変えない。
--
-- 安全方針:
--   - 既存データの UPDATE / DELETE / TRUNCATE なし。食い違いの自動補正もしない。
--   - 次のどれかに当てはまれば、何も作らずに止まる（1 つのメッセージにまとめて出す）:
--       PostgreSQL 15 未満／テーブル・列が無い・型が uuid でない／参照元の project_id が NULL を許す／
--       既存の単独の外部キーが無い・ON DELETE が SET NULL でない／同じ名前の制約が想定と違う定義で既にある／
--       参照先の見積行が無い行・見積行の project_id が NULL の行・見積行の案件が違う行が 1 件でもある
--   - 制約は NOT VALID で追加してから VALIDATE する（同じトランザクション内。途中で失敗すれば何も残らない）
--   - 再適用できる（定義が一致する制約が既にあれば作らない。増えない）
--   - ロック待ちは lock_timeout で打ち切る（取り消して時間をおいて再実行する）
--
-- 影響:
--   - 見積行を指す台帳行がある間は、その見積行の project_id を変更できなくなる（アプリに変更する経路は無い）。
--   - 見積行を指したまま台帳行の project_id を別の案件へ変えることはできなくなる（同上）。
-- ============================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 事前確認 ──
DO $$
DECLARE
  problems   text[] := '{}';
  v_type     text;
  v_nullable text;
  v_dels     text[];
  v_orphan   bigint;
  v_tnull    bigint;
  v_mismatch bigint;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'ledger-item-project-1 precondition failed: PostgreSQL 15 or later is required (ON DELETE SET NULL (column))';
  END IF;

  -- 参照先: estimate_items (id, project_id)
  IF to_regclass('public.estimate_items') IS NULL THEN
    problems := problems || 'estimate_items: table missing'::text;
  ELSE
    SELECT string_agg(format('%s=%s', c.column_name, c.data_type), ',' ORDER BY c.column_name) INTO v_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'estimate_items' AND c.column_name IN ('id', 'project_id');
    IF v_type IS DISTINCT FROM 'id=uuid,project_id=uuid' THEN
      problems := problems || format('estimate_items: unexpected columns (%s)', coalesce(v_type, 'none'));
    END IF;
    -- 同じ名前の一意制約が既にあるなら、(id, project_id) の UNIQUE であること
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.estimate_items'::regclass AND c.conname = 'estimate_items_id_project_id_key'
        AND NOT (c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['id', 'project_id'])
    ) THEN
      problems := problems || 'estimate_items: constraint estimate_items_id_project_id_key exists with a different definition'::text;
    END IF;
  END IF;

  -- 参照元: cost_ledger_items (estimate_item_id, project_id)
  IF to_regclass('public.cost_ledger_items') IS NULL THEN
    problems := problems || 'cost_ledger_items: table missing'::text;
  ELSE
    -- 列と型
    SELECT string_agg(format('%s=%s', c.column_name, c.data_type), ',' ORDER BY c.column_name) INTO v_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'cost_ledger_items' AND c.column_name IN ('estimate_item_id', 'project_id');
    IF v_type IS DISTINCT FROM 'estimate_item_id=uuid,project_id=uuid' THEN
      problems := problems || format('cost_ledger_items: unexpected columns (%s)', coalesce(v_type, 'none'));
    ELSE
      -- 参照元の project_id は NOT NULL であること（NULL だと MATCH SIMPLE が一致を確かめない）
      SELECT c.is_nullable INTO v_nullable FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'cost_ledger_items' AND c.column_name = 'project_id';
      IF v_nullable <> 'NO' THEN
        problems := problems || 'cost_ledger_items: project_id is nullable'::text;
      END IF;

      -- 既存の単独の外部キー（estimate_item_id → estimate_items(id)）と、その ON DELETE（n = SET NULL）
      IF to_regclass('public.estimate_items') IS NOT NULL THEN
        SELECT array_agg(DISTINCT c.confdeltype::text) INTO v_dels
        FROM pg_constraint c
        WHERE c.conrelid = 'public.cost_ledger_items'::regclass AND c.contype = 'f'
          AND c.confrelid = 'public.estimate_items'::regclass
          AND (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k(n)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['estimate_item_id'];
        IF v_dels IS DISTINCT FROM ARRAY['n'] THEN
          problems := problems || format('cost_ledger_items: existing estimate_item_id fkey on delete is %s (expected n)',
                                         coalesce(v_dels::text, 'missing'));
        END IF;
      END IF;

      -- 同じ名前の制約が既にあるなら、定義が想定どおりであること（名前だけで判断しない）
      IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.cost_ledger_items'::regclass AND c.conname = 'cost_ledger_items_estimate_item_project_fkey'
          AND NOT (
            c.contype = 'f' AND c.confrelid = to_regclass('public.estimate_items')
            AND c.confdeltype = 'n' AND c.confupdtype = 'a' AND c.confmatchtype = 's'
            AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['estimate_item_id', 'project_id']
            AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) = ARRAY['id', 'project_id']
            AND (SELECT array_agg(a.attname::text) FROM unnest(c.confdelsetcols) k(n)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['estimate_item_id']
          )
      ) THEN
        problems := problems || 'cost_ledger_items: constraint cost_ledger_items_estimate_item_project_fkey exists with a different definition'::text;
      END IF;

      -- 既存データ（参照先の見積行が無い・見積行の project_id が NULL・見積行の案件が違う）。論理削除済みの行も数える
      IF to_regclass('public.estimate_items') IS NOT NULL THEN
        SELECT count(*) FILTER (WHERE e.id IS NULL),
               count(*) FILTER (WHERE e.id IS NOT NULL AND e.project_id IS NULL),
               count(*) FILTER (WHERE e.project_id <> x.project_id)
          INTO v_orphan, v_tnull, v_mismatch
        FROM public.cost_ledger_items x LEFT JOIN public.estimate_items e ON e.id = x.estimate_item_id
        WHERE x.estimate_item_id IS NOT NULL;
        IF v_orphan > 0 OR v_tnull > 0 OR v_mismatch > 0 THEN
          problems := problems || format('cost_ledger_items: orphan=%s estimate_item_project_null=%s mismatched=%s',
                                         v_orphan, v_tnull, v_mismatch);
        END IF;
      END IF;
    END IF;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'ledger-item-project-1 precondition failed: %', array_to_string(problems, '; ');
  END IF;
END
$$;

-- ── 参照先の一意制約 ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.estimate_items'::regclass AND conname = 'estimate_items_id_project_id_key') THEN
    ALTER TABLE public.estimate_items ADD CONSTRAINT estimate_items_id_project_id_key UNIQUE (id, project_id);
  END IF;
  COMMENT ON CONSTRAINT estimate_items_id_project_id_key ON public.estimate_items IS
    '原価台帳の複合外部キー (estimate_item_id, project_id) の参照先（id は主キーなので常に一意）';
END
$$;

-- ── 複合外部キー（NOT VALID で追加してから VALIDATE。定義の一致する制約が既にあれば作らない） ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.cost_ledger_items'::regclass AND conname = 'cost_ledger_items_estimate_item_project_fkey') THEN
    ALTER TABLE public.cost_ledger_items ADD CONSTRAINT cost_ledger_items_estimate_item_project_fkey
      FOREIGN KEY (estimate_item_id, project_id) REFERENCES public.estimate_items (id, project_id)
      ON DELETE SET NULL (estimate_item_id) NOT VALID;
  END IF;
  ALTER TABLE public.cost_ledger_items VALIDATE CONSTRAINT cost_ledger_items_estimate_item_project_fkey;
  COMMENT ON CONSTRAINT cost_ledger_items_estimate_item_project_fkey ON public.cost_ledger_items IS
    '見積行は同じ案件の見積行であること（RLS は company_id しか見ないため DB で保証する。estimate_item_id が NULL の行は対象外。見積行の物理削除では estimate_item_id だけを NULL にする）';
END
$$;
-- <<< MIGRATION BODY

-- ── 2. 検証（ここで失敗すれば全体が取り消される） ──
DO $verify$
DECLARE
  v_text text;
BEGIN
  IF (SELECT count(*) FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  )) <> 2 THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: constraints missing or not validated';
  END IF;
  -- 定義（列の順・参照先・ON DELETE SET NULL の列）
  SELECT string_agg(format('%s|%s', conname, pg_get_constraintdef(oid)), ';' ORDER BY conname) INTO v_text
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  );
  IF v_text IS DISTINCT FROM
       'cost_ledger_items_estimate_item_project_fkey|FOREIGN KEY (estimate_item_id, project_id) REFERENCES estimate_items(id, project_id) ON DELETE SET NULL (estimate_item_id);'
    || 'estimate_items_id_project_id_key|UNIQUE (id, project_id)'
  THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: unexpected definitions (%)', v_text;
  END IF;
  -- 既存の制約（単独の外部キー・PR #35・PR-3・PR-4a を含む）は変わっていない。増えたのは上の 2 つだけ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s', conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)), ';'
                                   ORDER BY conrelid::regclass::text, conname)), '')
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname NOT IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  ) INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('lip1.constraints', true) THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: existing constraints changed';
  END IF;
  -- RLS ポリシー・テーブル権限・トリガー（P1-3 の actual_cost ロックなど）は適用前と同じ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public' INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('lip1.policies', true) THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: RLS policies changed';
  END IF;
  SELECT coalesce(md5(string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), ';'
                                   ORDER BY table_name, grantee, privilege_type)), '')
    FROM information_schema.role_table_grants WHERE table_schema = 'public' INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('lip1.grants', true) THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: table privileges changed';
  END IF;
  SELECT coalesce(md5(string_agg(format('%s|%s|%s', tgrelid::regclass, tgname, tgenabled), ';'
                                   ORDER BY tgrelid::regclass::text, tgname)), '')
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (to_regclass('public.cost_ledger_items'), to_regclass('public.estimate_items'))
    INTO v_text;
  IF v_text IS DISTINCT FROM current_setting('lip1.triggers', true) THEN
    RAISE EXCEPTION 'ledger-item-project-1 verify failed: triggers changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261016000001');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'enforce_ledger_estimate_item_project_match', '20261016000001';
  END IF;
END
$history$;

-- PostgREST に制約の変更を読み込ませる（通知はコミット時に送られる。取り消された場合は送られない）
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, valid_constraints = 2, prior_constraints = 21） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261016000001') AS history_rows,
  (SELECT count(*) FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
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
