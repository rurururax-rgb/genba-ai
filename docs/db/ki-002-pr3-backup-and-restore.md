# KI-002 PR-3 適用前バックアップと復元手順

- スクリプト: `scripts/db/backup-ki002-pr3.sh`
- **実行は人間が行う。** Claude Code は本番 DB への接続・バックアップの実行・復元のどれも行わない。
- PR-3 の適用手順全体は `ki-002-pr3-project-company-match.md` を参照。

> **これは完全バックアップではない。**
> 対象は `public` スキーマ（定義・データ）と `supabase_migrations`（migration 履歴）だけ。
> Supabase の **Auth（`auth` スキーマ: ユーザー・セッション）、Storage（`storage` スキーマのメタデータと
> バケット内のファイル本体）**、その他のスキーマ・ロール・拡張設定は含まない。
> PR-3 が変更するのは public の 12 テーブルの制約だけなので、適用前の退避としてはこの範囲で足りる。
> Auth・Storage まで含めた復旧が必要な場合は、Supabase ダッシュボードの日次バックアップ（または PITR）を使う。

## バックアップが行うこと

すべて読み取りのみ。本番 DB のデータ・定義は変更しない。

| 手順 | 内容 | 失敗時 |
|---|---|---|
| 0 | `pg_dump` / `pg_restore` / `psql`（17 以上）を探す | 停止 |
| 1 | `~/Desktop/rugz-backup-<日時>-pre-ki002-pr3/` を新しく作る。同名があれば上書きせず停止 | 停止 |
| 2 | 接続情報を対話入力。パスワードは非表示で入力し、環境変数にだけ保持して終了時に消す | 停止 |
| 3 | 接続確認。psql セッションは `default_transaction_read_only = on` | 停止 |
| 4 | migration 履歴: `20261013000002` = 1 行、`20261014000001` = 0 行 | 停止 |
| 4b | 事前確認 ①〜⑧（`ki-002-pr3-project-company-precheck.sql`）を読み取り専用セッションで実行し `ki002pr3_precheck.txt` に保存。実行前に SQL に書き込み・DDL が無いことを確かめる | 停止 |
| 5 | public テーブル一覧と行数を記録 | 停止 |
| 6 | `pg_dump -Fc` で public・supabase_migrations を取得。履歴 CSV と RLS ポリシー一覧も保存 | 停止 |
| 7 | ファイルの存在・容量・形式（先頭 `PGDMP`・`pg_restore -l`）・全テーブルのデータ有無・行数の一致を確認 | 停止 |
| 8 | `SHA256SUMS` を作り、その場で照合 | 停止 |

最後に `[OK] バックアップ完了` が出たときだけ PR-3 の適用に進む。`[STOP]` が出たら適用しない。

スクリプトは ①〜⑧ の結果を**保存するだけで、合否は判定しない**（② の migration 履歴だけは手順 4 で自動判定する）。
`ki002pr3_precheck.txt` の ②③④⑧ を `ki-002-pr3-project-company-match.md` の期待値の表と照合する。

**⑧ は適用直前にもう一度実行する。** バックアップ時点の ⑧ は記録にすぎず、適用までの間に
長いトランザクションが始まっている可能性がある。適用の直前に SQL Editor で ⑧ だけを実行し、0 行であることを確かめる。

### 出力ファイル

| ファイル | 内容 |
|---|---|
| `public.dump` | public スキーマの定義とデータ（custom 形式） |
| `supabase_migrations.dump` | migration 履歴スキーマ（custom 形式） |
| `schema_migrations.csv` | migration 履歴（目視用） |
| `public.toc.txt` / `supabase_migrations.toc.txt` | dump の目次 |
| `public_tables.txt` / `public_rowcounts.txt` / `public_rowcounts_dump.txt` | テーブル一覧、取得前の行数、dump 内の行数 |
| `migration_history_counts.txt` | 履歴の総数と、前提 2 件の有無 |
| `ki002pr3_precheck.txt` | 事前確認 ①〜⑧ の SQL と結果（バックアップ時点） |
| `ki002pr3_precheck.sql` | 実行した事前確認 SQL の写し |
| `connection_check.txt` | サーバーバージョンと read only の確認 |
| `policies.txt` | public の RLS ポリシー |
| `SHA256SUMS` | 上記のチェックサム |

