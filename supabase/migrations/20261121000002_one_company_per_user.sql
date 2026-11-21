-- ============================================================
-- 1 ユーザーの所属を 1 社までにする（company_members.user_id に UNIQUE 制約）
--
-- 背景:
--   アプリは 1 ユーザー 1 社を前提にしている（getCurrentCompany() は company_members を .single() で読む。
--   多くの API ルートも maybeSingle() で所属を 1 件だけ読む）。
--   company_members には UNIQUE (company_id, user_id) しか無く、同じユーザーが 2 社に所属する行を作れる。
--   2 社目の所属ができると、そのユーザーはログイン後の画面・API がエラーになる。
--
-- 変更すること:
--   company_members に UNIQUE (user_id) を追加する（制約名 company_members_user_id_key）。
--   （user_id は NOT NULL。仮に NULL の行があっても UNIQUE は NULL を重複とみなさない）
--   既存の UNIQUE (company_id, user_id)・外部キー・RLS ポリシー・行は変えない。
--
-- 既存データ:
--   すでに 2 社以上に所属するユーザーがいれば、何も変えずにエラーで止まる（行の削除・移動はしない）。
--
-- 試用アカウントの移行（info@rugs-reform.jp を B 社から試用会社へ）への影響:
--   移行 SQL は 1 つのトランザクションで「B 社の所属を DELETE → 試用会社に INSERT」の順に行うため、
--   この制約があっても通る（DELETE が先なので重複の瞬間が無い）。
--   逆の順（INSERT → DELETE）や、所属を残したまま別の会社に追加する操作はこの制約で拒否される。
--
-- ロック:
--   制約の追加はインデックスを作る間 company_members に ACCESS EXCLUSIVE ロックを取る。
--   RLS の確認（get_my_company_ids()）が company_members を読むため、その間の画面操作は待たされる。
--   行数が少ない（本番 3 行）ので一瞬で終わる。
-- ============================================================

DO $$
DECLARE
  dup int;
BEGIN
  SELECT count(*) INTO dup
  FROM (
    SELECT user_id FROM public.company_members
    WHERE user_id IS NOT NULL
    GROUP BY user_id HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'one-company-per-user precondition failed: % user(s) belong to 2+ companies', dup;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.company_members'::regclass AND conname = 'company_members_user_id_key'
  ) THEN
    RAISE EXCEPTION 'one-company-per-user precondition failed: constraint company_members_user_id_key already exists';
  END IF;
END
$$;

ALTER TABLE public.company_members
  ADD CONSTRAINT company_members_user_id_key UNIQUE (user_id);

COMMENT ON CONSTRAINT company_members_user_id_key ON public.company_members IS
  '1 ユーザーの所属は 1 社まで（getCurrentCompany() の .single() 前提）。所属を移すときは DELETE してから INSERT する';
