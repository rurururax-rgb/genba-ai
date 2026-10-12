#!/usr/bin/env bash
# 開発サーバーの起動記録・状態確認・安全停止。運用ルールは CLAUDE.md「Local Dev Server 運用ルール」。
#   start [next dev の引数]  記録を書いてから npm run dev を起動（フォアグラウンド）
#   status                   3000-3010 番ポート / next プロセス / 管理記録を表示（何も変更しない）
#   stop [--pid N | --all]   自分（claude/human）が start した記録済みサーバーだけを停止
set -u
export LC_ALL=C

PORT_MIN=3000
PORT_MAX=3010
TERM_WAIT_SEC=10

die() { echo "エラー: $*" >&2; exit 1; }

TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || die "git リポジトリ内で実行してください"
TOPLEVEL=$(cd "$TOPLEVEL" && pwd -P)
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir) || die "git common dir を取得できません"
# .git/ 配下なので Git 管理対象外、かつ全 worktree で共有される
REG_DIR="$COMMON_DIR/dev-servers"

ACTOR=human
[ "${CLAUDECODE:-}" = "1" ] && ACTOR=claude

# ── プロセス情報 ─────────────────────────────────────────────
proc_alive()  { ps -p "$1" >/dev/null 2>&1; }
proc_lstart() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
proc_cwd()    { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
proc_cmd()    { ps -o command= -p "$1" 2>/dev/null | cut -c1-70; }
proc_ports()  { lsof -nP -a -p "$1" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n.*://p' | sort -u | tr '\n' ' '; }

descendants() {
  local table queue next p c
  table=$(ps -axo pid=,ppid=)
  queue="$1"
  while [ -n "$queue" ]; do
    next=""
    for p in $queue; do
      for c in $(echo "$table" | awk -v pp="$p" '$2 == pp { print $1 }'); do
        echo "$c"
        next="$next $c"
      done
    done
    queue=$next
  done
}

listener_pids() {
  lsof -nP -iTCP:"$PORT_MIN-$PORT_MAX" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | sort -un
}

next_pids() {
  # シェルのラッパー（zsh -c '... next dev ...' 等）はコマンド文字列に一致するだけなので除外
  ps -axo pid=,command= | awk '
    /awk/ { next }
    $2 ~ /(^|\/)-?(ba|z)?sh$/ && $3 == "-c" { next }
    /next-server|next\/dist\/bin\/next|\/\.bin\/next( |$)|(^|[ \/])next (dev|start)( |$)/ { print $1 }'
}

in_list() { local x="$1"; shift; for y in "$@"; do [ "$x" = "$y" ] && return 0; done; return 1; }

# 親をたどって launchd(PID 1) に直接ぶら下がっていれば孤立（親セッションが異常終了した可能性）
is_orphaned() {
  local p="$1" pp i=0
  while [ $i -lt 20 ]; do
    pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -z "$pp" ] && return 1
    [ "$pp" = 1 ] && return 0
    case "$(ps -o command= -p "$pp" 2>/dev/null)" in
      *npm*|*node*|*next*|*"sh -c"*|*/zsh|*/bash|zsh|bash) p=$pp ;;
      *) return 1 ;;
    esac
    i=$((i + 1))
  done
  return 1
}

# ── worktree 判定 ────────────────────────────────────────────
worktree_paths() {
  git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r p; do
    (cd "$p" 2>/dev/null && pwd -P) || echo "$p"
  done
}
MAIN_WT=$(worktree_paths | head -1)

wt_branch() { git -C "$1" branch --show-current 2>/dev/null || true; }

