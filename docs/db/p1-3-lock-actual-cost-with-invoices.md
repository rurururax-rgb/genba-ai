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

## 適用後の確認 SQL（読み取りのみ）

```sql
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.cost_ledger_items'::regclass AND tgname = 'cost_ledger_items_lock_actual_cost';

SELECT prosecdef, proconfig FROM pg_proc
WHERE oid = 'public.cost_ledger_items_lock_actual_cost()'::regprocedure;

SELECT r, has_function_privilege(r, 'public.cost_ledger_items_lock_actual_cost()', 'EXECUTE')
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
```

## ロールバック

```sql
DROP TRIGGER IF EXISTS cost_ledger_items_lock_actual_cost ON public.cost_ledger_items;
DROP FUNCTION IF EXISTS public.cost_ledger_items_lock_actual_cost();
```
