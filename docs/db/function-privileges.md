# DB 関数の権限修正・1 ユーザー 1 社の制約（限定試用前）

## 1. 何が問題か

2026-11-21 に本番の関数定義と権限を読み取り専用で確認した。結果は 11/14 のバックアップと同じだった（関数本体の md5 も一致）。

| 関数 | 種類 | 修正前の EXECUTE | 問題 |
|---|---|---|---|
| `create_company_with_owner(text)` | SECURITY DEFINER（所有者 postgres） | PUBLIC・anon・authenticated・service_role | ログイン済みの利用者が `/rest/v1/rpc/create_company_with_owner` を呼ぶと、RLS を通らずに会社を作り、自分を owner にできる。2 社目の所属ができ、`getCurrentCompany()` の `.single()` が失敗して画面・API が使えなくなる。anon も実行はできるが、`company_members.user_id` が NOT NULL のため関数の中で失敗する |
| `rls_auto_enable()` | SECURITY DEFINER・イベントトリガー `ensure_rls` の関数 | PUBLIC・anon・authenticated・service_role | イベントトリガーの関数として直接は呼べないので実害は無い。権限は不要 |
| `match_estimate_items` ほか検索 3 関数 | SECURITY INVOKER（RLS が効く） | PUBLIC・anon・authenticated・service_role | search_path が固定されていない。anon も実行できる（RLS で結果は 0 件） |
| `get_my_company_ids()` | SECURITY DEFINER・RLS の補助 | PUBLIC・anon・authenticated・service_role | 自分の会社 ID しか返さない。RLS ポリシー（public・storage）の中で、呼び出したロールの権限で実行されるので、権限は必要 |

修正前の DB（本番スキーマの複製と、リポジトリの migration を適用した DB）で、ログイン済みの利用者が 2 社目の所属を作れることを再現した。

アプリはこの関数を呼んでいない（`git grep create_company_with_owner` で該当するのは migration だけ）。サインアップも無効になっている。

## 2. 修正（2 つの migration は独立していて、どちらを先に適用してもよい）

### 20261121000001_restrict_db_function_privileges.sql

| 関数 | EXECUTE | search_path |
|---|---|---|
| `create_company_with_owner(text)` | PUBLIC・anon・authenticated・service_role から取り消す（所有者の postgres = SQL Editor だけが実行できる） | `public, pg_temp` |
| `rls_auto_enable()` | PUBLIC・anon・authenticated・service_role から取り消す（イベントトリガーは関数の EXECUTE 権限を見ないので、動作は変わらない） | 変更しない（`pg_catalog`） |
| 検索 4 関数 | PUBLIC・anon から取り消す。authenticated・service_role は残す | `public, pg_temp`（pg_trgm は本番でも public にある） |
| `get_my_company_ids()` | 変更しない | `public, pg_temp` |

次のものは変えない。

- 関数の本体
- テーブル
- RLS ポリシー
- 業務データ

関数の DROP もしない。

### 20261121000002_one_company_per_user.sql

- `company_members` に `UNIQUE (user_id)` を追加する。制約名は `company_members_user_id_key`。
- 2 社以上に所属するユーザーがいれば、何も変えずに止まる。

本番（11/21 時点）の状態と、制約を足せるかの判断:

- 会社は 3 社、所属は 3 行。
- 2 社以上に所属するユーザーは 0 人、どの会社にも所属しない Auth ユーザーも 0 人。
- 試用会社への移行（`info@rugs-reform.jp` を試用会社の owner にする）は実行済み。A 社・B 社・試用会社に 1 人ずつ所属している。
- したがって、制約はそのまま追加できる。

移行 SQL（`~/RAGZ-backup-tools/trial-company-move-user.sql`）への影響:

- 移行 SQL は「DELETE → INSERT」の順で動くので、制約があっても通る（テストで確認した）。
- 「INSERT → DELETE」の順や、所属を残したまま 2 社目に入れる操作は拒否される。

## 3. 本番への適用手順（人間が SQL Editor で行う）

1. 適用前の確認として、`docs/db/function-privileges-precheck.sql` を本番の SQL Editor で実行する（読み取り専用）。
   - `1 function` の行が、§1 の表と同じであること。
   - `2 event_trigger` に `ensure_rls`（`func=rls_auto_enable`・`enabled=O`）があること。
   - `6 counts` の `users_with_2plus_companies = 0` であること。
   - `7 migrations` の最新が `20261016000001` であること。
2. `docs/db/function-privileges-sql-editor-apply.sql` の全文を貼り付けて、1 回だけ実行する。
   - 最後の行の期待値: `history_rows = 1`・`anon_can_create = false`・`authenticated_can_create = false`・`authenticated_can_search = true`・`anon_can_search = false`
   - エラーが出たら `ROLLBACK;` だけを実行して、状況を確認する（この時点では何も変わっていない）。