# 最長一致で所属 worktree を返す（他プロジェクトなら空）
owning_worktree() {
  local d="$1" wt best=""
  [ -z "$d" ] && return
  while IFS= read -r wt; do
    case "$d/" in
      "$wt"/*) [ ${#wt} -gt ${#best} ] && best="$wt" ;;
    esac
  done <<EOF
$(worktree_paths)
EOF
  echo "$best"
}

classify_dir() {
  local wt
  [ -z "$1" ] && { echo "不明（作業フォルダ取得不可）"; return; }
  wt=$(owning_worktree "$1")
  if [ -z "$wt" ]; then
    echo "他プロジェクト（操作対象外）"
  elif [ "$wt" = "$MAIN_WT" ]; then
    echo "本体 $(basename "$wt") [$(wt_branch "$wt")]"
  else
    echo "worktree $(basename "$wt") [$(wt_branch "$wt")]"
  fi
}

# Next.js の .next/dev/lock は補助情報。停止可否の唯一の根拠にはしない
lock_pid() { [ -f "$1/.next/dev/lock" ] && sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$1/.next/dev/lock" | head -1; }
lock_url() { [ -f "$1/.next/dev/lock" ] && sed -n 's/.*"appUrl": *"\([^"]*\)".*/\1/p' "$1/.next/dev/lock" | head -1; }

# ── 管理記録 ─────────────────────────────────────────────────
field() { sed -n "s/^$2=//p" "$1" | head -1; }

# running / gone / reused / cwd_mismatch / cmd_mismatch / incomplete
record_state() {
  local f="$1" pid lstart cwd
  pid=$(field "$f" pid); lstart=$(field "$f" lstart); cwd=$(field "$f" cwd)
  case "$pid" in ''|*[!0-9]*) echo incomplete; return ;; esac
  if [ "$pid" != "$(basename "$f" .rec)" ] || [ -z "$lstart" ] || [ -z "$cwd" ] || [ -z "$(field "$f" started_by)" ]; then
    echo incomplete; return
  fi
  proc_alive "$pid" || { echo gone; return; }
  [ "$(proc_lstart "$pid")" = "$lstart" ] || { echo reused; return; }
  [ "$(proc_cwd "$pid")" = "$cwd" ] || { echo cwd_mismatch; return; }
  case "$(proc_cmd "$pid")" in *npm*|*node*|*next*) ;; *) echo cmd_mismatch; return ;; esac
  echo running
}

state_label() {
  case "$1" in
    running)      echo "稼働中" ;;
    gone)         echo "プロセスなし（異常終了の可能性）" ;;
    reused)       echo "起動時刻不一致（PID 再利用の可能性）" ;;
    cwd_mismatch) echo "作業フォルダ不一致" ;;
    cmd_mismatch) echo "コマンド不一致" ;;
    *)            echo "記録不完全" ;;
  esac
}

