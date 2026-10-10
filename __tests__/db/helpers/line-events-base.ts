/**
 * 隔離 DB テスト用（SUPABASE_STUB_SQL の後に流す）。本番と同じ形の estimate_items（initial_schema の列 + RLS は company_id）と line_events。
 * スタブの estimate_items（project_id だけ）を本番の定義に合わせて広げる。
 * line_events の RLS は initial_schema と同じ（SELECT / UPDATE のみ。INSERT は service_role）。
 */
export const LINE_EVENTS_BASE_SQL = `
DROP POLICY "自社データのみ" ON estimate_items;
ALTER TABLE estimate_items
  ALTER COLUMN project_id SET NOT NULL,
  ADD COLUMN company_id    uuid NOT NULL REFERENCES companies(id),
  ADD COLUMN name          text NOT NULL,
  ADD COLUMN description   text,
  ADD COLUMN quantity      numeric NOT NULL DEFAULT 1,
  ADD COLUMN unit          text NOT NULL DEFAULT '式',
  ADD COLUMN cost_price    numeric,
  ADD COLUMN selling_price numeric,
  ADD COLUMN amount        numeric GENERATED ALWAYS AS (quantity * selling_price) STORED,
  ADD COLUMN memo          text,
  ADD COLUMN sort_order    int NOT NULL DEFAULT 0,
  ADD COLUMN source        text NOT NULL DEFAULT 'manual',
  ADD COLUMN created_at    timestamptz DEFAULT now(),
  ADD COLUMN deleted_at    timestamptz;
CREATE POLICY "自社データのみ" ON estimate_items
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

CREATE TABLE line_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id),
  line_user_id  text NOT NULL,
  line_event_id text NOT NULL,
  event_type    text,
  raw_content   text,
  project_id    uuid REFERENCES projects(id),
  is_processed  boolean NOT NULL DEFAULT false,
  received_at   timestamptz DEFAULT now(),
  UNIQUE (company_id, line_event_id)
);
ALTER TABLE line_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ閲覧" ON line_events
  FOR SELECT USING (company_id IN (SELECT get_my_company_ids()));
CREATE POLICY "自社データのみ更新" ON line_events
  FOR UPDATE USING (company_id IN (SELECT get_my_company_ids()));
`
