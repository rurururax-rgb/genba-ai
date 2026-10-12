#!/usr/bin/env bash
# KI-002 PR-3（20261014000001_enforce_project_company_match_more_tables）適用前の
# 本番 DB 読み取り専用バックアップ。
#
# - 本番 DB に書き込みはしない（pg_dump / SELECT / \copy TO のみ。psql セッションは read only）
# - 対象: public スキーマ（定義＋データ）、supabase_migrations スキーマ、migration 履歴 CSV
#   （Auth・Storage など他スキーマは含まない。完全バックアップではない）
# - 事前確認 ①〜⑧（docs/db/ki-002-pr3-project-company-precheck.sql）を読み取り専用で実行し
#   ki002pr3_precheck.txt に保存する。⑧ は適用直前に SQL Editor でもう一度実行すること
# - 前提確認: 20261013000002 が適用済み・20261014000001 が未適用でなければ停止
# - 接続情報は対話入力。パスワードは画面に出さず、ログ・ファイルにも書かない
# - 既存のバックアップディレクトリは上書きしない（同名があれば停止）
#
# 使い方: bash scripts/db/backup-ki002-pr3.sh
# 復元手順: docs/db/ki-002-pr3-backup-and-restore.md

set -Eeuo pipefail
set +x
umask 077

APPLIED_REQUIRED="20261013000002"
NOT_APPLIED_REQUIRED="20261014000001"
OUT_PARENT="${BACKUP_PARENT_DIR:-$HOME/Desktop}"
OUT_DIR="$OUT_PARENT/rugz-backup-$(date +%Y%m%d-%H%M%S)-pre-ki002-pr3"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRECHECK_SQL="$SCRIPT_DIR/../../docs/db/ki-002-pr3-project-company-precheck.sql"

die() { printf '\n[STOP] %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }
trap 'unset PGPASSWORD; die "想定外のエラーで停止しました（line $LINENO）。出力先: $OUT_DIR"' ERR
trap 'unset PGPASSWORD' EXIT

# ---- 0. ツール確認（libpq は Homebrew で keg-only のため PATH 外にある想定） ----
for d in "${PG_BIN:-}" /opt/homebrew/opt/libpq/bin /opt/homebrew/Cellar/libpq/*/bin /usr/local/opt/libpq/bin; do
  if [[ -n "$d" && -x "$d/pg_dump" ]]; then PATH="$d:$PATH"; break; fi
done
for t in pg_dump pg_restore psql shasum; do
  command -v "$t" >/dev/null || die "$t が見つかりません（brew install libpq / PG_BIN=... を指定）"
done
PG_MAJOR="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
(( PG_MAJOR >= 17 )) || die "pg_dump $PG_MAJOR はサーバー（17.x）より古いため使えません"
info "pg_dump: $(pg_dump --version)"
[[ -s "$PRECHECK_SQL" ]] || die "事前確認 SQL が見つかりません: $PRECHECK_SQL（PR #39 のブランチで実行しているか確認）"
for n in ① ② ③ ④ ⑤ ⑥ ⑦ ⑧; do
  grep -q "^-- $n" "$PRECHECK_SQL" || die "事前確認 SQL に $n がありません"
done
# 事前確認 SQL に書き込み・DDL が無いこと（コメント行を除いて確認）
if grep -v '^[[:space:]]*--' "$PRECHECK_SQL" | sed -E 's/[Oo][Nn] [Dd][Ee][Ll][Ee][Tt][Ee]//g' \
   | grep -qiE '\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|vacuum|lock)\b'; then
  die "事前確認 SQL に書き込み・DDL の可能性がある文があります。実行を中止します"
fi

# ---- 1. 出力先（上書き禁止） ----
[[ -d "$OUT_PARENT" ]] || die "出力先の親ディレクトリがありません: $OUT_PARENT"
[[ ! -e "$OUT_DIR" ]] || die "同名のバックアップが既にあります（上書きしません）: $OUT_DIR"
mkdir "$OUT_DIR"
info "出力先: $OUT_DIR"

# ---- 2. 接続情報（パスワードは非表示入力・環境変数のみに保持） ----
read -rp  'DB host（例: aws-0-xxx.pooler.supabase.com）: ' PGHOST
read -rp  'DB port [5432]: ' PGPORT; PGPORT="${PGPORT:-5432}"
read -rp  'DB user（例: postgres.<project-ref>）: ' PGUSER
read -rsp 'DB password（表示されません）: ' PGPASSWORD; echo
[[ -n "$PGHOST" && -n "$PGUSER" && -n "$PGPASSWORD" ]] || die "接続情報が未入力です"
export PGHOST PGPORT PGUSER PGPASSWORD
export PGDATABASE=postgres PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGAPPNAME=ki002-pr3-backup

# 読み取り専用セッションで 1 クエリ実行（失敗したら停止）
q() {
  psql -X -q -A -t -v ON_ERROR_STOP=1 \
    -c 'SET default_transaction_read_only = on' -c "$1" 2>"$OUT_DIR/.psql.err" \
    || { sed -E 's/password=[^ ]*/password=***/g' "$OUT_DIR/.psql.err" >&2; die "クエリ失敗: ${1:0:60}"; }
}

