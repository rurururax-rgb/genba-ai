-- ============================================================
-- 現場AI — 初期スキーマ マイグレーション
-- CLAUDE.md v3.3 DB設計に準拠
-- Supabase SQL Editor で上から順番に実行する
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 0. 拡張機能
-- ──────────────────────────────────────────────────────────

-- 自社単価マッチング（pg_trgm類似検索）に必須
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ──────────────────────────────────────────────────────────
-- 1. テーブル定義
-- ──────────────────────────────────────────────────────────

-- ① 会社
CREATE TABLE companies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  display_name TEXT,
  tax_rate     NUMERIC DEFAULT 0.10,
  template_id  TEXT DEFAULT 'modern',
  logo_path    TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ② 会社メンバー
CREATE TABLE company_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  UNIQUE(company_id, user_id)
);

-- ③ 案件
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '新規現調',
  customer_name TEXT,
  site_address  TEXT,
  status        TEXT NOT NULL DEFAULT 'collecting',
  -- 'collecting' | 'reviewing' | 'estimating' | 'scheduled' | 'done'
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ④ 現場ファイル（写真・音声・PDF統合）
-- file_size は BIGINT（INT では大きなファイルで溢れる）
CREATE TABLE project_files (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id             UUID NOT NULL REFERENCES companies(id),
  file_type              TEXT NOT NULL,       -- 'photo' | 'audio' | 'pdf' | 'other'
  source                 TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'line'
  storage_path           TEXT NOT NULL,
  thumb_path             TEXT,
  medium_path            TEXT,
  file_size              BIGINT,
  memo                   TEXT,
  transcription          TEXT,               -- 将来：音声文字起こし
  ai_description         TEXT,               -- 将来：写真AI説明
  location_tag           TEXT,               -- 将来：場所分類
  process_tag            TEXT,               -- 将来：工程分類
  ai_location_suggestion TEXT,               -- 将来：AI分類候補
  ai_process_suggestion  TEXT,               -- 将来：AI分類候補
  sort_order             INT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);

-- ⑤ 現場メモ
CREATE TABLE project_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  source     TEXT NOT NULL DEFAULT 'web',    -- 'web' | 'line'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑥ AI整理結果
CREATE TABLE ai_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id   UUID NOT NULL REFERENCES companies(id),
  result_type  TEXT NOT NULL,
  -- 'summary' | 'work_list' | 'cautions' | 'estimate_memo'
  -- 'estimate_items' | 'schedule_items'（将来）
  content      JSONB NOT NULL,
  is_confirmed BOOLEAN NOT NULL DEFAULT false,
  model_used   TEXT,
  tokens_in    INT,
  tokens_out   INT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ⑦ 見積項目（下書きエディタ用）
CREATE TABLE estimate_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id),
  name          TEXT NOT NULL,
  description   TEXT,
  quantity      NUMERIC NOT NULL DEFAULT 1,
  unit          TEXT NOT NULL DEFAULT '式',
  cost_price    NUMERIC,
  selling_price NUMERIC,
  amount        NUMERIC GENERATED ALWAYS AS (quantity * selling_price) STORED,
  memo          TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai' | 'past_item'
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ⑧ 見積書ドキュメント（正式書類）
CREATE TABLE estimate_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id),
  estimate_number TEXT,            -- 例: EST-2024-0042
  issued_at       DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at      DATE,
  customer_name   TEXT,
  project_title   TEXT,
  content         JSONB NOT NULL,  -- 行データ（型番・仕様・備考含む自由形式）
  notes           TEXT,
  subtotal        NUMERIC,
  tax_amount      NUMERIC,
  total           NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ⑨ 会社の過去見積項目（自社単価マッチングのデータソース）
CREATE TABLE company_estimate_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  category      TEXT,
  unit          TEXT NOT NULL DEFAULT '式',
  cost_price    NUMERIC,
  selling_price NUMERIC,
  memo          TEXT,
  usage_count   INT NOT NULL DEFAULT 1,
  last_used_at  TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- pg_trgm 類似検索インデックス（自社単価マッチングに必須）
CREATE INDEX company_estimate_items_name_trgm_idx
  ON company_estimate_items USING gin (name gin_trgm_ops);

-- ⑩ 工程項目（スタンダードプランで利用・今から作っておく）
CREATE TABLE schedule_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  name       TEXT NOT NULL,
  start_date DATE,
  end_date   DATE,
  assignee   TEXT,
  memo       TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- ⑪ 会社メモ（スタンダードプラン以降）
CREATE TABLE company_memos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category   TEXT,
  content    TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑫ 共有リンク（ライトプラン以降）
