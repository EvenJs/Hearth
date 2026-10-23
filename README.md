This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:5000](http://localhost:5000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 备份和恢复

背景和原因见 `docs/tech-stack.md` 第 10 节。备份文件包含全部财务数据，不进 git、不放公开网盘。

### 一次性准备

**1. 装 pg_dump**，主版本不低于 Neon 上的 Postgres。在 Neon 的 SQL Editor 里跑 `SHOW server_version;` 看版本（现在是 18）：

```bash
brew install postgresql@18   # 18 换成上面查到的主版本
```

不需要 `brew link`，`db:backup` 会自己找到 Homebrew 装的最新版本。但手动敲的 `psql` / `pg_restore` 不会，PATH 里默认的可能是旧版本（比如 14），读不了新版本做的备份。所以每个要手动跑它们的终端，先加一下 PATH：

```bash
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"
pg_restore --version   # 确认是 18.x
```

`brew --prefix` 没装也会返回路径，所以要用 `--version` 确认。

Neon 升大版本后，`db:backup` 会报版本不够并提示装哪个，装上新版本即可。新版 pg_restore 能读旧版本的备份。

**2. 在 Neon 建只读角色** `hearth_backup`。角色跟着 branch 走，prod 和 dev 各建一次。

**不要在控制台 Roles 页面建**：控制台建的角色会自动加入 `neon_superuser`，能写所有表，GRANT 什么都没用。要用 SQL 建，这样角色归 `neondb_owner`，只有你给的权限。

先在终端生成密码（hex 放进连接串不用转义）：

```bash
openssl rand -hex 24
```

在这个 branch 的 SQL Editor 里跑（先 `SELECT current_user;` 确认是 `neondb_owner`），`<密码>` 换成上面生成的：

```sql
CREATE ROLE hearth_backup WITH LOGIN PASSWORD '<密码>';
GRANT CONNECT ON DATABASE neondb TO hearth_backup;
GRANT USAGE ON SCHEMA public, drizzle TO hearth_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO hearth_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO hearth_backup;
-- 以后迁移新建的表也自动给只读权限
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public, drizzle GRANT SELECT ON TABLES TO hearth_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public, drizzle GRANT SELECT ON SEQUENCES TO hearth_backup;
-- 再加一层保险：这个角色的事务默认只读
ALTER ROLE hearth_backup SET default_transaction_read_only = on;
```

跑完在 SQL Editor 的历史里删掉这条（带密码）。确认它没有加入任何组，结果应该是空的：

```sql
SELECT r.rolname
FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
WHERE m.member = 'hearth_backup'::regrole;
```

`db:backup` 每次都会再检查一遍，角色能写任何一张表就拒绝备份。

**3. 把连接串放到仓库外**。SQL 建的角色在 Connect 里可能不显示，所以复制 `neondb_owner` 的连接串（**关掉 Connection pooling**，主机名不能带 `-pooler`），再把用户名和密码换掉：

```bash
mkdir -p ~/.config/hearth && chmod 700 ~/.config/hearth
read -s OWNER_URL   # 粘贴 neondb_owner 的直连连接串，不会显示也不进 shell 历史
read -s PW          # 粘贴上面生成的密码
printf "BACKUP_DATABASE_URL='%s'\n" "postgresql://hearth_backup:${PW}@${OWNER_URL#*@}" > ~/.config/hearth/backup.env
chmod 600 ~/.config/hearth/backup.env
unset OWNER_URL PW
sed -n 's#.*://\([^:]*\):.*#\1#p' ~/.config/hearth/backup.env   # 应该打印 hearth_backup
```

### 每月备份

```bash
pnpm db:backup
```

- 输出到 `~/hearth-backups/hearth-YYYY-MM-DD.dump`（墨尔本日期），只保留最近 12 份，旧的自动删
- 同一天跑两次会覆盖当天那份；失败时不会动已有的备份
- 脚本会先检查：pg_dump 版本够不够、角色是不是只读（能写任何一张表就拒绝）、是不是连接池地址

### 恢复到一个新的 Neon branch

恢复到新 branch 里的一个**空数据库**，这样恢复出来的数据只来自备份文件。

**1. 建目标库**

- Neon 控制台 → Branches → New branch，名字 `restore-YYYYMMDD`，从哪个 branch 建都行
- 进这个新 branch → Databases → New database，名字 `hearth_restore`，owner 选 `neondb_owner`

**2. 拿目标库的连接串**：在新 branch 的 Connect 里选 `neondb_owner`、数据库 `hearth_restore`、关掉 Connection pooling。新开一个终端：

```bash
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"   # 不加会用到旧版 pg_restore，报 unsupported version
read -s RESTORE_URL && export RESTORE_URL
echo ${RESTORE_URL#*@} | cut -d/ -f1   # 确认是新 branch 的主机名，不是 prod
```

**3. 恢复**

```bash
pg_restore --no-owner --no-acl -d "$RESTORE_URL" ~/hearth-backups/hearth-YYYY-MM-DD.dump
```

- 最后如果打印 `errors ignored on restore: N`，往上看具体错误。只跟 `schema public` 有关的（比如已存在、不是 owner）可以忽略；涉及表、数据、约束的说明恢复失败
- `--no-owner --no-acl`：对象归 `neondb_owner`，不还原授权。正式恢复后要让这个库也能备份，在里面重新建只读角色（SQL 里的 `neondb` 换成这个库的名字）

**4. 对比数据**：备份源和恢复出来的库各数一遍行数（备份源用只读连接串就行，备份之后源库不要有改动）：

```bash
read -s SOURCE_URL && export SOURCE_URL
psql -X -A -t -d "$SOURCE_URL"  -f scripts/backup-counts.sql > ~/hearth-backups/counts-source.txt
psql -X -A -t -d "$RESTORE_URL" -f scripts/backup-counts.sql > ~/hearth-backups/counts-restored.txt
diff ~/hearth-backups/counts-source.txt ~/hearth-backups/counts-restored.txt && echo 行数一致
```

再在这个终端里用恢复的库开 app，登录看看流水、分类对不对（不改 `.env.local`，shell 里的值优先）：

```bash
DATABASE_URL="$RESTORE_URL" pnpm dev
```

**5. 收尾**：关掉终端，`rm ~/hearth-backups/counts-*.txt`，在 Neon 删掉 `restore-YYYYMMDD` branch（免费版 branch 数量有限）。

真出事要正式恢复时，步骤一样，确认数据没问题后把 Vercel 的 `DATABASE_URL` 换成这个库的连接串（用 pooled 地址），重新部署。