3. 利用者が少ない時間に、`docs/db/one-company-per-user-sql-editor-apply.sql` の全文を貼り付けて、1 回だけ実行する。
   - 最後の行の期待値: `history_rows = 1`・`constraint_exists = true`・`users_with_2plus_companies = 0`
4. 適用後の確認として、もう一度 1 の確認 SQL を実行する。
   - 対象の関数で PUBLIC・anon が `-` になり、search_path が `public, pg_temp` になっていること。
   - `get_my_company_ids()` の権限は X のまま変わらないこと。
   - `5 company_members` に `UNIQUE (user_id)` があること。
   - `8 storage_policy` が適用前と同じであること。
5. 本番の画面でスモークテストをする（読み取り中心）。
   - ログイン
   - 案件一覧
   - 見積の表示
   - 原価台帳の表示
   - AI チャットの検索（`search_*` を使う）
   - 写真の表示（Storage）
   - 書き込みを試すかどうかは、別途承認を得てから決める。

アプリのコードは変えていないので、デプロイは不要。

## 4. ロールバック

- **関数の権限:** `docs/db/function-privileges-sql-editor-rollback.sql` を使う。
  - 適用前と同じ権限と search_path に戻る（会社作成関数の問題も再発する）。
  - 消えるのは履歴の 1 行だけ。
  - アプリの revert は不要。
- **1 社制約:** `docs/db/one-company-per-user-sql-editor-rollback.sql` を使う。
  - 制約と履歴の 1 行だけを消す。行には触れない。
- **migration ファイルの扱い:** ロールバックした後に migration ファイルが main に残っていると、CLI からは「未適用」に見える。ファイルも revert する PR を作る。

## 5. 検証（ローカルの使い捨て PostgreSQL・架空データのみ）

### `npm run test:db`（`__tests__/db/function-privileges.db.test.ts`）

- **修正前の再現:** authenticated で 2 社目を作れる。anon も実行できる。
- **修正後の否定テスト:**
  - 会社作成関数は anon・authenticated・所属なしの利用者・service_role のすべてで 42501 になる。
  - `rls_auto_enable()` は利用者から直接実行できない。
  - 検索関数は anon で 42501 になる。
  - 他社の ID を渡しても 0 件。
- **回帰テスト:**
  - 所有者は会社作成関数を実行できる。
  - イベントトリガーは、新しい public のテーブルの RLS を有効にし続ける。
  - 検索関数は、authenticated では自社の行を、service_role では従来どおりの結果を返す。
  - `get_my_company_ids()` と、public の RLS（案件・会社・見積・原価台帳）は従来どおり。
  - Storage は自社フォルダのファイルだけが見える。
  - 対象外の関数の権限と RLS ポリシーは変わらない。
- **1 社制約:**
  - 2 社所属のデータがあると止まる。
  - 2 社目の所属は 23505 で拒否される。
  - DELETE → INSERT の移動は通り、逆の順は拒否される。
- **SQL Editor 用スクリプト:**
  - 適用スクリプトの本体が migration と完全に一致する。
  - 二重適用はガードで止まる。
  - イベントトリガーが無い DB・履歴が欠けた DB・検証 DB の目印がある DB では止まる。
  - ロールバックで権限が完全に元に戻る。
  - 2 つのスクリプトは、どちらの順でも適用・ロールバックできる。
- **既存の DB テスト:** 見積・原価台帳・会社間の分離などの既存テストは、すべて新しい migration を含めた全 migration の上で動く。
  - `project-company-match-more` だけは、2 社に所属するユーザーを作る検証なので、1 社制約を除いて適用する。

### 本番スキーマの複製

11/14 のバックアップから schema-only で復元したものに、架空データを入れて確かめた。

- 適用 → 否定テスト → 回帰テスト → 両方のロールバックを通した。
- ロールバック後、権限の集合は適用前と同じになり、問題も再現した。

## 6. 今回は対象外（別途検討）

- `apply_markup_rate_change`（SECURITY INVOKER）も anon が実行できる。RLS で他社の案件は変えられないが、同じ方針で anon から取り消すとよい。
- public の既定の権限（`ALTER DEFAULT PRIVILEGES`）により、今後 public に作る関数には anon・authenticated の EXECUTE が自動で付く。
  - 新しい関数の migration では、`REVOKE ... FROM PUBLIC, anon` を必ず書く（原価台帳の RPC・KI-001 と同じ形）。
- 検索関数を今後 `CREATE OR REPLACE` するときの注意:
  - 本体に `SET search_path` を書かないと、固定が外れる。
  - 権限（ACL）は `CREATE OR REPLACE` しても保たれる。
