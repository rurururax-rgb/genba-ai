# P1-3: 請求書がある台帳項目の actual_cost を DB で保護する（未適用）

migration: `supabase/migrations/20261011000001_lock_actual_cost_with_invoices.sql`

**状態: 本番未適用。適用は人間の承認後に行う。** PR #32 のアプリ変更はこの migration が無くても動く
（アプリ側の件数確認のみで保護している状態）。

## 何をするか

`cost_ledger_items` に `BEFORE UPDATE OF actual_cost` トリガーを追加する。
請求書が1件以上ある項目で、actual_cost を請求書の合計以外の値に変える UPDATE を
SQLSTATE `CL423`（`actual_cost_locked`）で拒否する。API は 409 `actual_cost_locked` に変換する
（`lib/cost-ledger/rpc-errors.ts`）。

| 書き込み | 適用前 | 適用後 |
|---|---|---|
| 請求書0件の項目の直接入力 | 可 | 可（変わらない） |
| RPC `cost_ledger_invoice_*` | 可 | 可（常に合計を書くため） |
| 画面・API・AI確定からの直接変更（請求書あり） | アプリの件数確認で 409 | 同左 + DB でも拒否 |
| 件数確認と書き込みの間に請求書が登録される競合 | **すり抜ける** | 拒否 |
| PostgREST からの `cost_ledger_items` 直接 UPDATE | **すり抜ける** | 拒否 |
| PostgREST からの `cost_ledger_invoices` 直接 INSERT/UPDATE/DELETE | 合計とずれうる | **ずれうる（この migration の対象外）** |

テーブル・列・RLS ポリシー・既存データは変更しない。既存の不整合データ（請求書があるのに
actual_cost が合計と違う行）も修正しない。その行も actual_cost 以外の列は従来どおり更新でき、
RPC で請求書を操作した時点で合計に揃う。

## 検証（隔離 DB）

`npm run test:db`。`__tests__/db/lock-actual-cost.db.test.ts` がローカルの使い捨て PostgreSQL に
P1-1 → P1-2 → P1-3 を適用して確かめる（本番・Preview には接続しない）。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。P1-2 と同じく、SQL Editor 専用のスクリプトで適用する。

| ファイル | 内容 |
|---|---|
| `docs/db/p1-3-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 を 1 トランザクション（BEGIN / COMMIT）で実行 |
| `docs/db/p1-3-sql-editor-rollback.sql` | トリガー・関数・履歴 1 行の削除を 1 トランザクションで実行 |

適用スクリプトの `-- >>> MIGRATION BODY` 〜 `-- <<< MIGRATION BODY` は migration ファイルと
1 文字も違わないことを `npm run test:db` で照合している（どちらかだけ直すとテストが落ちる）。

### 1. 適用前の確認（読み取りのみ）

```sql
-- 期待値: p13_history = 0, p12_history = 1, rpc_insert = true, p13_trigger = 0, p13_function = 0
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261011000001') AS p13_history,
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') AS p12_history,
  to_regprocedure('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)') IS NOT NULL AS rpc_insert,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal) AS p13_trigger,
  (SELECT count(*) FROM pg_proc WHERE proname = 'cost_ledger_items_lock_actual_cost') AS p13_function;

-- 参考: 請求書があるのに actual_cost が合計と違う既存行（適用しても修正されない。件数を記録しておく）
SELECT count(*) FROM public.cost_ledger_items i
WHERE i.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = i.id)
  AND i.actual_cost IS DISTINCT FROM
      (SELECT sum(v.amount) FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = i.id);
```

期待値と違う場合は適用しない（スクリプトのガードも同じ条件で止まる）。

### 2. 適用

`p1-3-sql-editor-apply.sql` の全文を貼り付けて 1 回だけ実行する。

- 最後の結果が `history_rows = 1, triggers = 1, functions = 1` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。トランザクション全体が取り消されるので、
  関数・トリガー・履歴のどれも残らない（部分適用にならない）。
- ガードで止まる条件（`P1-3 apply aborted: ...`）:
  履歴テーブルが無い / 20261011000001 が登録済み（二重適用） / P1-2（20261010000002）が未登録 /
  同名の関数・トリガーが履歴なしで既にある。
- `cost_ledger_items` のロック待ちは 5 秒で打ち切る（`55P03`）。台帳への書き込みが少ない時間に再実行する。
- トランザクション内の検証で止まる条件（`P1-3 verify failed: ...`）:
  関数が SECURITY DEFINER でない / `search_path` が空でない / PUBLIC・anon・authenticated・service_role
  に EXECUTE がある / トリガーが「有効・BEFORE・行単位・UPDATE OF actual_cost のみ・WHEN 条件つき」の
  1 つでない。

### 3. 適用後の確認（読み取りのみ）

```sql
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.cost_ledger_items'::regclass AND tgname = 'cost_ledger_items_lock_actual_cost';

SELECT prosecdef, proconfig FROM pg_proc
WHERE oid = 'public.cost_ledger_items_lock_actual_cost()'::regprocedure;

SELECT r, has_function_privilege(r, 'public.cost_ledger_items_lock_actual_cost()', 'EXECUTE')
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
```

## ロールバック

`p1-3-sql-editor-rollback.sql` の全文を SQL Editor で実行する（人間の承認後）。

- トリガー・関数の削除と、migration 履歴（20261011000001 の 1 行だけ）の削除を 1 トランザクションで行う。
  最後の結果が `history_rows = 0, triggers = 0, functions = 0` なら完了。エラー時は `ROLLBACK;` だけを実行する。
- テーブル・業務データ・RLS・P1-1 / P1-2 の関数と履歴には触れない（`npm run test:db` で確認）。
- 何も適用されていなければ `P1-3 rollback aborted: nothing to roll back` で止まる。
- アプリ（PR #32）はトリガーが無くても動く。ロールバック後は、請求書がある項目の直接変更をアプリ側の
  件数確認だけで止める状態（上の表の「適用前」）に戻る。
- 履歴を消した後も migration ファイルが main に残っていると CLI からは「未適用」に見える。
  再適用しないなら migration ファイルも revert する。再適用するなら適用スクリプトをもう一度実行できる。
