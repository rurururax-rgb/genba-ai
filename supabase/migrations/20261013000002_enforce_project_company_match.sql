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
