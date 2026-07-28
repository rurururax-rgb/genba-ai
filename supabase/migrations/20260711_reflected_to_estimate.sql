-- ============================================================
-- 見積反映トラッキング用カラム追加
-- CLAUDE.md: カラム追加はOK・削除禁止
-- ============================================================

-- line_events: 見積への反映済みフラグ
ALTER TABLE line_events
  ADD COLUMN IF NOT EXISTS reflected_to_estimate BOOLEAN NOT NULL DEFAULT false;

-- estimate_items: どの LINE イベントから追加されたかを追跡
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS line_event_id UUID REFERENCES line_events(id);
