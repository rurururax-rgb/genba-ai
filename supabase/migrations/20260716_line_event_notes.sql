-- LINE カードへの手動追記テーブル
-- anchor_event_id = グループ内で最も古い line_events.id（フロントが決定する）
CREATE TABLE line_event_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_event_id UUID NOT NULL REFERENCES line_events(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id),
  project_id      UUID REFERENCES projects(id),
  note_type       TEXT NOT NULL,  -- 'text' | 'photo'
  content         TEXT,
  storage_path    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX line_event_notes_anchor_idx ON line_event_notes (anchor_event_id);

ALTER TABLE line_event_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON line_event_notes
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );
