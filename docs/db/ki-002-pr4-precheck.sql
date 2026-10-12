-- =====================================================================
-- KI-002 PR-4: 制約を設計する前の読み取り専用調査 SQL（Supabase SQL Editor で 1 つずつ実行する）
--
-- ・SELECT・カタログ参照・SHOW だけ。書き込み・DDL・関数の作成は一切しない。
--   念のため ⓪ の BEGIN READ ONLY の中で実行してもよい（最後に ROLLBACK）。
-- ・行の中身（名前・金額・メモ）は出さない。件数と ID・定義だけを出す。
-- ・①〜⑥ はリポジトリの migration にある列を前提にする。列が無くてエラーになったら、それ自体が調査結果
--   （本番と migration の食い違い）なので、そのまま報告する。⑦ はカタログだけを見るので列を推測しない。
-- ・本番への接続・実行は、人間が別途承認してから人間が行う。
-- ・期待値と読み方は docs/db/ki-002-pr4-plan.md の「precheck の読み方」を参照。
-- =====================================================================

-- ⓪（任意）読み取り専用トランザクションで囲む。①〜⑨ を流した後に ROLLBACK; を実行する
-- BEGIN READ ONLY;

-- ① PostgreSQL のバージョン（ON DELETE SET NULL (列) は 15 以上が必要）
SHOW server_version;

-- ② migration 履歴（PR-3 まで適用済み・PR-4 は未作成であること）
SELECT v.version,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version) AS recorded
FROM (VALUES ('20261013000001'), ('20261013000002'), ('20261014000001')) AS v(version)
ORDER BY v.version;

-- ③ 関係する列の定義（型・NULL 可否）。参照する側・される側の両方
SELECT c.table_name, c.column_name, c.data_type,
       c.is_nullable = 'YES' AS nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name, c.column_name) IN (
    ('estimate_items', 'project_id'), ('estimate_items', 'company_id'), ('estimate_items', 'group_id'),
    ('estimate_items', 'line_event_id'), ('estimate_items', 'deleted_at'),
    ('estimate_groups', 'id'), ('estimate_groups', 'project_id'), ('estimate_groups', 'company_id'),
    ('estimate_groups', 'deleted_at'),
    ('schedule_items', 'project_id'), ('schedule_items', 'company_id'), ('schedule_items', 'estimate_group_id'),
    ('schedule_items', 'deleted_at'),
    ('cost_ledger_items', 'project_id'), ('cost_ledger_items', 'company_id'), ('cost_ledger_items', 'estimate_item_id'),
    ('cost_ledger_items', 'deleted_at'),
    ('line_events', 'id'), ('line_events', 'company_id'), ('line_events', 'project_id'),
    ('line_event_notes', 'anchor_event_id'), ('line_event_notes', 'company_id'), ('line_event_notes', 'project_id'),
    ('schedule_draft_adoptions', 'draft_id'), ('schedule_draft_adoptions', 'project_id'),
    ('schedule_draft_adoptions', 'company_id'))
ORDER BY c.table_name, c.column_name;

-- ④ 既存の外部キー・一意制約（対象の参照と、参照先の一意制約。PR-4 の制約名が既にあれば pr4_name_exists = true）
SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, c.convalidated,
       pg_get_constraintdef(c.oid) AS definition,
       c.conname IN ('estimate_items_group_project_fkey', 'schedule_items_estimate_group_project_fkey',
                     'cost_ledger_items_estimate_item_project_fkey', 'estimate_items_line_event_company_fkey',
                     'line_event_notes_anchor_event_company_fkey', 'estimate_groups_id_project_id_key',
                     'estimate_items_id_project_id_key', 'line_events_id_company_id_key') AS pr4_name_exists
FROM pg_constraint c
WHERE c.connamespace = 'public'::regnamespace
  AND (
    (c.contype = 'f' AND c.conrelid::regclass::text IN
       ('estimate_items', 'schedule_items', 'cost_ledger_items', 'line_event_notes', 'schedule_draft_adoptions')
     AND c.confrelid::regclass::text IN ('estimate_groups', 'estimate_items', 'line_events'))
    OR (c.contype IN ('p', 'u') AND c.conrelid::regclass::text IN
       ('estimate_groups', 'estimate_items', 'line_events', 'schedule_draft_adoptions'))
  )
ORDER BY 1, 2;

