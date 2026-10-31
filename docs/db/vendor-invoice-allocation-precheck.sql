-- =====================================================================
-- 業者請求書の複数項目への振り分け（vendor_invoice_documents）PR 0: 設計前の読み取り専用確認
--
-- ・Supabase SQL Editor で全文を 1 回実行する。SELECT 1 文だけ（SQL Editor は最後の文の結果だけを表示するため）。
--   書き込み・DDL・関数の作成は一切しない。念のため BEGIN READ ONLY; … ROLLBACK; で囲んでもよい。
-- ・業務データの中身（品名・業者名・請求書番号・メモ）は出さない。件数・合計額・カタログの定義だけを出す。
-- ・本番への接続・実行は、人間が承認してから人間が行う。結果の表（section / item / value / expected）をそのまま報告する。
-- ・読み方は docs/design/vendor-invoice-allocation.md の「PR 0 の読み方」。
--   expected が「記録」の行は判定しない（設計に使う情報）。ok = false の行があれば設計の前提を見直す。
-- =====================================================================
WITH
inv AS (
  SELECT i.id, i.amount, i.source, i.project_id AS inv_project, i.document_sha256, i.invoice_number, i.vendor_name,
         ci.id AS item_id, ci.project_id AS item_project, ci.company_id AS item_company, ci.deleted_at AS item_deleted,
         p.company_id AS project_company
  FROM public.cost_ledger_invoices i
  LEFT JOIN public.cost_ledger_items ci ON ci.id = i.cost_ledger_item_id
  LEFT JOIN public.projects p ON p.id = ci.project_id
),
items AS (
  SELECT ci.*, ei.id AS est_id, ei.deleted_at AS est_deleted,
         EXISTS (SELECT 1 FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = ci.id) AS has_invoices
  FROM public.cost_ledger_items ci
  LEFT JOIN public.estimate_items ei ON ei.id = ci.estimate_item_id
),
rows(section, sort, item, value, expected, ok) AS (
  -- ── A. 環境 ──────────────────────────────────────────────
  SELECT 'A 環境', 10, 'PostgreSQL', current_setting('server_version'), '記録', true
  UNION ALL
  SELECT 'A 環境', 11, 'migration ' || v.version,
         (EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version))::text,
         v.expected, (EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version))::text = v.expected
  FROM (VALUES ('20261010000001', 'true'), ('20261010000002', 'true'), ('20261011000001', 'true'), ('20261012000001', 'true'),
               ('20261014000001', 'true'), ('20261015000001', 'true')) v(version, expected)
  UNION ALL
  SELECT 'A 環境', 12, 'migration 20261016000001（PR-4b）',
         (EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = '20261016000001'))::text, '記録', true
  UNION ALL
  -- 新設予定の名前が空いていること
  SELECT 'A 環境', 13, '名前の空き: ' || n.name,
         coalesce((SELECT c.relkind::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = n.name),
                  (SELECT 'function' FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n.name LIMIT 1),
                  '(なし)'),
         '(なし)',
         NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = n.name)
         AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n.name)
  FROM (VALUES ('vendor_invoice_documents'), ('vendor_invoice_register'), ('vendor_invoice_delete'),
               ('cost_ledger_items_guard_soft_delete')) n(name)
  UNION ALL
  SELECT 'A 環境', 14, '列の空き: cost_ledger_invoices.' || n.col,
         (EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
                    AND c.table_name = 'cost_ledger_invoices' AND c.column_name = n.col))::text,
         'false',
         NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
                       AND c.table_name = 'cost_ledger_invoices' AND c.column_name = n.col)
  FROM (VALUES ('document_id'), ('document_line_no')) n(col)

  -- ── B. cost_ledger_invoices の本番定義（リポジトリに CREATE TABLE が無い。カタログだけを読む） ──
  UNION ALL
  SELECT 'B 請求書表の定義', 20, 'column ' || lpad(c.ordinal_position::text, 2, '0') || ' ' || c.column_name,
         c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
           || coalesce(' DEFAULT ' || c.column_default, ''),
         '記録', true
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'cost_ledger_invoices'
  UNION ALL
  SELECT 'B 請求書表の定義', 21, 'constraint ' || con.conname, pg_get_constraintdef(con.oid), '記録', true
  FROM pg_constraint con WHERE con.conrelid = 'public.cost_ledger_invoices'::regclass
  UNION ALL
  SELECT 'B 請求書表の定義', 22, 'index ' || i.indexname, i.indexdef, '記録', true
  FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'cost_ledger_invoices'
  UNION ALL
  SELECT 'B 請求書表の定義', 23, 'trigger ' || t.tgname, pg_get_triggerdef(t.oid), '記録', true
  FROM pg_trigger t WHERE t.tgrelid = 'public.cost_ledger_invoices'::regclass AND NOT t.tgisinternal
  UNION ALL
  SELECT 'B 請求書表の定義', 24, 'policy ' || p.policyname,
         format('[%s] roles=%s USING (%s) WITH CHECK (%s)', p.cmd, p.roles::text, p.qual, p.with_check), '記録', true
  FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cost_ledger_invoices'
  UNION ALL
  SELECT 'B 請求書表の定義', 25, 'RLS 有効', (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.cost_ledger_invoices'::regclass),
         'true', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cost_ledger_invoices'::regclass)
  UNION ALL
  -- P1-4: 書き込みは RPC だけ（anon・authenticated に INSERT/UPDATE/DELETE が無い）
  SELECT 'B 請求書表の定義', 26, 'table ' || r.priv || ' ' || r.role,
         has_table_privilege(r.role, 'public.cost_ledger_invoices', r.priv)::text, 'false',
         NOT has_table_privilege(r.role, 'public.cost_ledger_invoices', r.priv)
  FROM (SELECT role, priv FROM unnest(ARRAY['anon', 'authenticated']) role,
                               unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv) r
  UNION ALL
  -- cost_ledger_invoices を参照する外部キー（新しい表から参照するときの前提）
  SELECT 'B 請求書表の定義', 27, 'referenced by ' || con.conrelid::regclass::text || '.' || con.conname,
         pg_get_constraintdef(con.oid), '記録', true
  FROM pg_constraint con WHERE con.confrelid = 'public.cost_ledger_invoices'::regclass

  -- ── C. RPC・トリガー（P1-2〜P1-4） ──────────────────────
  UNION ALL
  SELECT 'C RPC', 30, f.sig,
         CASE WHEN p.oid IS NULL THEN 'missing'
              ELSE 'secdef=' || p.prosecdef || ' config=' || coalesce(p.proconfig::text, 'NULL') || ' owner=' || pg_get_userbyid(p.proowner)
                   || ' exec(anon/auth/service)=' || has_function_privilege('anon', p.oid, 'EXECUTE') || '/'
                   || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE') END,
         'secdef=true・exec=false/true/false',
         p.oid IS NOT NULL AND p.prosecdef
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM (VALUES ('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)'),
               ('public.cost_ledger_invoice_update(uuid, jsonb)'),
               ('public.cost_ledger_invoice_delete(uuid)')) f(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
  UNION ALL
  SELECT 'C RPC', 31, 'trigger on cost_ledger_items: ' || t.tgname,
         'enabled=' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid), '記録（P1-3 の lock_actual_cost があること）', true
  FROM pg_trigger t WHERE t.tgrelid = 'public.cost_ledger_items'::regclass AND NOT t.tgisinternal

  -- ── D. cost_ledger_items の定義（新しい表の複合外部キー・論理削除の保護の前提） ──
  UNION ALL
  SELECT 'D 台帳項目の定義', 40, 'constraint ' || con.conname, pg_get_constraintdef(con.oid), '記録', true
  FROM pg_constraint con WHERE con.conrelid = 'public.cost_ledger_items'::regclass AND con.contype IN ('p', 'u', 'f', 'c')
  UNION ALL
  SELECT 'D 台帳項目の定義', 41, 'policy ' || p.policyname,
         format('[%s] roles=%s USING (%s) WITH CHECK (%s)', p.cmd, p.roles::text, p.qual, p.with_check), '記録', true
  FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cost_ledger_items'
  UNION ALL
  SELECT 'D 台帳項目の定義', 42, 'table UPDATE authenticated（見積同期・削除 API が論理削除に使う）',
         has_table_privilege('authenticated', 'public.cost_ledger_items', 'UPDATE')::text, '記録', true
  UNION ALL
  SELECT 'D 台帳項目の定義', 43, 'projects の一意キー (id, company_id)（新しい表の複合外部キー先）',
         (EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = 'public.projects'::regclass AND con.contype IN ('p', 'u')
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) = ARRAY['company_id', 'id']))::text,
         'true（PR-3 で追加済みのはず）',
         EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = 'public.projects'::regclass AND con.contype IN ('p', 'u')
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                        WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) = ARRAY['company_id', 'id'])

  -- ── E. 請求書データの整合（件数・合計だけ） ───────────────
  UNION ALL
  SELECT 'E 請求書データ', 50, '請求書の総数 / 合計', count(*)::text || ' 件 / ' || coalesce(sum(amount), 0)::text, '記録', true FROM inv
  UNION ALL
  SELECT 'E 請求書データ', 51, 'source 別 ' || coalesce(source, 'NULL'), count(*)::text || ' 件 / ' || coalesce(sum(amount), 0)::text, '記録', true
  FROM inv GROUP BY source
  UNION ALL
  SELECT 'E 請求書データ', 52, '台帳項目が無い請求書', count(*)::text, '0', count(*) = 0 FROM inv WHERE item_id IS NULL
  UNION ALL
  SELECT 'E 請求書データ', 53, 'project_id が NULL の請求書', count(*)::text, '記録（以前の行。新しい表の外部キーでは扱わない）', true
  FROM inv WHERE inv_project IS NULL
  UNION ALL
  SELECT 'E 請求書データ', 54, '請求書の project_id ≠ 台帳項目の project_id', count(*)::text, '0', count(*) = 0
  FROM inv WHERE inv_project IS NOT NULL AND item_id IS NOT NULL AND inv_project IS DISTINCT FROM item_project
  UNION ALL
  SELECT 'E 請求書データ', 55, '台帳項目の会社 ≠ 案件の会社（請求書あり）', count(*)::text, '0', count(*) = 0
  FROM inv WHERE item_id IS NOT NULL AND item_company IS DISTINCT FROM project_company
  UNION ALL
  SELECT 'E 請求書データ', 56, '金額が 0 以下の請求書', count(*)::text, '記録（値引きの扱いの参考）', true FROM inv WHERE amount <= 0
  UNION ALL
  SELECT 'E 請求書データ', 57, '金額に 1 円未満の端数がある請求書', count(*)::text, '記録', true FROM inv WHERE amount <> trunc(amount)
  UNION ALL
  SELECT 'E 請求書データ', 58, 'OCR 登録のうち請求書番号あり / なし',
         count(*) FILTER (WHERE nullif(btrim(invoice_number), '') IS NOT NULL)::text || ' / '
           || count(*) FILTER (WHERE nullif(btrim(invoice_number), '') IS NULL)::text,
         '記録（請求書番号による重複検出がどれだけ効くか）', true
  FROM inv WHERE source = 'ocr'
  UNION ALL
  -- 同じ案件・同じ業者・同じ請求書番号の請求書が複数ある（表記ゆれを除いて比較）。中身は出さずにグループ数だけ
  SELECT 'E 請求書データ', 59, '同じ案件・業者・請求書番号のグループ（2 件以上）',
         count(*)::text, '記録（0 でなければ、請求書番号での一意化に既存の重なりがある）', true
  FROM (SELECT 1 FROM inv
        WHERE nullif(btrim(invoice_number), '') IS NOT NULL
        GROUP BY item_project, lower(regexp_replace(coalesce(vendor_name, ''), '\s', '', 'g')),
                 upper(regexp_replace(invoice_number, '[\s\-‐ー－]', '', 'g'))
        HAVING count(*) > 1) g
  UNION ALL
  SELECT 'E 請求書データ', 60, '同じ画像（SHA-256）が別の案件にもある（グループ数）', count(*)::text, '記録', true
  FROM (SELECT 1 FROM inv WHERE document_sha256 IS NOT NULL GROUP BY document_sha256 HAVING count(DISTINCT item_project) > 1) g

  -- ── F. 見積同期・削除による実績原価の消失（現行 /api/cost-ledger/sync・DELETE /api/cost-ledger/[id] の影響） ──
  UNION ALL
  SELECT 'F 論理削除の影響', 70, '論理削除済みの台帳項目のうち 請求書あり（件数 / 請求書合計）',
         count(*)::text || ' 件 / ' || coalesce(sum((SELECT sum(v.amount) FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = items.id)), 0)::text,
         '0（0 でなければ、その実績原価は案件の合計から消えている）', count(*) = 0
  FROM items WHERE deleted_at IS NOT NULL AND has_invoices
  UNION ALL
  SELECT 'F 論理削除の影響', 71, '論理削除済みの台帳項目のうち actual_cost あり（請求書なし・直接入力）',
         count(*)::text || ' 件 / ' || coalesce(sum(actual_cost), 0)::text, '記録（直接入力の実績原価が消えている）', true
  FROM items WHERE deleted_at IS NOT NULL AND NOT has_invoices AND actual_cost IS NOT NULL
  UNION ALL
  SELECT 'F 論理削除の影響', 72, '論理削除済みの台帳項目のうち 実行予算・完工予算あり', count(*)::text, '記録', true
  FROM items WHERE deleted_at IS NOT NULL AND (budget_cost IS NOT NULL OR completion_cost IS NOT NULL)
  UNION ALL
  SELECT 'F 論理削除の影響', 73, '論理削除済みの台帳項目がある案件数（請求書あり）',
         count(DISTINCT project_id)::text, '記録（人が確認する案件の数）', true
  FROM items WHERE deleted_at IS NOT NULL AND has_invoices
  UNION ALL
  -- 次に見積同期を押すと消える行：未削除の台帳項目で、見積行が論理削除済み（物理削除なら estimate_item_id は NULL になり対象外）
  SELECT 'F 論理削除の影響', 74, '次の見積同期で論理削除される台帳項目のうち 請求書あり（件数 / 実績原価）',
         count(*)::text || ' 件 / ' || coalesce(sum(actual_cost), 0)::text,
         '0（0 でなければ、同期の修正前に押すと実績原価が消える）', count(*) = 0
  FROM items WHERE deleted_at IS NULL AND estimate_item_id IS NOT NULL AND est_deleted IS NOT NULL AND has_invoices
  UNION ALL
  SELECT 'F 論理削除の影響', 75, '次の見積同期で論理削除される台帳項目のうち actual_cost / 予算あり（請求書なし）',
         count(*)::text, '記録', true
  FROM items WHERE deleted_at IS NULL AND estimate_item_id IS NOT NULL AND est_deleted IS NOT NULL AND NOT has_invoices
    AND (actual_cost IS NOT NULL OR budget_cost IS NOT NULL OR completion_cost IS NOT NULL)
  UNION ALL
  -- 見積行を削除→復活・再追加したときに、同じ見積行を指す未削除の台帳項目が複数できていないか
  SELECT 'F 論理削除の影響', 76, '同じ見積行を指す未削除の台帳項目が複数（グループ数）', count(*)::text, '0', count(*) = 0
  FROM (SELECT 1 FROM items WHERE deleted_at IS NULL AND estimate_item_id IS NOT NULL
        GROUP BY estimate_item_id HAVING count(*) > 1) g
  UNION ALL
  SELECT 'F 論理削除の影響', 77, '請求書がある未削除の項目で actual_cost ≠ 請求書の合計', count(*)::text, '0', count(*) = 0
  FROM items WHERE deleted_at IS NULL AND has_invoices
    AND actual_cost IS DISTINCT FROM (SELECT sum(v.amount) FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = items.id)
  UNION ALL
  SELECT 'F 論理削除の影響', 78, '台帳項目の company_id が NULL / 案件の会社と不一致',
         count(*) FILTER (WHERE ci.company_id IS NULL)::text || ' / '
           || count(*) FILTER (WHERE ci.company_id IS NOT NULL AND ci.company_id IS DISTINCT FROM p.company_id)::text,
         '0 / 0', count(*) FILTER (WHERE ci.company_id IS NULL OR ci.company_id IS DISTINCT FROM p.company_id) = 0
  FROM public.cost_ledger_items ci JOIN public.projects p ON p.id = ci.project_id

  -- ── G. 規模（明細行数・振り分けの見込み） ──────────────────
  UNION ALL
  SELECT 'G 規模', 80, '案件ごとの未削除の台帳項目数（最大 / 平均）',
         coalesce(max(n), 0)::text || ' / ' || coalesce(round(avg(n), 1), 0)::text, '記録（候補一覧の大きさ）', true
  FROM (SELECT count(*) AS n FROM public.cost_ledger_items WHERE deleted_at IS NULL GROUP BY project_id) s
  UNION ALL
  SELECT 'G 規模', 81, '台帳項目のうち見積行に紐付くもの / 手動',
         count(*) FILTER (WHERE estimate_item_id IS NOT NULL)::text || ' / ' || count(*) FILTER (WHERE estimate_item_id IS NULL)::text,
         '記録', true
  FROM public.cost_ledger_items WHERE deleted_at IS NULL
)
SELECT sort, section, item, value, expected, ok FROM rows
UNION ALL
SELECT 0, '0 判定', '== VERDICT ==',
       CASE WHEN bool_and(ok) THEN '前提どおり（記録の行を設計に使う）' ELSE 'ok = false の行あり（報告して設計を見直す）' END,
       count(*) FILTER (WHERE NOT ok)::text || ' 件 ok = false', bool_and(ok)
FROM rows
ORDER BY 1, 3;
