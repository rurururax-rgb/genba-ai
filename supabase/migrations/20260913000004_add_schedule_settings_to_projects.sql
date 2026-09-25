-- 案件の工程カレンダー設定（休業日）を保存するカラムを追加
--   schedule_non_working_weekdays: 曜日インデックスの配列 (0=日, 6=土)
--   schedule_non_working_dates:    個別休業日の配列 ('YYYY-MM-DD')

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS schedule_non_working_weekdays JSONB NOT NULL DEFAULT '[0]',
  ADD COLUMN IF NOT EXISTS schedule_non_working_dates    JSONB NOT NULL DEFAULT '[]';
