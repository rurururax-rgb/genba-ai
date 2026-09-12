-- 20260912000005_add_summary_source_to_daily_briefing_runs.sql
--
-- AI要約の使用有無を daily_briefing_runs に記録する。
-- 'ai'       : Claude API による要約を使用
-- 'template' : 決定論的テンプレートを使用（AI失敗時fallback含む）
-- NULL       : 旧レコード または skipped/failed のため未記録

ALTER TABLE daily_briefing_runs
  ADD COLUMN IF NOT EXISTS summary_source TEXT;
