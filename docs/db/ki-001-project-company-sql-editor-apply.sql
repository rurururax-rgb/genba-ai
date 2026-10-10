-- =====================================================================
-- KI-001 追加監査: 案件と会社の一致の本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・前提: 20261013000001（KI-001 の RPC）を先に適用していること（順序の依存は無いが、手順書の順に行う）。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、制約・migration 履歴の
--   どれも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・行うのは projects の UNIQUE (id, company_id) と、estimate_items / line_events の
--   複合外部キー (project_id, company_id)、line_events の CHECK (project_id IS NULL OR company_id IS NOT NULL)
--   の追加だけ。RLS ポリシー・権限・列は変えない。業務データの INSERT / UPDATE / DELETE も行わない。
--   食い違っている行・案件に紐付いているのに会社 ID が NULL の行が 1 件でもあれば止まる。
-- ・制約の追加中は projects / estimate_items / line_events の書き込みが待たされる
--   （行数が少ないため数秒以内。ロック待ちは lock_timeout = 5s で打ち切って全体を取り消す）。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261013000002_enforce_project_company_match.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/ki-001-link-line-event-on-estimate-add.md の「追加監査」の節
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'project-company apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261013000002') THEN
    RAISE EXCEPTION 'project-company apply aborted: version 20261013000002 is already recorded';
  END IF;
  -- 履歴なしで制約だけある（想定外の状態）なら触らない
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check')) THEN
    RAISE EXCEPTION 'project-company apply aborted: constraints already exist (history is missing)';
  END IF;
  -- 適用後に RLS ポリシーが変わっていないことを確かめるため、適用前の状態を記録する
  PERFORM set_config('pcm.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies WHERE schemaname = 'public'
  ), true);
END
$guard$;

-- ── 1. migration 本体（事前確認・一意制約・複合外部キー） ──
-- >>> MIGRATION BODY
-- ============================================================
-- KI-001 追加監査: 見積項目・LINE イベントの「案件」と「会社」の一致を DB で保証する
--
-- 抜け道:
--   estimate_items / line_events の RLS は行の company_id が自社かどうかしか見ない。
--   project_id の外部キー確認は RLS を通らないため、ログイン済みユーザーは PostgREST
--   （/rest/v1/estimate_items・/rest/v1/line_events）や会社を確かめない API から、
--   company_id = 自社・project_id = 他社の案件 という行を INSERT / UPDATE できた。
--   （RPC add_line_event_estimate_items は関数内で確かめているが、直接の書き込みは止められない）
--
-- 修正（最小限）:
--   projects に UNIQUE (id, company_id) を足し、子テーブルに複合外部キー
--   (project_id, company_id) → projects (id, company_id) を足す。
--   ロール（authenticated / service_role）や経路（PostgREST・API・RPC・SQL）にかかわらず、
--   案件の会社と行の会社が違う行は 23503 で拒否される。
--     - estimate_items: ON DELETE CASCADE（既存の project_id の外部キーと同じ）
--     - line_events   : ON DELETE NO ACTION（既存と同じ）。project_id が NULL（未振り分け）の行は対象外（MATCH SIMPLE）
--   MATCH SIMPLE は列のどれかが NULL なら一致を確かめない。line_events.company_id は NULL を許すため、
--   company_id = NULL・project_id = 他社の案件 は複合外部キーを素通りする。これを CHECK で塞ぐ:
--     - line_events: CHECK (project_id IS NULL OR company_id IS NOT NULL)
--       案件に紐付いたイベントは会社 ID が必須。未振り分け（project_id = NULL）は会社 ID が NULL でもよい
--       （LINE_COMPANY_ID 未設定の Webhook が作る行を壊さない）
--     - estimate_items: project_id・company_id とも NOT NULL のため CHECK は不要。NOT NULL であることを事前確認する
--   既存の単独の外部キー・RLS ポリシー・テーブル権限・列は変えない。
--
-- 安全方針:
--   - 既存データの UPDATE / DELETE / TRUNCATE なし
--   - 既に会社が食い違っている行、案件に紐付いているのに会社 ID が NULL の行が 1 件でもあれば、
--     何も作らずに止まる（補正は人間が判断する）
--   - 制約は NOT VALID で追加してから VALIDATE する（同じトランザクション内）
--   - 再適用できる（制約が既にあれば作らない）
--
-- 影響:
--   - projects.company_id の変更は、見積項目・紐付け済みイベントがある案件では拒否される
--     （アプリに案件の会社を変える経路は無い）
-- ============================================================

-- ── 事前確認：前提の列と、食い違っている既存行 ──
DO $$
DECLARE
  missing   text[];
  nullable  text[];
  v_items   bigint;
  v_events  bigint;
BEGIN
  SELECT array_agg(format('%s.%s', r.tbl, r.col) ORDER BY r.tbl, r.col) INTO missing
  FROM (VALUES
    ('projects', 'id'), ('projects', 'company_id'),
    ('estimate_items', 'project_id'), ('estimate_items', 'company_id'),
    ('line_events', 'project_id'), ('line_events', 'company_id')
  ) AS r(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'project-company precondition failed: missing columns %', missing;
  END IF;

  -- estimate_items は NOT NULL を前提に CHECK を付けない。NULL を許していれば止まる
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'estimate_items'
    AND c.column_name IN ('project_id', 'company_id') AND c.is_nullable = 'YES';
  IF nullable IS NOT NULL THEN
    RAISE EXCEPTION 'project-company precondition failed: estimate_items columns are nullable %', nullable;
  END IF;

  SELECT count(*) INTO v_items
  FROM public.estimate_items i JOIN public.projects p ON p.id = i.project_id
  WHERE i.company_id IS DISTINCT FROM p.company_id AND i.company_id IS NOT NULL;
  SELECT count(*) INTO v_events
  FROM public.line_events e JOIN public.projects p ON p.id = e.project_id
  WHERE e.company_id IS DISTINCT FROM p.company_id AND e.company_id IS NOT NULL;
  IF v_items > 0 OR v_events > 0 THEN
    RAISE EXCEPTION 'project-company precondition failed: mismatched rows (estimate_items=%, line_events=%)', v_items, v_events;
  END IF;

  SELECT count(*) INTO v_events
  FROM public.line_events e
  WHERE e.project_id IS NOT NULL AND e.company_id IS NULL;
  IF v_events > 0 THEN
    RAISE EXCEPTION 'project-company precondition failed: linked line_events without company_id (%)', v_events;
  END IF;
END
$$;

-- ── 1. 参照先：projects (id, company_id) の一意制約（id が主キーなので常に一意） ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.projects'::regclass AND conname = 'projects_id_company_id_key') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_id_company_id_key UNIQUE (id, company_id);
  END IF;
END
$$;

-- ── 2. 複合外部キー ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.estimate_items'::regclass AND conname = 'estimate_items_project_company_fkey') THEN
    ALTER TABLE public.estimate_items
      ADD CONSTRAINT estimate_items_project_company_fkey
      FOREIGN KEY (project_id, company_id) REFERENCES public.projects (id, company_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.line_events'::regclass AND conname = 'line_events_project_company_fkey') THEN
    ALTER TABLE public.line_events
      ADD CONSTRAINT line_events_project_company_fkey
      FOREIGN KEY (project_id, company_id) REFERENCES public.projects (id, company_id)
      NOT VALID;
  END IF;
END
$$;

-- ── 3. 案件に紐付いた LINE イベントは会社 ID 必須（複合外部キーの NULL の抜け道を塞ぐ） ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.line_events'::regclass AND conname = 'line_events_project_requires_company_check') THEN
    ALTER TABLE public.line_events
      ADD CONSTRAINT line_events_project_requires_company_check
      CHECK (project_id IS NULL OR company_id IS NOT NULL) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.estimate_items VALIDATE CONSTRAINT estimate_items_project_company_fkey;
ALTER TABLE public.line_events    VALIDATE CONSTRAINT line_events_project_company_fkey;
ALTER TABLE public.line_events    VALIDATE CONSTRAINT line_events_project_requires_company_check;

COMMENT ON CONSTRAINT estimate_items_project_company_fkey ON public.estimate_items IS
  '見積項目の案件は同じ会社の案件であること（RLS は company_id しか見ないため DB で保証する）';
COMMENT ON CONSTRAINT line_events_project_company_fkey ON public.line_events IS
  'LINE イベントの紐付け先は同じ会社の案件であること（未振り分け = project_id NULL は対象外）';
COMMENT ON CONSTRAINT line_events_project_requires_company_check ON public.line_events IS
  '案件に紐付いた LINE イベントは company_id 必須（複合外部キーは company_id が NULL だと一致を確かめないため）';
-- <<< MIGRATION BODY

-- ── 2. 適用後の検証（どれかが外れればトランザクション全体を取り消す） ──
DO $verify$
DECLARE
  v_policies text;
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check') AND convalidated) <> 4 THEN
    RAISE EXCEPTION 'project-company verify failed: constraints missing or not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'estimate_items_project_company_fkey' AND conrelid = 'public.estimate_items'::regclass
                   AND confrelid = 'public.projects'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'project-company verify failed: estimate_items fkey must be ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'line_events_project_company_fkey' AND conrelid = 'public.line_events'::regclass
                   AND confrelid = 'public.projects'::regclass AND confdeltype = 'a') THEN
    RAISE EXCEPTION 'project-company verify failed: line_events fkey must be ON DELETE NO ACTION';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'line_events_project_requires_company_check' AND conrelid = 'public.line_events'::regclass
                   AND contype = 'c'
                   AND pg_get_constraintdef(oid) = 'CHECK (((project_id IS NULL) OR (company_id IS NOT NULL)))') THEN
    RAISE EXCEPTION 'project-company verify failed: unexpected line_events check constraint';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'estimate_items'
               AND column_name IN ('project_id', 'company_id') AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'project-company verify failed: estimate_items project_id / company_id must be NOT NULL';
  END IF;
  -- RLS ポリシーは適用前と同じ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    INTO v_policies
  FROM pg_policies WHERE schemaname = 'public';
  IF v_policies IS DISTINCT FROM current_setting('pcm.policies', true) THEN
    RAISE EXCEPTION 'project-company verify failed: RLS policies changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261013000002');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'enforce_project_company_match', '20261013000002';
  END IF;
END
$history$;

-- PostgREST に制約の変更を読み込ませる（通知はコミット時に送られる。取り消された場合は送られない）
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, valid_constraints = 4） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261013000002') AS history_rows,
  (SELECT count(*) FROM pg_constraint WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check') AND convalidated) AS valid_constraints;