-- ⑤ データの食い違い（参照ごとに 1 行。列の意味は行ごとに match_key / info_meaning で示す）
--   match_key            : 制約案で一致を保証する列（R1〜R3 = project_id、R4・R5 = company_id）
--   blocking_orphan      : 参照先の行が無い（既存の単独外部キーがあるので通常 0）
--   blocking_target_null : 参照先の match_key が NULL（制約案では一致しないので拒否される）
--   blocking_mismatch    : 参照先の match_key が参照元と違う（制約案で拒否される）
--   → blocking_* がすべて 0 であること。論理削除済みの行も数える（外部キーは deleted_at を見ないため）
--   info_count           : 制約案では拒否しないが、既存の挙動を知るための件数。意味は info_meaning
WITH
r1 AS (
  SELECT 'R1 estimate_items.group_id → estimate_groups' AS ref, 'project_id' AS match_key,
    count(*) AS with_ref,
    count(*) FILTER (WHERE g.id IS NULL) AS blocking_orphan,
    count(*) FILTER (WHERE g.id IS NOT NULL AND g.project_id IS NULL) AS blocking_target_null,
    count(*) FILTER (WHERE g.project_id <> x.project_id) AS blocking_mismatch,
    count(*) FILTER (WHERE x.deleted_at IS NULL AND g.deleted_at IS NOT NULL) AS info_count,
    '未削除の見積行が論理削除済みの工種を指す（拒否しない）' AS info_meaning
  FROM public.estimate_items x LEFT JOIN public.estimate_groups g ON g.id = x.group_id
  WHERE x.group_id IS NOT NULL
),
r2 AS (
  SELECT 'R2 schedule_items.estimate_group_id → estimate_groups', 'project_id',
    count(*),
    count(*) FILTER (WHERE g.id IS NULL),
    count(*) FILTER (WHERE g.id IS NOT NULL AND g.project_id IS NULL),
    count(*) FILTER (WHERE g.project_id <> x.project_id),
    count(*) FILTER (WHERE x.deleted_at IS NULL AND g.deleted_at IS NOT NULL),
    '未削除の工程が論理削除済みの工種を指す（工種の削除 API は工程を NULL にしないため正当。拒否しない）'
  FROM public.schedule_items x LEFT JOIN public.estimate_groups g ON g.id = x.estimate_group_id
  WHERE x.estimate_group_id IS NOT NULL
),
r3 AS (
  SELECT 'R3 cost_ledger_items.estimate_item_id → estimate_items', 'project_id',
    count(*),
    count(*) FILTER (WHERE e.id IS NULL),
    count(*) FILTER (WHERE e.id IS NOT NULL AND e.project_id IS NULL),
    count(*) FILTER (WHERE e.project_id <> x.project_id),
    count(*) FILTER (WHERE x.deleted_at IS NULL AND e.deleted_at IS NOT NULL),
    '未削除の台帳行が論理削除済みの見積行を指す（見積の同期前の状態。拒否しない）'
  FROM public.cost_ledger_items x LEFT JOIN public.estimate_items e ON e.id = x.estimate_item_id
  WHERE x.estimate_item_id IS NOT NULL
),
r4 AS (
  SELECT 'R4 estimate_items.line_event_id → line_events', 'company_id',
    count(*),
    count(*) FILTER (WHERE l.id IS NULL),
    count(*) FILTER (WHERE l.id IS NOT NULL AND l.company_id IS NULL),
    count(*) FILTER (WHERE l.company_id <> x.company_id),
    count(*) FILTER (WHERE l.id IS NOT NULL AND l.project_id IS DISTINCT FROM x.project_id),
    'イベントの案件が NULL（未振り分け）か見積行と別（案件は制約にしない。拒否しない）'
  FROM public.estimate_items x LEFT JOIN public.line_events l ON l.id = x.line_event_id
  WHERE x.line_event_id IS NOT NULL
),
r5 AS (
  SELECT 'R5 line_event_notes.anchor_event_id → line_events', 'company_id',
    count(*),
    count(*) FILTER (WHERE l.id IS NULL),
    count(*) FILTER (WHERE l.id IS NOT NULL AND l.company_id IS NULL),
    count(*) FILTER (WHERE l.company_id <> x.company_id),
    count(*) FILTER (WHERE l.id IS NOT NULL AND x.project_id IS DISTINCT FROM l.project_id),
    'メモとイベントの案件が違う（未振り分けのイベントへのメモを含む。案件は制約にしない。拒否しない）'
  FROM public.line_event_notes x LEFT JOIN public.line_events l ON l.id = x.anchor_event_id
)
SELECT * FROM r1 UNION ALL SELECT * FROM r2 UNION ALL SELECT * FROM r3
UNION ALL SELECT * FROM r4 UNION ALL SELECT * FROM r5;

-- ⑤-2 参照先の行の状態（参照されている工種・見積行・LINE イベントの内訳。制約案の前提の確認）
SELECT 'estimate_groups' AS tbl, count(*) AS total,
       count(*) FILTER (WHERE project_id IS NULL) AS project_null,
       count(*) FILTER (WHERE company_id IS NULL) AS company_null,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted
