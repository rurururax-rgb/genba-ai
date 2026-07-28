-- 自由グループ化・並び替え対応のための estimate_groups テーブル追加
-- estimate_items に group_id 列を追加

CREATE TABLE estimate_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id),
  label        TEXT NOT NULL DEFAULT '',
  display_mode TEXT NOT NULL DEFAULT 'detailed', -- 'detailed' | 'lump_sum'
  sort_order   INT  DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES estimate_groups(id) ON DELETE SET NULL;

ALTER TABLE estimate_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自社データのみ" ON estimate_groups
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );
