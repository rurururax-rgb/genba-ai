-- ============================================================
-- line_events に音声パイプラインの結果カラムを追加
-- CLAUDE.md: カラム追加はOK、削除禁止
-- ============================================================

ALTER TABLE line_events
  ADD COLUMN IF NOT EXISTS extracted_terms JSONB,
  -- extractSearchTerms() の出力: string[] 例: ["システムバス", "洋式トイレ"]
  ADD COLUMN IF NOT EXISTS matched_items   JSONB;
  -- match_estimate_items() の出力: MatchedItem[]
  -- 例: [{"term": "システムバス", "candidates": [{id, name, similarity, ...}]}]

-- 確認クエリ
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'line_events'
-- ORDER BY ordinal_position;
