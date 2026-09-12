-- ============================================================
-- LINE Webhook用テーブル・RLS設定
-- Supabase SQL Editor で実行する（上から順番に）
-- ============================================================

-- ① 前提：get_my_company_ids() 関数が未作成の場合は先に作成
-- （companies / company_members が存在する前提）
CREATE OR REPLACE FUNCTION get_my_company_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM company_members WHERE user_id = auth.uid();
$$;

-- ② line_events テーブル
-- line_event_id: LINE側のwebhookEventId（再送時の重複防止に必須）
CREATE TABLE IF NOT EXISTS line_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id),
  line_user_id  TEXT NOT NULL,
  line_event_id TEXT NOT NULL,
  event_type    TEXT,             -- 'text' | 'image' | 'audio'
  raw_content   TEXT,             -- テキストの場合はメッセージ本文
  storage_path  TEXT,             -- 写真・音声の Storage パス（genba-ai バケット内）
  project_id    UUID REFERENCES projects(id),  -- 手動紐付け後に設定。未振り分けはNULL
  is_processed  BOOLEAN DEFAULT false,
  received_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, line_event_id)  -- LINEの再送イベントを一意に弾く
);

-- ③ RLS 有効化
ALTER TABLE line_events ENABLE ROW LEVEL SECURITY;

-- ④ ポリシー設定（get_my_company_ids() を使い自己参照無限再帰を回避）
-- Webhook受信はservice_role（admin.ts）でRLSをバイパスするためこのポリシーは影響しない
-- Web側での閲覧（未振り分けUI等）は通常ユーザーのRLSに従う
CREATE POLICY "自社データのみ閲覧" ON line_events
  FOR SELECT USING (company_id IN (SELECT get_my_company_ids()));

CREATE POLICY "自社データのみ更新" ON line_events
  FOR UPDATE USING (company_id IN (SELECT get_my_company_ids()));

-- ⑤ Storage バケット確認・作成（未作成の場合）
-- Supabase ダッシュボード > Storage から手動で作成:
--   バケット名: genba-ai
--   Public: false（Private必須）

-- ⑥ Storage RLS（genba-ai バケット：自社フォルダのみ）
CREATE POLICY "自社フォルダのみ読み取り" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'genba-ai'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_company_ids())
  );

CREATE POLICY "自社フォルダのみ書き込み" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'genba-ai'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_company_ids())
  );

CREATE POLICY "自社フォルダのみ更新" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'genba-ai'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_company_ids())
  );

CREATE POLICY "自社フォルダのみ削除" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'genba-ai'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_company_ids())
  );
