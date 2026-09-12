-- ============================================================
-- デモ用ユーザーセットアップ SQL
-- ⚠️ これはデモ専用の手順です。本番の正式な会社作成フローは
--    create_company_with_owner() 関数経由（Step 3 以降）で行うこと。
--
-- 実行前の準備:
--   Supabase ダッシュボード > Authentication > Users > 「Add user」
--   でたかしさんのメールアドレスとパスワードを設定しておくこと。
--   （「Auto confirm user」を ON にしてメール確認をスキップできる）
--
-- 実行順序:
--   Step A → Step B → Step C の順に実行する
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- Step A: たかしさんを company_members に登録
--
-- email を変更してから実行する
-- ──────────────────────────────────────────────────────────
INSERT INTO company_members (company_id, user_id, role)
SELECT
  'b0aa6eed-faec-4698-ac87-9d9e2d350280'::uuid,  -- ラグズ建築
  id,
  'owner'
FROM auth.users
WHERE email = 'YOUR_EMAIL@example.com'            -- ← たかしさんのメールに変更
ON CONFLICT (company_id, user_id) DO NOTHING;

-- 登録確認
SELECT
  u.email,
  cm.role,
  c.name  AS company_name,
  cm.company_id
FROM company_members cm
JOIN auth.users  u ON u.id  = cm.user_id
JOIN companies   c ON c.id  = cm.company_id
WHERE cm.company_id = 'b0aa6eed-faec-4698-ac87-9d9e2d350280';


-- ──────────────────────────────────────────────────────────
-- Step B: デモ用テスト案件を作成
-- （AI整理タブの動作確認に必要）
-- ──────────────────────────────────────────────────────────
INSERT INTO projects (company_id, name, customer_name, site_address, status)
VALUES (
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  '犬山市古民家減築プラン',
  '栗本様',
  '愛知県犬山市',
  'collecting'
)
RETURNING id;  -- ← このIDをメモする（Step C で使う）


-- ──────────────────────────────────────────────────────────
-- Step C: 未振り分けの line_events をテスト案件に紐付け
-- （LINE から受信済みのデータがある場合）
--
-- <PROJECT_ID> を Step B で返ってきた UUID に置き換えて実行
-- ──────────────────────────────────────────────────────────
-- UPDATE line_events
-- SET project_id = '<PROJECT_ID>'
-- WHERE project_id IS NULL
--   AND company_id = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'
--   AND is_processed = true;


-- ──────────────────────────────────────────────────────────
-- 動作確認クエリ（Step C 実行後）
-- ──────────────────────────────────────────────────────────
-- SELECT
--   id, event_type, raw_content, is_processed,
--   extracted_terms, reflected_to_estimate
-- FROM line_events
-- WHERE company_id = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'
-- ORDER BY received_at DESC;
