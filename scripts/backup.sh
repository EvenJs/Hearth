#!/usr/bin/env bash
# M1-7 备份：pg_dump -Fc → ~/hearth-backups/hearth-YYYY-MM-DD.dump，只保留最近 12 份
# 连接串只从仓库外的 ~/.config/hearth/backup.env 读，必须是 Neon 只读角色（tech-stack 第 10 节）
# 兼容 macOS 自带的 bash 3.2：不用 mapfile、关联数组
set -euo pipefail

ENV_FILE="$HOME/.config/hearth/backup.env"
BACKUP_DIR="$HOME/hearth-backups"
KEEP=12

die() {
  printf '\n错误：%s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}
warn() { printf '注意：%s\n' "$*" >&2; }

pg_major() { "$1" --version 2>/dev/null | sed -n 's/.*(PostgreSQL) \([0-9][0-9]*\).*/\1/p'; }

# ---------- 1. 找 pg_dump ----------
# Homebrew 的 postgresql@N 默认不 link 到 PATH，所以把常见位置都找一遍，取版本最高的
PG_BIN=""
best=0
for cand in \
  "$(command -v pg_dump 2>/dev/null || true)" \
  /opt/homebrew/opt/postgresql@*/bin/pg_dump \
  /usr/local/opt/postgresql@*/bin/pg_dump \
  /Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  v="$(pg_major "$cand")"
  [ -n "$v" ] || continue
  if [ "$v" -gt "$best" ]; then
    best="$v"
    PG_BIN="$(dirname "$cand")"
  fi
done

[ -n "$PG_BIN" ] || die "本机没有找到 pg_dump。" \
  "安装：brew install postgresql@18（18 换成 Neon 上 SHOW server_version; 查到的主版本）" \
  "装完不需要 brew link，脚本会自己找到 Homebrew 装的版本。"

PG_DUMP="$PG_BIN/pg_dump"
PG_RESTORE="$PG_BIN/pg_restore"
PSQL="$PG_BIN/psql"
[ -x "$PG_RESTORE" ] || die "找到了 ${PG_DUMP}，但同目录下没有 pg_restore，安装可能不完整。"

# ---------- 2. 读连接串 ----------
[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE" \
  "新建这个文件（在仓库外，不要放进项目目录）：" \
  "  mkdir -p ~/.config/hearth && chmod 700 ~/.config/hearth" \
  "  printf 'BACKUP_DATABASE_URL=%s\\n' '<只读角色的直连连接串>' > $ENV_FILE" \
  "  chmod 600 $ENV_FILE" \
  "只读角色的建法见 README 的「备份和恢复」。"

if [ "$(uname)" = Darwin ]; then
  perm="$(stat -f '%Lp' "$ENV_FILE")"
else
  perm="$(stat -c '%a' "$ENV_FILE")"
fi
case "$perm" in
  600 | 400) ;;
  *) warn "$ENV_FILE 的权限是 ${perm}，建议 chmod 600 $ENV_FILE" ;;
esac

# 只取这一个变量，不 source 整个文件；支持可选的 export 前缀和引号
url="$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}BACKUP_DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
url="${url%\"}"; url="${url#\"}"
url="${url%\'}"; url="${url#\'}"

[ -n "$url" ] || die "$ENV_FILE 里没有 BACKUP_DATABASE_URL。"
case "$url" in
  postgres://* | postgresql://*) ;;
  *) die "BACKUP_DATABASE_URL 不像 Postgres 连接串（应该以 postgresql:// 开头）。" ;;
esac

# 打印用的主机名，不打印密码
host="${url#*@}"; host="${host%%/*}"; host="${host%%\?*}"; host="${host%%:*}"
case "$host" in
  *-pooler*) die "连接串用的是 Neon 的连接池（主机名带 -pooler），pg_dump 要用直连。" \
    "在 Neon 控制台复制连接串时关掉 Connection pooling，或者把主机名里的 -pooler 去掉。" ;;
esac

echo "pg_dump：${PG_DUMP}（PostgreSQL ${best}）"
echo "数据库主机：$host"

# ---------- 3. 连上去检查版本和只读（有 psql 才能做） ----------
if [ -x "$PSQL" ]; then
  # 列出当前角色能写的表；只读角色应该一张都没有
  check_sql="SELECT current_setting('server_version_num')::int / 10000,
    (SELECT count(*) FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND has_table_privilege(format('%I.%I', schemaname, tablename), 'INSERT, UPDATE, DELETE, TRUNCATE'))"
  if ! info="$("$PSQL" -X -A -t -F ' ' --no-password -d "$url" -c "$check_sql" 2>&1)"; then
    die "连不上数据库。" "$info"
  fi
  server_major="${info%% *}"
  writable="${info##* }"
  echo "服务器版本：PostgreSQL $server_major"

  if [ "$best" -lt "$server_major" ]; then
    die "本机 pg_dump 是 ${best}，比服务器的 $server_major 低，备份会失败。" \
      "安装：brew install postgresql@$server_major"
  fi
  if [ "$writable" != "0" ]; then
    die "这个连接串的角色能写 $writable 张表，不是只读角色。备份必须用只读角色。" \
      "建只读角色的步骤见 README 的「备份和恢复」。"
  fi
else
  warn "没有找到 psql，跳过版本和只读检查，只靠 pg_dump 自己的报错。"
fi

# ---------- 4. 备份 ----------
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

day="$(TZ=Australia/Melbourne date +%Y-%m-%d)"
out="$BACKUP_DIR/hearth-$day.dump"
tmp="$out.partial"
err="$(mktemp "${TMPDIR:-/tmp}/hearth-backup.XXXXXX")"
trap 'rm -f "$tmp" "$err"' EXIT

[ -e "$out" ] && warn "今天已经有一份 $(basename "$out")，成功后会覆盖。"

echo "开始备份..."
if ! "$PG_DUMP" -Fc --no-password -d "$url" -f "$tmp" 2>"$err"; then
  cat "$err" >&2
  if grep -q 'server version mismatch' "$err"; then
    die "pg_dump 版本比服务器低。" "按上面报错里的 server version 装对应的 postgresql@<版本>。"
  fi
  die "pg_dump 失败，见上面的报错。之前的备份没有被改动。"
fi

# 能列出目录才算一份完整的备份
"$PG_RESTORE" --list "$tmp" >/dev/null 2>"$err" || {
  cat "$err" >&2
  die "备份文件读不出来，可能不完整。之前的备份没有被改动。"
}

mv -f "$tmp" "$out"
size="$(du -h "$out" | cut -f 1 | tr -d ' ')"
echo "完成：${out}（${size}）"

# ---------- 5. 只保留最近 KEEP 份 ----------
# 文件名里的日期能直接按字符串排序；只碰符合命名的文件
ls -1 "$BACKUP_DIR" | grep -E '^hearth-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$' | sort -r | tail -n +$((KEEP + 1)) |
  while IFS= read -r old; do
    rm -f -- "$BACKUP_DIR/$old"
    echo "删除旧备份：$old"
  done || true

count="$(ls -1 "$BACKUP_DIR" | grep -cE '^hearth-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$' || true)"
echo "现在共有 $count 份备份（最多保留 $KEEP 份）"
