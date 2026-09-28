-- ============================================================
-- estimate_items.internal_memo（社内メモ）の追加
--
-- 目的:
--   見積書 OCR/AI 取込で元見積書の備考欄（見積No.・社内管理番号・担当者メモ等）が
--   estimate_items.memo（お客様向け見積書・Excel に出力される備考）へ入り、
--   お客様に見せる必要のない情報が出力される恐れがあった。
--   社内だけで保持する情報の置き場所を分離する。
--
-- 方針（後方互換）:
--   ・estimate_items.memo          … お客様向け備考（既存のまま。移行しない＝既存見積の表示は不変）
--   ・estimate_items.internal_memo … 社内メモ（新規・NULL許容）。お客様向け出力には一切含めない
--   ・既存データの backfill は行わない
--   ・今後の OCR/AI 取込の備考は internal_memo に保存する（アプリ側）
--
-- RLS: estimate_items の既存ポリシー（自社データのみ）がそのまま適用される
-- ============================================================

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS internal_memo TEXT;

COMMENT ON COLUMN estimate_items.internal_memo IS
  '社内メモ（お客様向け見積書・Excel・プレビュー・印刷には出力しない）。OCR取込の元見積書備考はここに保存する';
