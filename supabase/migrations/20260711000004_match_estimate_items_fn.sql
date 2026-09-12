-- ============================================================
-- 自社単価マッチング関数
-- CLAUDE.md v3.3「コア機能：自社単価マッチング」準拠
--
-- 前提：
--   CREATE EXTENSION IF NOT EXISTS pg_trgm; が実行済み
--   company_estimate_items_name_trgm_idx (GIN) が存在する
--
-- 設計上の正直な限界（CLAUDE.md v3.3 より）：
--   trigram類似検索は表記ゆれ・誤字・略語には強いが、
--   同義語・別表現（例：「塩ビ管」と「PVCパイプ」、
--   「システムバス」と「浴室」）には対応できない。
--   これは「拾う作業の母数を減らす」レベルの改善であり、
--   完全解決ではないことを関係者に正しく説明すること。
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- 関数定義
-- ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION match_estimate_items(
  p_company_id UUID,
  p_query      TEXT,
  p_limit      INT     DEFAULT 5,
  p_threshold  NUMERIC DEFAULT 0.1  -- 日本語は英語より低スコアになりやすいため0.1を基準値に
)
RETURNS TABLE (
  id            UUID,
  category      TEXT,
  name          TEXT,
  unit          TEXT,
  cost_price    NUMERIC,
  selling_price NUMERIC,
  memo          TEXT,
  usage_count   INT,
  last_used_at  TIMESTAMPTZ,
  similarity    NUMERIC
)
LANGUAGE sql
STABLE   -- 同一トランザクション内でのDBの変更を反映するが、トランザクション間では一定
PARALLEL SAFE
AS $$
  --
  -- CTE でスコアを一度だけ計算し、WHERE と ORDER BY で使い回す。
  --
  -- GINインデックス活用について:
  --   similarity() を直接 WHERE に書いてもプランナーがGINを使えないケースがある。
  --   代わりに % 演算子（word_similarity の閾値ベース）で事前絞り込みし、
  --   その後に正確なスコアで並び替える 2段構成が最も安定する。
  --   ただし日本語の短い文字列（3文字未満）は trigram が生成されず
  --   % 演算子では常に false になるため、フォールバックとして
  --   similarity() >= p_threshold も OR で加える。
  --
  WITH scored AS (
    SELECT
      c.id,
      c.category,
      c.name,
      c.unit,
      c.cost_price,
      c.selling_price,
      c.memo,
      c.usage_count,
      c.last_used_at,
      -- similarity()  : 完全一致よりも文字列全体の類似度を見る
      -- word_similarity(): p_query が c.name の「部分」として含まれるかを見る
      --   → 短い検索語（「バス」）が長い登録名（「システムバス」）に含まれる場合に有効
      -- 両者の大きい方を最終スコアとして採用する
      GREATEST(
        similarity(p_query, c.name),
        word_similarity(p_query, c.name)
      ) AS similarity
    FROM company_estimate_items c
    WHERE c.company_id = p_company_id
  )
  SELECT *
  FROM scored
  WHERE similarity >= p_threshold
  ORDER BY
    similarity  DESC,   -- 類似度が高い順（最優先）
    usage_count DESC,   -- 使用回数が多い順（CLAUDE.md: 使用回数/直近利用日でソート）
    last_used_at DESC   -- 直近利用日が新しい順
  LIMIT p_limit;
$$;


-- ──────────────────────────────────────────────────────────
-- 動作テスト（3パターン）
-- ── 下記をそのまま SQL Editor に貼り付けて実行 ──
-- ──────────────────────────────────────────────────────────

-- ① 完全一致に近いケース：「システムバス」
-- 期待: システムバス・システムバス施工費 が高スコアでヒット
SELECT '①システムバス' AS 検索パターン, category, name, unit, selling_price, similarity
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  'システムバス'
)
ORDER BY similarity DESC;


-- ② 部分一致・表記ゆれ：「バス交換」
-- 期待: 「システムバス」「システムバス施工費」が中程度のスコアでヒット
--       （word_similarity が「バス」の部分一致を拾う）
--       「浴室」とは trigram が一致しないためヒットしない → pg_trgm の正直な限界
SELECT '②バス交換' AS 検索パターン, category, name, unit, selling_price, similarity
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  'バス交換'
)
ORDER BY similarity DESC;


-- ③ 別表現（同義語）：「浴室のリフォーム」
-- 期待: ほぼヒットしない（0件 or 低スコア）
--       → これが trigram の設計上の限界であり、pgvector へ移行する際の判断材料にする
SELECT '③浴室のリフォーム' AS 検索パターン, category, name, unit, selling_price, similarity
FROM match_estimate_items(
  'b0aa6eed-faec-4698-ac87-9d9e2d350280',
  '浴室のリフォーム',
  5,
  0.05   -- 限界確認のため閾値を下げてテスト
)
ORDER BY similarity DESC;


-- ──────────────────────────────────────────────────────────
-- スコア分布確認クエリ（閾値チューニング用）
-- 「システムバス」「足場」「断熱材」など実際の項目名で
-- similarity スコアの範囲を確認する際に使う
-- ──────────────────────────────────────────────────────────
-- SELECT
--   name,
--   similarity('足場', name)         AS sim_足場,
--   similarity('断熱', name)         AS sim_断熱,
--   word_similarity('足場', name)    AS wsim_足場,
--   word_similarity('断熱材', name)  AS wsim_断熱材
-- FROM company_estimate_items
-- WHERE company_id = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'
-- ORDER BY wsim_断熱材 DESC
-- LIMIT 20;
