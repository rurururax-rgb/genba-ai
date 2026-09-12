-- ============================================================
-- パイプラインテスト: 文字起こし → 検索キーワード → pg_trgm マッチング
--
-- このファイルは動作検証用。
-- extractSearchTerms() が返すキーワードを手動で代入して
-- match_estimate_items() の結果を確認する。
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- ケース①: 「お風呂交換しといて」
-- extractSearchTerms() の想定出力: ["システムバス"]
-- ──────────────────────────────────────────────────────────
SELECT
  '「お風呂交換しといて」→ "システムバス"' AS 検索パターン,
  category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  'システムバス'
);

-- ──────────────────────────────────────────────────────────
-- ケース②: 「バス替えます」
-- extractSearchTerms() の想定出力: ["システムバス"]
-- 同じキーワードに正規化されるため①と同じ結果になる
-- ──────────────────────────────────────────────────────────
SELECT
  '「バス替えます」→ "システムバス"' AS 検索パターン,
  category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  'システムバス'
);

-- ──────────────────────────────────────────────────────────
-- ケース③: 「浴室のリフォーム」
-- extractSearchTerms() の想定出力: ["システムバス"]
--   Claude が語彙リストを参照して口語→建設用語に変換する。
--   もし Claude が「浴室」をそのまま返した場合のスコアも確認用に掲載。
-- ──────────────────────────────────────────────────────────

-- Claude が正しく変換した場合（"システムバス" で検索）
SELECT
  '「浴室のリフォーム」→ Claude変換後: "システムバス"' AS 検索パターン,
  category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  'システムバス'
);

-- Claude が変換できなかった場合（"浴室" のまま検索 → pg_trgm の限界を確認）
SELECT
  '「浴室のリフォーム」→ 変換失敗時: "浴室" で検索（pg_trgmの限界確認）' AS 検索パターン,
  category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  '浴室',
  5,
  0.05   -- 閾値を下げて何かヒットするか確認
);
-- 期待: 0件 or 低スコア。これが pgvector 移行の判断材料になる。

-- ──────────────────────────────────────────────────────────
-- ケース④: 複数項目「トイレとお風呂と台所を全部やって」
-- extractSearchTerms() の想定出力:
--   ["洋式トイレ", "システムバス", "システムキッチン"]
-- 各キーワードを個別にクエリする（アプリ側でループ処理）
-- ──────────────────────────────────────────────────────────
SELECT '洋式トイレ' AS keyword, category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items('b0aa6eed-faec-4698-ac87-9d9e2d350280', '洋式トイレ')
UNION ALL
SELECT 'システムバス', category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items('b0aa6eed-faec-4698-ac87-9d9e2d350280', 'システムバス')
UNION ALL
SELECT 'システムキッチン', category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items('b0aa6eed-faec-4698-ac87-9d9e2d350280', 'システムキッチン')
ORDER BY keyword, score DESC;

-- ──────────────────────────────────────────────────────────
-- ケース⑤: 「電気周り全部やって」
-- extractSearchTerms() の想定出力:
--   ["照明配線移設及び新設", "コンセント配線移設及び新設"]
-- ──────────────────────────────────────────────────────────
SELECT '照明配線移設及び新設' AS keyword, category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280', '照明配線移設及び新設'
)
UNION ALL
SELECT 'コンセント配線移設及び新設', category, name, unit, selling_price,
  ROUND(similarity::numeric, 3) AS score
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280', 'コンセント配線移設及び新設'
)
ORDER BY keyword, score DESC;