# ---- 3. 接続確認 ----
[[ "$(q 'select 1')" == "1" ]] || die "DB に接続できません"
q "select 'server_version=' || current_setting('server_version') || ' read_only=' || current_setting('transaction_read_only')" \
  | tee "$OUT_DIR/connection_check.txt"
grep -q 'read_only=on' "$OUT_DIR/connection_check.txt" || die "読み取り専用セッションになっていません"

# ---- 4. migration 適用状態の確認 ----
applied="$(q "select count(*) from supabase_migrations.schema_migrations where version = '$APPLIED_REQUIRED'")"
pending="$(q "select count(*) from supabase_migrations.schema_migrations where version = '$NOT_APPLIED_REQUIRED'")"
total="$(q 'select count(*) from supabase_migrations.schema_migrations')"
printf 'history_rows\t%s\n%s_rows\t%s\n%s_rows\t%s\n' "$total" "$APPLIED_REQUIRED" "$applied" "$NOT_APPLIED_REQUIRED" "$pending" \
  | tee "$OUT_DIR/migration_history_counts.txt"
[[ "$applied" == "1" ]] || die "$APPLIED_REQUIRED が適用されていません（PR-3 の前提を満たさない）"
[[ "$pending" == "0" ]] || die "$NOT_APPLIED_REQUIRED が既に適用済みです（適用前バックアップになりません）"

# ---- 4b. 事前確認 ①〜⑧（読み取り専用セッション。結果をファイルに保存） ----
info "事前確認 ①〜⑧ を実行中（読み取り専用）…"
cp "$PRECHECK_SQL" "$OUT_DIR/ki002pr3_precheck.sql"
psql -X -a -v ON_ERROR_STOP=1 -P pager=off \
  -c 'SET default_transaction_read_only = on' -f "$OUT_DIR/ki002pr3_precheck.sql" \
  > "$OUT_DIR/ki002pr3_precheck.txt" 2>"$OUT_DIR/.psql.err" \
  || { cat "$OUT_DIR/.psql.err" >&2; die "事前確認 ①〜⑧ の実行に失敗"; }
[[ -s "$OUT_DIR/ki002pr3_precheck.txt" ]] || die "ki002pr3_precheck.txt が空です"
for n in ① ② ③ ④ ⑤ ⑥ ⑦ ⑧; do
  grep -q "^-- $n" "$OUT_DIR/ki002pr3_precheck.txt" || die "ki002pr3_precheck.txt に $n の結果がありません"
done
info "事前確認の結果: $OUT_DIR/ki002pr3_precheck.txt（②③④⑧ を手順書の期待値と照合すること）"

# ---- 5. 取得前の行数 ----
q "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1" \
  | LC_ALL=C sort > "$OUT_DIR/public_tables.txt"
[[ -s "$OUT_DIR/public_tables.txt" ]] || die "public テーブル一覧が空です"
count_sql="$(sed -E "s/.*/select '&' || chr(9) || count(*) from public.\"&\"/" "$OUT_DIR/public_tables.txt" | awk 'NR > 1 { printf " union all " } { printf "%s", $0 }') order by 1"
q "$count_sql" | LC_ALL=C sort > "$OUT_DIR/public_rowcounts.txt"

