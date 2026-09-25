-- 20260913000003_add_schedule_draft_adoptions.sql
--
-- AI工程案の二重採用防止テーブル
-- draft_id ごとに採用済みフラグを管理する。
-- primary key により同じ draft_id は1回しか INSERT できない。

CREATE TABLE IF NOT EXISTS schedule_draft_adoptions (
  draft_id   TEXT        PRIMARY KEY,
  project_id UUID        REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID        REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE schedule_draft_adoptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自社データのみ" ON schedule_draft_adoptions
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );
