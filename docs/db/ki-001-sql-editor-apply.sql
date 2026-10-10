-- =====================================================================
-- KI-001 本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、関数の追加・権限・
--   migration 履歴のどれも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・migration 履歴（supabase_migrations.schema_migrations）への登録は、追加と検証がすべて成功した場合だけ、
--   同じトランザクションの最後で行う。
-- ・行うのは関数 public.add_line_event_estimate_items の追加と EXECUTE 権限の設定だけ。
--   テーブル・列・RLS ポリシーは変えない。業務データ（line_events / estimate_items）の
--   INSERT / UPDATE / DELETE も行わない（過去に未振り分けのまま反映された行の補正もしない）。
-- ・関数の追加はテーブルロックを取らない（実行中の画面操作を止めない）。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261013000001_link_line_event_on_estimate_add.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/ki-001-link-line-event-on-estimate-add.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'KI-001 apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION 'KI-001 apply aborted: schema_migrations.version not found';
  END IF;
  -- 二重適用・二重登録の防止
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261013000001') THEN
    RAISE EXCEPTION 'KI-001 apply aborted: version 20261013000001 is already recorded';
  END IF;
  -- 履歴なしで関数だけ作られている（想定外の状態）なら上書きしない
  IF to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'KI-001 apply aborted: function already exists (history is missing)';
  END IF;
  -- 適用後に RLS ポリシーが変わっていないことを確かめるため、適用前の状態を記録する
  PERFORM set_config('ki001.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                   ORDER BY tablename, policyname)), '')
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('line_events', 'estimate_items', 'projects')
  ), true);
END
$guard$;

-- ── 1. migration 本体（前提の列の確認・関数の追加・権限） ──
-- >>> MIGRATION BODY
-- ============================================================
-- KI-001: LINE イベントから「見積に追加」したとき、見積項目の追加と
-- line_events.project_id の紐付けを 1 つのトランザクションで行う RPC
--
-- 目的:
--   現行 API（app/api/estimate-items/route.ts）は estimate_items の INSERT と
--   line_events の更新を別々のリクエストで行い、line_events.project_id は更新していなかった。
--   そのため未振り分け（project_id = NULL）のイベントを見積に追加しても NULL のまま残り、
--   「どの案件の現調か」を追跡できなかった。
--   また project_id をリクエストからそのまま受け取り、会社の一致を確かめていなかった。
--
-- 追加する関数（SECURITY INVOKER = 呼び出したユーザーの権限と RLS で動く）:
--   public.add_line_event_estimate_items(p_project_id, p_line_event_id, p_items)
--     1. LINE イベントを SELECT ... FOR UPDATE でロック（自社のものだけ）
--     2. 案件を確認（自社・未削除）。イベントと案件の会社が同じであること
--     3. イベントが別の案件に紐付け済みなら拒否（既存の紐付けは上書きしない）
--     4. 反映済み（reflected_to_estimate = true）なら拒否（重複実行の防止）
--     5. estimate_items を INSERT
--     6. line_events を更新：project_id が NULL のときだけ案件 ID を入れ、reflected_to_estimate = true
--   どこかで失敗すればトランザクションごと取り消され、見積項目だけ追加された状態は残らない。
--
-- 同時実行:
--   同じイベントへの操作はイベント行のロックで直列化される。後から来た操作は、先の操作が
--   コミットした後の状態（反映済み・紐付け済み）を見て拒否される。
--   ロック待ちは lock_timeout = 5s で打ち切る（エラー 55P03。何も変わらない）。
--
-- 安全方針:
--   - テーブル・列・制約・インデックス・RLS ポリシーは作成も変更もしない（関数の追加のみ）
--   - 既存データの UPDATE / DELETE / TRUNCATE なし（過去に未振り分けのまま反映された行の補正もしない）
--   - 前提の列が無い DB では、何も作らずにエラーで止まる（下の事前確認）
--   - EXECUTE は authenticated のみ。anon / service_role / PUBLIC からは実行できない
--   - search_path は空に固定し、すべて schema 修飾で参照する
--   - 想定内のエラーは独自の SQLSTATE（LE4xx）と短い英字の識別子だけを返す
--
-- エラーコード:
--   LE401 unauthenticated          … auth.uid() が無い
--   LE400 invalid_input            … 入力値が不正
--   LE404 not_found                … イベント・案件が無い・他社・削除済み（区別して漏らさない）
--   LE403 company_mismatch         … イベントと案件の会社が違う（複数社に所属するユーザー）
--   LE409 linked_to_other_project  … イベントが別の案件に紐付け済み
--   LE409 already_reflected        … イベントは見積に反映済み（取り消してから追加し直す）
--   55P03 lock_not_available       … 同じイベントのロック待ちが 5 秒を超えた
-- ============================================================