# ---- 6. pg_dump（custom 形式・読み取りのみ） ----
info "public スキーマを取得中…"
pg_dump -Fc --no-password -n public -f "$OUT_DIR/public.dump" 2>"$OUT_DIR/.pg_dump.err" \
  || { cat "$OUT_DIR/.pg_dump.err" >&2; die "public の pg_dump に失敗"; }
info "supabase_migrations スキーマを取得中…"
pg_dump -Fc --no-password -n supabase_migrations -f "$OUT_DIR/supabase_migrations.dump" 2>"$OUT_DIR/.pg_dump.err" \
  || { cat "$OUT_DIR/.pg_dump.err" >&2; die "supabase_migrations の pg_dump に失敗"; }
q "\\copy (select * from supabase_migrations.schema_migrations order by version) to '$OUT_DIR/schema_migrations.csv' with csv header" >/dev/null
q "select tablename || chr(9) || policyname || chr(9) || cmd || chr(9) || coalesce(qual,'') || chr(9) || coalesce(with_check,'') from pg_policies where schemaname='public' order by 1,2" \
  > "$OUT_DIR/policies.txt"

# ---- 7. ファイル検証（存在・容量・形式・内容） ----
for f in public.dump supabase_migrations.dump schema_migrations.csv; do
  [[ -s "$OUT_DIR/$f" ]] || die "$f が無いか 0 バイトです"
done
for f in public.dump supabase_migrations.dump; do
  [[ "$(head -c 5 "$OUT_DIR/$f")" == "PGDMP" ]] || die "$f が pg_dump custom 形式ではありません"
  pg_restore -l "$OUT_DIR/$f" > "$OUT_DIR/${f%.dump}.toc.txt" || die "$f の TOC を読めません"
done
(( $(du -k "$OUT_DIR/public.dump" | cut -f1) >= 50 )) || die "public.dump が小さすぎます（50KB 未満）"
while read -r t; do
  grep -qE "TABLE DATA public $t " "$OUT_DIR/public.toc.txt" || die "public.dump に $t のデータがありません"
done < "$OUT_DIR/public_tables.txt"
grep -q 'TABLE DATA supabase_migrations schema_migrations ' "$OUT_DIR/supabase_migrations.toc.txt" \
  || die "supabase_migrations.dump に schema_migrations のデータがありません"

# dump 内の行数を数えて取得前の行数と照合
pg_restore -a -f - "$OUT_DIR/public.dump" | awk '
  /^COPY public\./ { split($2, a, "."); gsub(/"/, "", a[2]); t = a[2]; n[t] = 0; inb = 1; next }
  inb && /^\\\.$/ { inb = 0; next }
  inb { n[t]++ }
  END { for (k in n) printf "%s\t%d\n", k, n[k] }' | LC_ALL=C sort > "$OUT_DIR/public_rowcounts_dump.txt"
diff -q "$OUT_DIR/public_rowcounts.txt" "$OUT_DIR/public_rowcounts_dump.txt" >/dev/null \
  || { diff "$OUT_DIR/public_rowcounts.txt" "$OUT_DIR/public_rowcounts_dump.txt" >&2 || true;
       die "取得前の行数と dump 内の行数が一致しません（取得中に書き込みがあった可能性。再実行してください）"; }
csv_rows=$(( $(pg_restore -a -f - "$OUT_DIR/supabase_migrations.dump" | awk '/^COPY supabase_migrations.schema_migrations/{f=1;next} f&&/^\\\.$/{f=0} f{c++} END{print c+0}') ))
[[ "$csv_rows" == "$total" ]] || die "supabase_migrations.dump の履歴行数（$csv_rows）が $total と一致しません"

# ---- 8. チェックサム ----
rm -f "$OUT_DIR/.psql.err" "$OUT_DIR/.pg_dump.err"
( cd "$OUT_DIR" && shasum -a 256 -- *.dump *.csv *.txt *.sql > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null ) \
  || die "チェックサムの作成・検証に失敗"
chmod 600 "$OUT_DIR"/*

printf '\n[OK] バックアップ完了: %s\n' "$OUT_DIR"
printf '[NEXT] ki002pr3_precheck.txt の ②③④⑧ を確認し、適用直前に SQL Editor で ⑧ を再実行すること\n'
ls -l "$OUT_DIR"