managed_tree_pids() {
  local f
  [ -d "$REG_DIR" ] || return 0
  for f in "$REG_DIR"/*.rec; do
    [ -e "$f" ] || continue
    if [ "$(record_state "$f")" = running ]; then
      basename "$f" .rec
      descendants "$(basename "$f" .rec)"
    fi
  done
}

# ── status ───────────────────────────────────────────────────
cmd_status() {
  local managed p f pid st wt shown="" orphans=""
  managed=$(managed_tree_pids | tr '\n' ' ')
  for p in $(next_pids); do is_orphaned "$p" && orphans="$orphans $p"; done
  # 孤立した親の子（next-server 等）も孤立扱いにする
  for p in $orphans; do orphans="$orphans $(descendants "$p" | tr '\n' ' ')"; done

  if [ -n "$(echo $orphans)" ]; then
    echo "!! 警告: 孤立した Next.js プロセスがあります（親セッションが終了済み）:$(echo " $orphans" | tr -s ' ')"
    echo "!!       自動停止はしません。下の一覧で作業フォルダを確認し、不要なら手動で kill してください"
  fi

  echo "== ${PORT_MIN}-${PORT_MAX} 番ポートの待ち受け =="
  local any=0
  for p in $(listener_pids); do
    any=1
    printf '  PID %-6s port %-6s %s%s%s\n    %s\n' "$p" "$(proc_ports "$p")" "$(classify_dir "$(proc_cwd "$p")")" \
      "$(in_list "$p" $managed && echo '  ★管理対象' || echo '  （未管理）')" \
      "$(in_list "$p" $orphans && echo '  ⚠孤立')" "$(proc_cmd "$p")"
    shown="$shown $p"
  done
  [ $any = 0 ] && echo "  なし"

  echo "== その他の Next.js プロセス（ポートなし含む）=="
  any=0
  for p in $(next_pids); do
    in_list "$p" $shown && continue
    any=1
    printf '  PID %-6s %s%s%s\n    %s\n' "$p" "$(classify_dir "$(proc_cwd "$p")")" \
      "$(in_list "$p" $managed && echo '  ★管理対象' || echo '  （未管理）')" \
      "$(in_list "$p" $orphans && echo '  ⚠孤立')" "$(proc_cmd "$p")"
  done
  [ $any = 0 ] && echo "  なし"

  echo "== 管理記録（dev:start で起動したもの）=="
  any=0
  if [ -d "$REG_DIR" ]; then
    for f in "$REG_DIR"/*.rec; do
      [ -e "$f" ] || continue
      any=1
      pid=$(basename "$f" .rec); st=$(record_state "$f")
      printf '  PID %-6s %s / started_by=%s / %s\n    %s\n' "$pid" "$(state_label "$st")" \
        "$(field "$f" started_by)" "$(field "$f" started_at)" "$(classify_dir "$(field "$f" cwd)")"
      if [ "$st" = running ]; then
        local ports=""
        for p in $pid $(descendants "$pid"); do ports="$ports$(proc_ports "$p")"; done
        echo "    port: ${ports:-（待ち受けなし／起動中）}"
      elif [ "$st" != incomplete ] && [ "$st" != cwd_mismatch ] && [ "$st" != cmd_mismatch ]; then
        echo "    → npm run dev:stop で記録を整理できます"
      fi
    done
  fi
  [ $any = 0 ] && echo "  なし"

  echo "== Next.js lock（補助情報）=="
  any=0
  while IFS= read -r wt; do
    p=$(lock_pid "$wt")
    [ -z "$p" ] && continue
    any=1
    echo "  $(classify_dir "$wt"): lock PID $p $(proc_alive "$p" && echo '稼働中' || echo '停止済み') $(lock_url "$wt")"
  done <<EOF
$(worktree_paths)
EOF
  [ $any = 0 ] && echo "  なし"
  echo "（lsof は自分のユーザーのプロセスのみ表示します）"
}

# ── start ────────────────────────────────────────────────────
cmd_start() {
  local p tmp lstart
  cd "$TOPLEVEL" || die "cd 失敗: $TOPLEVEL"
  for p in $(next_pids) $(listener_pids); do
    if [ "$(proc_cwd "$p")" = "$TOPLEVEL" ]; then
      die "この作業フォルダでは既に PID $p が動いています（npm run dev:status で確認）。新規起動しません"
    fi
  done
  mkdir -p "$REG_DIR" || die "記録ディレクトリを作成できません: $REG_DIR"
  lstart=$(proc_lstart $$)
  [ -n "$lstart" ] || die "自プロセスの起動時刻を取得できません"
  tmp=$(mktemp "$REG_DIR/.tmp.XXXXXX") || die "記録ファイルを作成できません"
  {
    echo "pid=$$"
    echo "lstart=$lstart"
    echo "cwd=$TOPLEVEL"
    echo "branch=$(wt_branch "$TOPLEVEL")"
    echo "started_by=$ACTOR"
    echo "started_at=$(date '+%Y-%m-%d %H:%M:%S')"
    echo "command=npm run dev $*"
  } > "$tmp" && mv "$tmp" "$REG_DIR/$$.rec" || { rm -f "$tmp"; die "記録の書き込みに失敗しました"; }
  echo "[dev-server] 記録しました: PID $$ / started_by=$ACTOR / $(classify_dir "$TOPLEVEL")"
  echo "[dev-server] 停止: npm run dev:stop -- --pid $$"
  # exec で PID・起動時刻・作業フォルダを記録どおりに保ったまま npm に置き換える
  exec npm run dev -- "$@"
}

# ── stop ─────────────────────────────────────────────────────
report_leftovers() {
  local cwd="$1" label="$2" p left=""
  for p in $(next_pids); do [ "$(proc_cwd "$p")" = "$cwd" ] && left="$left $p"; done
  [ -n "$left" ] && echo "$label: 同じ作業フォルダに Next.js プロセスが残っています:$left（未管理のため停止しません・要確認）"
  return 0
}

# snap（"PID=起動時刻 ..."）に控えた起動時刻と現在の起動時刻が一致すれば同一プロセス
same_proc() {
  local want now
  want=$(echo " $2" | sed -n "s/.* $1=\([^ ]*\).*/\1/p")
  [ -n "$want" ] || return 1
  now=$(proc_lstart "$1" | tr ' ' '_')
  [ -n "$now" ] && [ "$now" = "$want" ]
}

