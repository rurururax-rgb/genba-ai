-- ============================================================
-- KI-002 PR-3: 案件にぶら下がる 12 テーブルの「案件」と「会社」の一致を DB で保証する
--
-- 抜け道（20261013000002 で estimate_items / line_events だけ塞いだものと同じ形）:
--   各テーブルの RLS は行の company_id が自社かどうかしか見ない。project_id の外部キー確認は RLS を
--   通らないため、PostgREST（/rest/v1/...）や service_role（Webhook・cron・SQL）から
--   company_id = 自社・project_id = 他社の案件 という行を INSERT / UPDATE できる。
--   API 側の確認（KI-002 PR-1 / PR-2）は API を通る書き込みしか止められない。
--
-- 修正（最小限）:
--   20261013000002 で作った projects の UNIQUE (id, company_id) を参照先として再利用し（新しく作らない）、
--   各テーブルに複合外部キー (project_id, company_id) → projects (id, company_id) を足す。
--   ロール・経路にかかわらず、案件の会社と行の会社が違う行は 23503 で拒否される。
--
--   ON DELETE は既存の project_id の外部キーと同じにする（変えない）:
--     CASCADE  : project_files / project_notes / ai_summaries / estimate_documents / schedule_items /
--                share_links / cost_ledger_items / invoice_documents / project_billing_milestones /
--                estimate_groups / schedule_draft_adoptions
--     NO ACTION: line_event_notes
--   SET NULL は使わない（複合外部キーの SET NULL は company_id まで NULL にするため）。
--
--   MATCH SIMPLE（既定）は列のどれかが NULL なら一致を確かめない:
--     - project_id が NULL の行（未振り分けのメモ・案件なしの請求書・工種・工程案の採用記録）は従来どおり作れる。
--     - company_id が NULL を許すテーブルでは company_id = NULL・project_id = 他社の案件 が素通りするため、
--       CHECK (project_id IS NULL OR company_id IS NOT NULL) を足す（違反は 23514）:
--         cost_ledger_items / invoice_documents / project_billing_milestones / estimate_groups /
--         schedule_draft_adoptions
--     - それ以外の 7 テーブルは company_id が NOT NULL のため CHECK は不要。NOT NULL であることを事前確認し、
--       NULL を許していれば止まる（本番の定義がリポジトリと違う場合に気づくため）。
--
--   既存の単独の外部キー・RLS ポリシー・テーブル権限・列・トリガー・関数は変えない。
--   estimate_revisions / cost_ledger_invoices は本番の定義をリポジトリで確かめられないため対象外。
--
-- 安全方針:
--   - 既存データの UPDATE / DELETE / TRUNCATE なし。食い違いの自動補正もしない。
--   - 次のどれかに当てはまれば、何も作らずに止まる（1 つのメッセージに全テーブル分をまとめて出す）:
--       参照先の一意制約 (id, company_id) が無い（20261013000002 が未適用）／テーブル・列が無い・型が uuid でない／
--       CHECK を付けないテーブルの company_id が NULL を許す／既存の project_id の外部キーが無い・ON DELETE が想定と違う／
--       同じ名前の制約が想定と違う定義で既にある／
--       会社が食い違う行・参照先の案件が無い行・案件に紐付いているのに company_id が NULL の行が 1 件でもある
--   - 制約は NOT VALID で追加してから VALIDATE する（同じトランザクション内。途中で失敗すれば何も残らない）
--   - 再適用できる（定義が一致する制約が既にあれば作らない。増えない）
--   - ロック待ちは lock_timeout で打ち切る（取り消して時間をおいて再実行する）
--
-- 影響:
--   - これらのテーブルに行がある案件では、projects.company_id を変更できなくなる（アプリに変更する経路は無い）
-- ============================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 事前確認 ──
DO $$
DECLARE
  -- 対象テーブル: (テーブル, 既存の project_id 外部キーの ON DELETE（c = CASCADE / a = NO ACTION）, CHECK を付けるか)
  t          record;
  problems   text[] := '{}';
  v_type     text;
  v_nullable text;
  v_dels     text[];
  v_mismatch bigint;
  v_orphan   bigint;
  v_nullco   bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.projects'::regclass AND c.contype IN ('u', 'p')
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n)
          = ARRAY['company_id', 'id']
  ) THEN
    RAISE EXCEPTION 'project-company-2 precondition failed: projects has no UNIQUE (id, company_id) (apply 20261013000002 first)';
  END IF;

  FOR t IN
    SELECT * FROM (VALUES
      ('project_files',              'c', false),
      ('project_notes',              'c', false),
      ('ai_summaries',               'c', false),
      ('estimate_documents',         'c', false),
      ('schedule_items',             'c', false),
      ('share_links',                'c', false),
      ('cost_ledger_items',          'c', true),
      ('invoice_documents',          'c', true),
      ('project_billing_milestones', 'c', true),
      ('estimate_groups',            'c', true),
      ('line_event_notes',           'a', false),
      ('schedule_draft_adoptions',   'c', true)
    ) AS v(tbl, del, needs_check)
    ORDER BY tbl
  LOOP
    IF to_regclass(format('public.%I', t.tbl)) IS NULL THEN
      problems := problems || format('%s: table missing', t.tbl);
      CONTINUE;
    END IF;

    -- 列と型
    SELECT string_agg(format('%s=%s', c.column_name, c.data_type), ',' ORDER BY c.column_name) INTO v_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name IN ('project_id', 'company_id');
    IF v_type IS DISTINCT FROM 'company_id=uuid,project_id=uuid' THEN
      problems := problems || format('%s: unexpected columns (%s)', t.tbl, coalesce(v_type, 'none'));
      CONTINUE;
    END IF;

    -- CHECK を付けないテーブルは company_id が NOT NULL であること
    IF NOT t.needs_check THEN
      SELECT c.is_nullable INTO v_nullable FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'company_id';
      IF v_nullable <> 'NO' THEN
        problems := problems || format('%s: company_id is nullable', t.tbl);
      END IF;
    END IF;

    -- 既存の project_id → projects(id) の外部キーと、その ON DELETE
    SELECT array_agg(DISTINCT c.confdeltype::text) INTO v_dels
    FROM pg_constraint c
    WHERE c.conrelid = format('public.%I', t.tbl)::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.projects'::regclass
      AND (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k(n)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['project_id'];
    IF v_dels IS DISTINCT FROM ARRAY[t.del] THEN
      problems := problems || format('%s: existing project_id fkey on delete is %s (expected %s)', t.tbl, coalesce(v_dels::text, 'missing'), t.del);
    END IF;

    -- 同じ名前の制約が既にあるなら、定義が想定どおりであること（名前だけで判断しない）
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = format('public.%I', t.tbl)::regclass AND c.conname = t.tbl || '_project_company_fkey'
        AND NOT (
          c.contype = 'f' AND c.confrelid = 'public.projects'::regclass
          AND c.confdeltype = t.del AND c.confupdtype = 'a' AND c.confmatchtype = 's'
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) = ARRAY['project_id', 'company_id']
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) = ARRAY['id', 'company_id']
        )
    ) THEN
      problems := problems || format('%s: constraint %s exists with a different definition', t.tbl, t.tbl || '_project_company_fkey');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = format('public.%I', t.tbl)::regclass AND c.conname = t.tbl || '_project_requires_company_check'
        AND NOT (
          t.needs_check AND c.contype = 'c'
          AND regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', '')
              = 'CHECK (((project_id IS NULL) OR (company_id IS NOT NULL)))'
        )
    ) THEN
      problems := problems || format('%s: constraint %s exists with a different definition', t.tbl, t.tbl || '_project_requires_company_check');
    END IF;

    -- 既存データ（会社の食い違い・参照先の案件が無い・案件に紐付いているのに会社 ID が NULL）
    EXECUTE format(
      'SELECT count(*) FILTER (WHERE x.project_id IS NOT NULL AND x.company_id IS NOT NULL AND p.id IS NOT NULL
                                 AND p.company_id IS DISTINCT FROM x.company_id),
              count(*) FILTER (WHERE x.project_id IS NOT NULL AND p.id IS NULL),
              count(*) FILTER (WHERE x.project_id IS NOT NULL AND x.company_id IS NULL)
       FROM public.%I x LEFT JOIN public.projects p ON p.id = x.project_id', t.tbl)
      INTO v_mismatch, v_orphan, v_nullco;
    IF v_mismatch > 0 OR v_orphan > 0 OR v_nullco > 0 THEN
      problems := problems || format('%s: mismatched=%s orphan=%s null_company=%s', t.tbl, v_mismatch, v_orphan, v_nullco);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'project-company-2 precondition failed: %', array_to_string(problems, '; ');
  END IF;
