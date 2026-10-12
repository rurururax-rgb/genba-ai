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