stop_one() {
  local f="$1" pid cwd st tree p c lp waited alive snap="" sent=""
  pid=$(basename "$f" .rec); cwd=$(field "$f" cwd); st=$(record_state "$f")
  case "$st" in
    gone)
      echo "PID $pid: プロセスなし（異常終了または手動停止）→ 記録のみ削除"
      rm -f "$f"; report_leftovers "$cwd" "PID $pid"; return 0 ;;
    reused)
      echo "PID $pid: 起動時刻が記録と不一致（PID 再利用の可能性）→ 停止せず記録のみ削除"
      rm -f "$f"; report_leftovers "$cwd" "PID $pid"; return 0 ;;
    running) ;;
    *)
      echo "PID $pid: $(state_label "$st") → 停止しません。記録を確認してください: $f"
      return 1 ;;
  esac

  tree="$pid $(descendants "$pid" | tr '\n' ' ')"
  for p in $tree; do
    # 各 PID の起動時刻を控え、kill 直前と待機中に同一プロセスか再確認する（PID 再利用対策）
    snap="$snap$p=$(proc_lstart "$p" | tr ' ' '_') "
    [ "$p" = "$pid" ] && continue
    c=$(proc_cwd "$p")
    if [ -z "$c" ] && proc_alive "$p"; then
      echo "PID $pid: 子プロセス $p の作業フォルダを確認できません → 停止しません"
      return 1
    fi
    if [ -n "$c" ] && [ "$c" != "$cwd" ]; then
      echo "PID $pid: 子プロセス $p の作業フォルダが不一致（$c）→ 停止しません"
      return 1
    fi
  done
  lp=$(lock_pid "$cwd")
  if [ -n "$lp" ] && proc_alive "$lp" && ! in_list "$lp" $tree; then
    echo "PID $pid: Next.js lock の PID $lp が管理プロセスの子孫ではありません → 停止しません"
    return 1
  fi

  echo "PID $pid: 停止します（$(classify_dir "$cwd") / 対象 PID: $tree）"
  for p in $tree; do
    if same_proc "$p" "$snap"; then
      kill -TERM "$p" 2>/dev/null && sent="$sent $p"
    fi
  done

  waited=0
  while :; do
    alive=""
    for p in $sent; do same_proc "$p" "$snap" && alive="$alive $p"; done
    [ -z "$alive" ] && break
    [ $waited -ge $TERM_WAIT_SEC ] && break
    sleep 1; waited=$((waited + 1))
  done
  if [ -n "$alive" ]; then
    echo "PID $pid: ${TERM_WAIT_SEC} 秒後も残っています:$alive → 強制終了はしません。記録は残します"
    return 1
  fi

  report_leftovers "$cwd" "PID $pid"
  rm -f "$f"
  echo "PID $pid: 停止完了"
}

cmd_stop() {
  local mode=current target="" f pid rc=0 matched=0 cwd
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) mode=all ;;
      --pid) shift; target="${1:-}"; mode=pid
             case "$target" in ''|*[!0-9]*) die "--pid には数値を指定してください" ;; esac ;;
      *) die "不明なオプション: $1" ;;
    esac
    shift
  done
  if [ -d "$REG_DIR" ]; then
    for f in "$REG_DIR"/*.rec; do
      [ -e "$f" ] || continue
      pid=$(basename "$f" .rec); cwd=$(field "$f" cwd)
      case "$mode" in
        current) [ "$cwd" = "$TOPLEVEL" ] || continue ;;
        pid)     [ "$pid" = "$target" ] || continue ;;
      esac
      if [ "$(field "$f" started_by)" != "$ACTOR" ] && [ "$(record_state "$f")" = running ]; then
        echo "PID $pid: started_by=$(field "$f" started_by) のため停止しません（自分が起動したもののみ停止）"
        matched=1
        [ "$mode" = pid ] && rc=1
        continue
      fi
      matched=1
      stop_one "$f" || rc=1
    done
  fi
  if [ $matched = 0 ]; then
    [ "$mode" = pid ] && { echo "PID $target の管理記録はありません。停止しません"; return 1; }
    echo "停止対象の管理記録はありません（$( [ "$mode" = all ] && echo 'このリポジトリ全体' || classify_dir "$TOPLEVEL")）"
  fi
  return $rc
}

case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  status) cmd_status ;;
  stop)   shift; cmd_stop "$@" ;;
  *) echo "使い方: $0 {start [next dev の引数] | status | stop [--pid N | --all]}" >&2; exit 2 ;;
esac