-- ── 事前確認：前提の列が揃っていなければ何も作らずに止める ──
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(format('%s.%s', r.tbl, r.col) ORDER BY r.tbl, r.col) INTO missing
  FROM (VALUES
    ('line_events', 'id'),
    ('line_events', 'company_id'),
    ('line_events', 'project_id'),
    ('line_events', 'reflected_to_estimate'),
    ('projects', 'id'),
    ('projects', 'company_id'),
    ('projects', 'deleted_at'),
    ('estimate_items', 'project_id'),
    ('estimate_items', 'company_id'),
    ('estimate_items', 'line_event_id'),
    ('estimate_items', 'name'),
    ('estimate_items', 'unit'),
    ('estimate_items', 'selling_price'),
    ('estimate_items', 'category'),
    ('estimate_items', 'quantity'),
    ('estimate_items', 'memo'),
    ('estimate_items', 'source'),
    ('estimate_items', 'sort_order')
  ) AS r(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'KI-001 precondition failed: missing columns %', missing;
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'KI-001 precondition failed: auth.uid() not found';
  END IF;
  IF to_regprocedure('public.get_my_company_ids()') IS NULL THEN
    RAISE EXCEPTION 'KI-001 precondition failed: public.get_my_company_ids() not found';
  END IF;
END
$$;

-- ============================================================
-- 見積に追加 + 未振り分けイベントの紐付け
-- ============================================================
--
-- p_items: [{ name, unit, selling_price?, category?, quantity?, memo? }, ...]（1〜100 件）
--   現行 API と同じく source = 'past_item'、sort_order = 配列の順番（0 始まり）、
--   quantity が無ければ 1。company_id はリクエストから受け取らず、案件の会社を入れる。

CREATE OR REPLACE FUNCTION public.add_line_event_estimate_items(
  p_project_id    uuid,
  p_line_event_id uuid,
  p_items         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_event_company   uuid;
  v_event_project   uuid;
  v_event_reflected boolean;
  v_project_company uuid;
  v_item            jsonb;
  v_created         int;
  v_rows            int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'LE401', MESSAGE = 'unauthenticated';
  END IF;

  -- ── 入力の検証 ──
  IF p_project_id IS NULL OR p_line_event_id IS NULL
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'LE400', MESSAGE = 'invalid_input';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR jsonb_typeof(v_item -> 'name') IS DISTINCT FROM 'string'
       OR btrim(v_item ->> 'name') = '' OR length(v_item ->> 'name') > 500
       OR jsonb_typeof(v_item -> 'unit') IS DISTINCT FROM 'string'
       OR btrim(v_item ->> 'unit') = '' OR length(v_item ->> 'unit') > 50
       OR coalesce(jsonb_typeof(v_item -> 'selling_price'), 'null') NOT IN ('number', 'null')
       OR abs((v_item ->> 'selling_price')::numeric) >= 1000000000000
       OR coalesce(jsonb_typeof(v_item -> 'quantity'), 'null') NOT IN ('number', 'null')
       OR (v_item ->> 'quantity')::numeric < 0 OR (v_item ->> 'quantity')::numeric >= 1000000000
       OR coalesce(jsonb_typeof(v_item -> 'category'), 'null') NOT IN ('string', 'null')
       OR length(v_item ->> 'category') > 100
       OR coalesce(jsonb_typeof(v_item -> 'memo'), 'null') NOT IN ('string', 'null')
       OR length(v_item ->> 'memo') > 2000 THEN
      RAISE EXCEPTION USING ERRCODE = 'LE400', MESSAGE = 'invalid_input';
    END IF;
  END LOOP;

  -- ── LINE イベントをロック（自社のものだけ。他社・存在しないは区別しない）──
  SELECT e.company_id, e.project_id, e.reflected_to_estimate
    INTO v_event_company, v_event_project, v_event_reflected
  FROM public.line_events e
  WHERE e.id = p_line_event_id
    AND e.company_id IN (SELECT public.get_my_company_ids())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'LE404', MESSAGE = 'not_found';
  END IF;

  -- ── 案件（自社・未削除）──
  SELECT p.company_id INTO v_project_company
  FROM public.projects p
  WHERE p.id = p_project_id
    AND p.deleted_at IS NULL
    AND p.company_id IN (SELECT public.get_my_company_ids());
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'LE404', MESSAGE = 'not_found';
  END IF;

  IF v_event_company IS DISTINCT FROM v_project_company THEN
    RAISE EXCEPTION USING ERRCODE = 'LE403', MESSAGE = 'company_mismatch';
  END IF;
  IF v_event_project IS NOT NULL AND v_event_project <> p_project_id THEN
    RAISE EXCEPTION USING ERRCODE = 'LE409', MESSAGE = 'linked_to_other_project';
  END IF;
  IF v_event_reflected THEN
    RAISE EXCEPTION USING ERRCODE = 'LE409', MESSAGE = 'already_reflected';
  END IF;

  -- ── 見積項目の追加（amount は GENERATED 列なので入れない）──
  INSERT INTO public.estimate_items
    (project_id, company_id, line_event_id, name, unit, selling_price, category, quantity, memo, source, sort_order)
  SELECT
    p_project_id, v_project_company, p_line_event_id,
    x.value ->> 'name',
    x.value ->> 'unit',
    (x.value ->> 'selling_price')::numeric,
    x.value ->> 'category',
    coalesce((x.value ->> 'quantity')::numeric, 1),
    x.value ->> 'memo',
    'past_item',
    (x.ordinality - 1)::int
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(value, ordinality);
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- ── 未振り分けなら案件に紐付け（紐付け済みは同じ案件なので変わらない）──
  UPDATE public.line_events e
     SET project_id            = coalesce(e.project_id, p_project_id),
         reflected_to_estimate = true
   WHERE e.id = p_line_event_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- RLS で更新できなかった（通常は起きない）。INSERT ごと取り消す
    RAISE EXCEPTION USING ERRCODE = 'LE409', MESSAGE = 'event_not_updated';
  END IF;

  RETURN jsonb_build_object(
    'created',       v_created,
    'project_id',    p_project_id,
    'line_event_id', p_line_event_id,
    'linked',        v_event_project IS NULL
  );
END
$$;

REVOKE ALL ON FUNCTION public.add_line_event_estimate_items(uuid, uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.add_line_event_estimate_items(uuid, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.add_line_event_estimate_items(uuid, uuid, jsonb) IS
  'KI-001: LINE イベントの候補を見積に追加し、未振り分けなら同じトランザクションで案件に紐付ける。紐付け済みの別案件・反映済みは拒否。';
-- <<< MIGRATION BODY

-- ── 2. 適用後の検証（どれかが外れればトランザクション全体を取り消す） ──
DO $verify$
DECLARE
  v_fn regprocedure := to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)');
  v_policies text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'KI-001 verify failed: function not found';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'KI-001 verify failed: function must be SECURITY INVOKER';
  END IF;
  IF NOT (SELECT proconfig @> ARRAY['search_path=""', 'lock_timeout=5s'] FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'KI-001 verify failed: unexpected function settings %', (SELECT proconfig FROM pg_proc WHERE oid = v_fn);
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'KI-001 verify failed: authenticated cannot execute';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'KI-001 verify failed: anon or service_role can execute';
  END IF;
  -- PUBLIC への EXECUTE が残っていない（ACL に「=X/」が無い）
  IF EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = v_fn AND a::text LIKE '=%') THEN
    RAISE EXCEPTION 'KI-001 verify failed: PUBLIC can execute';
  END IF;
  -- RLS ポリシーは適用前と同じ
  SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), ';'
                                 ORDER BY tablename, policyname)), '')
    INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('line_events', 'estimate_items', 'projects');
  IF v_policies IS DISTINCT FROM current_setting('ki001.policies', true) THEN
    RAISE EXCEPTION 'KI-001 verify failed: RLS policies changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
-- version 列だけを必須とし、name 列は存在する場合だけ埋める（列の有無を推測しない）。
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261013000001');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'link_line_event_on_estimate_add', '20261013000001';
  END IF;
END
$history$;

-- PostgREST に新しい関数を読み込ませる（通知はコミット時に送られる。取り消された場合は送られない）
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, function_exists = true, security_invoker = true） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261013000001') AS history_rows,
  to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NOT NULL AS function_exists,
  coalesce((SELECT NOT prosecdef FROM pg_proc
            WHERE oid = to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)')), false) AS security_invoker;