END
$$;

-- ── 複合外部キー・CHECK（NOT VALID で追加してから VALIDATE。定義の一致する制約が既にあれば作らない） ──
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('ai_summaries',               'CASCADE',   false),
      ('cost_ledger_items',          'CASCADE',   true),
      ('estimate_documents',         'CASCADE',   false),
      ('estimate_groups',            'CASCADE',   true),
      ('invoice_documents',          'CASCADE',   true),
      ('line_event_notes',           'NO ACTION', false),
      ('project_billing_milestones', 'CASCADE',   true),
      ('project_files',              'CASCADE',   false),
      ('project_notes',              'CASCADE',   false),
      ('schedule_draft_adoptions',   'CASCADE',   true),
      ('schedule_items',             'CASCADE',   false),
      ('share_links',                'CASCADE',   false)
    ) AS v(tbl, on_delete, needs_check)
    ORDER BY tbl
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = format('public.%I', t.tbl)::regclass AND conname = t.tbl || '_project_company_fkey') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (project_id, company_id)
           REFERENCES public.projects (id, company_id) ON DELETE %s NOT VALID',
        t.tbl, t.tbl || '_project_company_fkey', t.on_delete);
    END IF;
    IF t.needs_check AND NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = format('public.%I', t.tbl)::regclass AND conname = t.tbl || '_project_requires_company_check') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (project_id IS NULL OR company_id IS NOT NULL) NOT VALID',
        t.tbl, t.tbl || '_project_requires_company_check');
    END IF;

    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t.tbl, t.tbl || '_project_company_fkey');
    EXECUTE format('COMMENT ON CONSTRAINT %I ON public.%I IS %L',
      t.tbl || '_project_company_fkey', t.tbl,
      '案件は同じ会社の案件であること（RLS は company_id しか見ないため DB で保証する。project_id が NULL の行は対象外）');
    IF t.needs_check THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t.tbl, t.tbl || '_project_requires_company_check');
      EXECUTE format('COMMENT ON CONSTRAINT %I ON public.%I IS %L',
        t.tbl || '_project_requires_company_check', t.tbl,
        '案件に紐付いた行は company_id 必須（複合外部キーは company_id が NULL だと一致を確かめないため）');
    END IF;
  END LOOP;
END
$$;
