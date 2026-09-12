-- 20260912000004_add_daily_briefing_runs.sql
--
-- 目的: 日次ブリーフィングの送信記録テーブル。
--       Vercel Cron の重複実行（同一 company + 同一日付）を DB の
--       UNIQUE 制約と atomic な status 遷移で防ぐ。
--
-- 二重送信防止の仕組み:
--   1. 実行開始時に status='pending' で INSERT（UNIQUE 違反なら別ルートへ）
--   2. LINE 送信成功 → status='sent'
--   3. LINE 送信失敗 → status='failed'（次回 Cron で再試行可能）
--   4. 高優先度アイテム無し → status='skipped'
--
--   並行実行の競合は:
--     - INSERT conflict（23505）→ 既存の status を確認してスキップ
--     - failed 再試行 → UPDATE WHERE status='failed' の行ロックで1プロセスのみが権利取得
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_briefing_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  briefing_date DATE        NOT NULL,
  -- 'pending'  : 処理中（INSERT 直後）
  -- 'sent'     : LINE 送信成功
  -- 'skipped'  : 高優先度アイテムなし、送信なし
  -- 'failed'   : LINE 送信失敗（次 Cron で再試行可能）
  status        TEXT        NOT NULL DEFAULT 'pending',
  items_count   INT,         -- 送信したアクション件数（ログ用）
  sent_at       TIMESTAMPTZ, -- LINE 送信成功時刻
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE(company_id, briefing_date)
);

-- RLS
ALTER TABLE daily_briefing_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自社データのみ" ON daily_briefing_runs
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );

-- インデックス（company_id + briefing_date の絞り込み高速化）
CREATE INDEX IF NOT EXISTS idx_daily_briefing_runs_company_date
  ON daily_briefing_runs (company_id, briefing_date DESC);