FROM public.estimate_groups
UNION ALL
SELECT 'line_events', count(*),
       count(*) FILTER (WHERE project_id IS NULL),   -- 未振り分け（正当。制約で禁止しない）
       count(*) FILTER (WHERE company_id IS NULL),
       NULL
FROM public.line_events;

-- ⑥ schedule_draft_adoptions（draft_id は会社・案件をまたいで一意な TEXT 主キー）
--   保存される draft_id は AI 工程案の「一括採用」ごとの ID（components/projects/ScheduleTab.tsx の newDraftId）:
--     `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
--   ※ 工程案の各行の _draft_id（'draft-' + 乱数）は画面内の React 用の一時 ID で、DB には保存されない。
--   API（app/api/schedule-items/batch）は draft_id の形式を検査しないので、想定外の形式も数える
SELECT count(*) AS total,
       count(*) FILTER (WHERE draft_id ~ '^ai-[0-9a-z]+-[0-9a-z]{1,6}$') AS expected_format,
       count(*) FILTER (WHERE draft_id !~ '^ai-[0-9a-z]+-[0-9a-z]{1,6}$') AS unexpected_format,
       count(*) FILTER (WHERE draft_id ~ '^draft-') AS item_key_format,   -- 行の一時 ID が保存されていれば画面と前提が違う
       count(*) FILTER (WHERE project_id IS NULL) AS project_null,
       count(*) FILTER (WHERE company_id IS NULL) AS company_null,
       count(DISTINCT company_id) AS companies,
       min(length(draft_id)) AS min_len, max(length(draft_id)) AS max_len
FROM public.schedule_draft_adoptions;

-- ⑦ PostgREST の埋め込みがあいまいになる組（同じ 2 テーブル間に外部キーが 2 本以上）
--   ここに出る組をヒント無しで埋め込むと PGRST201 になる。アプリの埋め込みは 3 か所が該当し、PR #41（KI-003）で
--   外部キー名のヒントを付けた（billing-status.ts ×2・daily-briefing.ts）。PR-4 の外部キーを足すときもここで確かめる
SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref_tbl,
       count(*) AS fkeys, string_agg(c.conname, ', ' ORDER BY c.conname) AS names
FROM pg_constraint c
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY 1, 2;

-- ⑧ 本番だけにある 2 テーブル（estimate_revisions / cost_ledger_invoices）の定義。カタログだけを読む（列を推測しない）
--   ⑧-a 列
SELECT c.table_name, c.ordinal_position, c.column_name, c.data_type, c.is_nullable, c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name IN ('estimate_revisions', 'cost_ledger_invoices')
ORDER BY c.table_name, c.ordinal_position;

--   ⑧-b 制約・インデックス・トリガー・RLS・行数
SELECT r.relname AS tbl, 'constraint' AS kind, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
WHERE r.relnamespace = 'public'::regnamespace AND r.relname IN ('estimate_revisions', 'cost_ledger_invoices')
UNION ALL
SELECT i.tablename, 'index', i.indexname, i.indexdef
FROM pg_indexes i
WHERE i.schemaname = 'public' AND i.tablename IN ('estimate_revisions', 'cost_ledger_invoices')
UNION ALL
SELECT r.relname, 'trigger', t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
WHERE NOT t.tgisinternal AND r.relnamespace = 'public'::regnamespace
  AND r.relname IN ('estimate_revisions', 'cost_ledger_invoices')
UNION ALL
SELECT p.tablename, 'policy', p.policyname,
       format('[%s] roles=%s USING (%s) WITH CHECK (%s)', p.cmd, p.roles::text, p.qual, p.with_check)
FROM pg_policies p
WHERE p.schemaname = 'public' AND p.tablename IN ('estimate_revisions', 'cost_ledger_invoices')
UNION ALL
SELECT r.relname, 'stats', 'rls_enabled=' || r.relrowsecurity || ' forced=' || r.relforcerowsecurity,
       'approx_rows=' || r.reltuples::bigint
FROM pg_class r
WHERE r.relnamespace = 'public'::regnamespace AND r.relname IN ('estimate_revisions', 'cost_ledger_invoices')
ORDER BY 1, 2, 3;

-- ⑨ RLS ポリシー（PR-4 の対象テーブル）。制約を足す PR の適用前後で同じであることを確かめるために記録する
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('estimate_items', 'estimate_groups', 'schedule_items', 'cost_ledger_items',
                    'line_events', 'line_event_notes', 'schedule_draft_adoptions')
ORDER BY tablename, policyname;

-- ROLLBACK;  -- ⓪ で BEGIN READ ONLY; を実行した場合