ファイルの権限は 600（自分だけ読める）。GitHub・チャットに貼らない。

## 実行前の準備

1. `brew install libpq`（済みなら不要）。keg-only なので PATH 追加は不要。スクリプトが自動で探す。
2. Supabase ダッシュボード → Project Settings → Database → Connection string で、
   **Session pooler**（ポート 5432）の host と user（`postgres.<project-ref>`）を確認する。
   Transaction pooler（6543）は使わない。
3. DB パスワードを用意する（パスワードマネージャーから貼り付け。チャット・メモに書かない）。
4. Desktop に十分な空き容量があること（前回の dump は合計 200KB 程度）。
5. LINE からの書き込みが少ない時間帯に実行する。取得中に行が増えると行数の照合で停止する（その場合は再実行）。

## 実行

スクリプトと事前確認 SQL は PR #39 のブランチ（`fix/ki-002-pr3-project-company-fk`）にある。
main にはまだ無いので、**このブランチをチェックアウトした作業ディレクトリ**で実行する。
スクリプトは自分の場所から `docs/db/ki-002-pr3-project-company-precheck.sql` を探し、見つからなければ接続前に停止する。

ターミナル.app で:

```bash
cd ~/genba-ai
git switch fix/ki-002-pr3-project-company-fk
git pull --ff-only
bash scripts/db/backup-ki002-pr3.sh
```

host・port・user・password を聞かれる。password は入力しても表示されない。

## 復元手順（PR-3 適用後に問題が出たとき）

まず `ki-002-pr3-project-company-sql-editor-rollback.sql` によるロールバックを使う。
ロールバックは追加した制約と履歴 1 行だけを消すので、通常はこれで足りる。
**以下のダンプからの復元は、データが壊れた・失われたときの最終手段**であり、必ず人間が判断して実行する。

### 1. バックアップの健全性を確認する

```bash
cd ~/Desktop/rugz-backup-<日時>-pre-ki002-pr3
shasum -a 256 -c SHA256SUMS
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
pg_restore -l public.dump | head
```

### 2. まず別環境で試す

本番に戻す前に、ローカルや検証用 Supabase プロジェクトで復元できることを確かめる。

```bash
pg_restore --no-owner --no-privileges -d "<検証用DB>" public.dump
```

### 3. 特定テーブルのデータだけ戻す（推奨）

失われた行だけを戻す場合は、dump から対象テーブルを一時スキーマに戻して比べ、必要な行だけ SQL で戻す。

```bash
# 対象テーブルのデータを SQL として取り出す（DB には触れない）
pg_restore -a -t <テーブル名> -f <テーブル名>.sql public.dump
```

取り出した SQL を見て、必要な行だけ本番に戻す。全件上書きはしない。

### 4. public スキーマ全体を戻す（最終手段）

本番のデータを dump 時点に戻すので、それ以降の書き込み（LINE・見積など）は失われる。
実行前に、その時点の本番を同じスクリプトでもう一度バックアップする（出力先は別ディレクトリになる）。

```bash
pg_restore --clean --if-exists --single-transaction --no-owner \
  -n public -d "<本番接続。パスワードは PGPASSWORD で渡す>" public.dump
```

- `--single-transaction` なので、途中で失敗したら何も変わらない。
- 復元後に migration 履歴が dump 時点と一致しているか `schema_migrations.csv` と比べる。
  一致しない場合は supabase_migrations.dump を同様に戻すか、履歴の行だけ SQL で直す。
- 復元後、`ki-002-pr3-project-company-precheck.sql` の ②③④⑦ を実行して状態を確かめる。
- この dump に Auth・Storage は含まれない。ユーザーや写真ファイルが失われた場合は Supabase のバックアップ（日次 / PITR）から戻す。