-- 職人に見せる情報は最小限に限定する
-- 表示OK: 案件名・写真・注意事項・工程表・最終更新日
-- 表示NG: 原価・利益・見積金額・管理者メモ・顧客個人情報
-- anon用RLSポリシーは作らない。職人アクセスは /api/share/[token] 経由のみ
CREATE TABLE share_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  token      TEXT UNIQUE NOT NULL,
  label      TEXT,
  expires_at TIMESTAMPTZ,
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑬ LINEイベントログ（ライトプラン最優先）
-- line_event_id: LINE側の webhookEventId
-- LINEはイベントを再送するため UNIQUE 制約で重複を防ぐ
-- Webhook受信は service_role (admin.ts) でRLSバイパス
-- Web側での閲覧（未振り分けUI等）は通常RLSに従う
CREATE TABLE line_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id),  -- 将来の紐付け前はNULL許容
  line_user_id  TEXT NOT NULL,
  line_event_id TEXT NOT NULL,
  event_type    TEXT,              -- 'text' | 'image' | 'audio'
  raw_content   TEXT,             -- テキストの場合はメッセージ本文
  storage_path  TEXT,             -- 写真・音声の Storage パス（genba-ai バケット内）
  project_id    UUID REFERENCES projects(id),  -- 手動紐付け後に設定。未振り分けはNULL
  is_processed  BOOLEAN NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, line_event_id)
);


-- ──────────────────────────────────────────────────────────
-- 2. RLS用ヘルパー関数
-- ──────────────────────────────────────────────────────────

-- ユーザーが所属する company_id 一覧を返す
-- SECURITY DEFINER で実行することで company_members の自己参照ポリシーによる
-- 無限再帰エラーを回避する
CREATE OR REPLACE FUNCTION get_my_company_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM company_members WHERE user_id = auth.uid();
$$;


-- ──────────────────────────────────────────────────────────
-- 3. サインアップ用関数
-- ──────────────────────────────────────────────────────────

-- 新規ユーザー登録時に1回だけ呼ぶ
-- RLSが有効な状態では新規ユーザーは companies / company_members に
-- INSERTできないため、SECURITY DEFINER 関数でアトミックに実行する
CREATE OR REPLACE FUNCTION create_company_with_owner(company_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_company_id UUID;
BEGIN
  INSERT INTO companies (name)
    VALUES (company_name)
    RETURNING id INTO new_company_id;

  INSERT INTO company_members (company_id, user_id, role)
    VALUES (new_company_id, auth.uid(), 'owner');

  RETURN new_company_id;
END;
$$;


-- ──────────────────────────────────────────────────────────
-- 4. RLS 設定（全テーブル）
-- ──────────────────────────────────────────────────────────

-- ── company_members ──
-- 自分の行のみ参照可（get_my_company_ids() の再帰を避けるため直接書く）
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自分のメンバーシップのみ" ON company_members
  FOR SELECT USING (user_id = auth.uid());

-- ── companies ──
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社のみ" ON companies
  FOR ALL USING (id IN (SELECT get_my_company_ids()));

-- ── projects ──
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON projects
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── project_files ──
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON project_files
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── project_notes ──
ALTER TABLE project_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON project_notes
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── ai_summaries ──
ALTER TABLE ai_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON ai_summaries
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── estimate_items ──
ALTER TABLE estimate_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON estimate_items
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── estimate_documents ──
ALTER TABLE estimate_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON estimate_documents
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── company_estimate_items ──
ALTER TABLE company_estimate_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON company_estimate_items
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── schedule_items ──
ALTER TABLE schedule_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON schedule_items
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── company_memos ──
ALTER TABLE company_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON company_memos
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── share_links ──
-- anon 用ポリシーを作らない。職人アクセスは /api/share/[token] 経由のみ
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "管理者のみ操作可" ON share_links
  FOR ALL USING (company_id IN (SELECT get_my_company_ids()));

-- ── line_events ──
-- 受信（INSERT）は service_role（admin.ts）でRLSバイパス
-- SELECT / UPDATE（未振り分けUI・手動紐付け）は通常RLSに従う
ALTER TABLE line_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ閲覧" ON line_events
  FOR SELECT USING (company_id IN (SELECT get_my_company_ids()));
CREATE POLICY "自社データのみ更新" ON line_events
  FOR UPDATE USING (company_id IN (SELECT get_my_company_ids()));


-- ──────────────────────────────────────────────────────────
-- 5. Storage RLS（genba-ai バケット）
-- ──────────────────────────────────────────────────────────
-- 先にダッシュボード > Storage から「genba-ai」バケットを
-- Private で作成してからこのセクションを実行すること

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
