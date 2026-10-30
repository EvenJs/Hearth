# Hearth 技术栈

> 目标：快速能用，全部免费服务，一个人维护
> 原则：选最主流、AI 最熟的方案，不追新

---

## 1. 总览

| 层         | 选型                                                        | 备注                                                |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------- |
| 语言       | TypeScript（strict 模式）                                   | 全栈统一                                            |
| 框架       | Next.js 16（App Router）                                    | Server Components + Server Actions，不单独写 API 层 |
| 数据库     | Neon Postgres（免费版）                                     | 闲置自动休眠，查询时自动唤醒                        |
| ORM        | Drizzle ORM + drizzle-kit                                   | schema 用 TS 写，迁移用 drizzle-kit 生成            |
| 数据库驱动 | `@neondatabase/serverless`（`drizzle-orm/neon-serverless`） | 需要事务，见第 3 节                                 |
| 登录       | Better Auth                                                 | 邮箱 + 密码，Drizzle adapter，见第 4 节             |
| UI         | Tailwind CSS + shadcn/ui                                    | 图标用 lucide-react                                 |
| 图表       | Recharts（通过 shadcn/ui charts）                           |                                                     |
| 表单和校验 | Zod + react-hook-form                                       | Zod schema 前后端共用                               |
| CSV 解析   | Papa Parse                                                  |                                                     |
| PDF 读文字 | `unpdf`（包装 Mozilla PDF.js，serverless 能用）             | ANZ 对账单（R1C，M6.6 加）、ANZ Plus 对账单（R1D，M7.5）。要求 Node ≥ 22；装时定死版本 |
| 测试       | Vitest                                                      | 核心逻辑单元测试                                    |
| 代码规范   | ESLint + Prettier                                           |                                                     |
| 包管理     | pnpm                                                        |                                                     |
| 部署       | Vercel Hobby（免费）                                        | 个人非商业使用，符合条款                            |
| 代码托管   | GitHub                                                      | push 到 main 自动部署                               |

版本：开工时用各库的最新稳定版，`package.json` 锁定版本，不用 `latest`。

---

## 2. 关键约定

### 金额

- 数据库存**整数分**（`integer`，如 $58.40 存 `5840`），不用浮点数
- 正数收入，负数支出，跟 ANZ CSV 一致
- 显示用 `Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' })`

### 日期

- 交易日期用 Postgres `date` 类型（只有日期，没有时间）
- 时区按 `Australia/Melbourne`
- 时间戳字段（created_at 等）用 `timestamptz`

### 数据隔离

- 所有业务表带 `household_id`
- 所有查询必须按当前用户的 `household_id` 过滤，封装在数据访问层，页面代码不直接写查询

### 代码分层

- 核心业务逻辑（解析、清洗、去重、转账识别、分类匹配）写成**纯函数**，不依赖数据库和框架，方便测试
- 数据库读写集中在数据访问层
- 页面和 Server Actions 只负责调用

### 页面状态（2026-10-24 补）

`next.config.ts` 开了 `cacheComponents: true`。离开页面时 Next 不卸载它，而是用 React 的 `<Activity>` 藏起来（`display: none`），React state 和 DOM 都留着（包括 file input 选的文件），最多保留 3 个路由。回到这个页面时看到的是离开时的样子，不是重新渲染的。见 `node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`。

写客户端组件时，每个 state 想清楚离开再回来要不要留：

| 要留 | 要清 |
| --- | --- |
| 填到一半的表单、筛选条件、展开收起 | 提交成功后的表单、勾选、弹窗和对话框、成功或失败提示 |

清的办法：在 `useLayoutEffect` 的 cleanup 里重置（页面被隐藏时会执行）。整个表单要清空时，换外层组件的 `key` 让它重新挂载，file input 这种不受控的 DOM 状态也能一起清掉。

已经处理的地方：

- 导入页（`import-form.tsx`）：导入成功后再回来是空表单；填到一半离开、导入失败，都保留
- 流水页（`transaction-list.tsx`）：离开时清掉批量修改的勾选和"存成规则"对话框，拆分的展开收起保留
- 交易详情页（`transactions/[id]/split-section.tsx`）：离开时关掉拆分、删除确认和"存成规则"对话框
- 看板时间段（`_dashboard/period-picker.tsx`）：自定义日期填到一半离开再回来保留；URL 变了（换时间段或归属人）时换 `key` 重新挂载，日期框跟着当前时间段

---

## 3. 数据库：Neon + Drizzle

- 驱动用 `neon-serverless`（WebSocket Pool），**不用** `neon-http`。HTTP 驱动不支持事务，而 CSV 导入必须在一个事务里完成，要么全部成功要么全部回滚
- 开发和生产用两个独立的数据库（Neon 的 branch），开发时不碰真实数据
- 迁移流程：改 schema → `drizzle-kit generate` → 检查生成的 SQL → `drizzle-kit migrate`
- 免费额度：每个项目 0.5 GB 存储、100 CU 小时计算，家庭记账远远用不完

---

## 4. 登录：Better Auth

为什么不用 Auth.js：Auth.js 现在由 Better Auth 团队维护，官方建议新项目直接用 Better Auth。Auth.js 只做安全补丁和紧急修复。

配置：

- 登录方式：邮箱 + 密码（只有 1 到 2 个用户，不需要第三方登录）
- 用 Drizzle adapter，用户和 session 表跟业务表在同一个数据库
- **关闭公开注册**：账号手动创建，网站上线后别人不能自己注册
- 以后加老婆的账号：手动创建，关联到同一个 household

---

## 5. 测试

| 范围                     | 要求                   |
| ------------------------ | ---------------------- |
| CSV 解析、脱敏、清洗     | 必须有单元测试         |
| 去重 key 生成            | 必须有单元测试         |
| 内部转账识别             | 必须有单元测试         |
| 分类规则匹配、归属人判断 | 必须有单元测试         |
| 按周按月汇总、税后估算   | 必须有单元测试         |
| pending 交易匹配         | 必须有单元测试         |
| 页面和 UI                | MVP 不要求，自己手动点 |

- 测试数据放在 `fixtures/`，全部是脱敏的假数据
- 端到端测试（Playwright）MVP 不做

---

## 6. 目录结构（初稿）

```
hearth/
├── CLAUDE.md
├── docs/
│   ├── prd.md
│   ├── tech-stack.md
│   ├── schema.md
│   ├── business-rules.md
│   ├── seed-categories.md
│   ├── roadmap.md
│   ├── design/            # 页面清单和设计图
│   └── tasks/             # 每个里程碑的任务清单
├── fixtures/              # 脱敏测试数据
├── drizzle/               # 生成的迁移文件
├── scripts/               # seed、create-user、backup、db-ping
├── src/
│   ├── app/               # Next.js 页面和路由
│   ├── components/        # UI 组件（shadcn/ui 在 components/ui）
│   ├── db/
│   │   ├── schema.ts      # Drizzle 表定义
│   │   └── index.ts       # 数据库连接
│   ├── lib/
│   │   ├── auth.ts        # Better Auth 配置
│   │   ├── import/        # CSV 解析器（每个银行一个文件）、ANZ 对账单解析（R1C）
│   │   ├── rules/         # 清洗、去重、转账、分类、匹配、统计（纯函数）
│   │   ├── tax/           # 税率表和税后估算（纯函数）
│   │   ├── accounts/      # 账户、卡的输入校验（Zod）
│   │   └── seed/          # 种子数据定义（seed 脚本和测试共用）
│   ├── server/            # 数据访问层 + Server Actions
│   │   ├── pdf/           # 读 PDF 文字（unpdf，M6.6）
│   │   ├── llm/           # LLM 客户端（M6.7）
│   │   └── receipt-readers/  # 小票 reader 接口和实现（M6.7）
│   └── proxy.ts           # 未登录跳转（Next.js 16 的路由拦截）
└── tests/
    ├── helpers/           # 测试用的家庭配置、读 fixtures
    └── local/             # 真实数据试跑，不提交（写在 .git/info/exclude）
```

---

## 7. 环境变量

```
DATABASE_URL           # Neon 连接串
BETTER_AUTH_SECRET     # 随机生成
BETTER_AUTH_URL        # 本地 http://localhost:5000，线上用正在用的域名（自定义域名）
LLM_BASE_URL           # OpenAI 兼容接口地址，如 https://api.groq.com/openai/v1（M6.7 起）
LLM_API_KEY            # 服务商的 key
LLM_VISION_MODEL       # 看图的模型，如 qwen/qwen3.8-27b（小票识别，R20.1a）
RECEIPT_READER         # 小票用哪个 reader：llm | none，不填或不认识的值当作 none（R20.1）
```

- `RECEIPT_READER=llm` 但没配 `LLM_*`：启动不报错，识别时显示"暂时识别不了"，可以手动填商品，其他功能照常

- `.env.local` 不进 git，仓库里只放 `.env.example`
- Vercel 上在项目设置里配置
- 换域名时（2026-10-25 踩过）：Vercel 上 Production 的 `BETTER_AUTH_URL` 改成新域名（带 `https://`，结尾不带 `/`），然后 Redeploy。不改会登录 403 `Invalid origin`；改了以后只认新域名，旧域名登不上

---

## 8. 免费额度和限制

| 服务                       | 限制                               | 对 Hearth 的影响                   |
| -------------------------- | ---------------------------------- | ---------------------------------- |
| Vercel Hobby               | 限个人非商业使用；超额后要等 30 天 | 家庭自用没问题                     |
| Neon Free | 0.5 GB 存储；闲置 5 分钟后计算归零，下次查询自动唤醒 | 冷启动：隔一段时间第一次打开慢 1 到 2 秒（Neon 唤醒 + Vercel 函数启动），之后正常 |
| Neon Free | 即时恢复只能回到 **6 小时以内** | 6 小时后才发现的误删、坏迁移救不回来，所以要自己备份（第 10 节） |
| LLM API（小票识别，M6.7） | 用免费额度，见第 11 节 | 一周几张小票，远低于限额；额度用完只影响识别 |

---

## 9. 不选的方案

| 方案             | 原因                                      |
| ---------------- | ----------------------------------------- |
| Supabase         | 免费版闲置 7 天会暂停，每月用前要手动恢复 |
| Auth.js          | 新项目官方建议用 Better Auth              |
| Prisma           | 多一个生成步骤，Drizzle 更轻、更接近 SQL  |
| `neon-http` 驱动 | 不支持事务                                |
| .NET 后端        | 目标是快速能用，全 TS 少一层              |
| Electron / Expo  | 见需求文档第 8 节                         |
| Gemini 免费版（AI 功能） | 澳洲不在欧盟、英国范围内，免费版的提示词可能被用于训练 |

---

## 10. 备份

**为什么要做**：银行流水丢了可以重新导入（CBA 最多导出约两年），但手动改过的分类、归属人、拆分、规则、手动录入的现金和 ANZ Plus 利息、tax_profile 丢了就找不回来。Neon 免费版只能恢复到 6 小时以内。

最可能出事的不是 Neon 本身，而是：AI 写的迁移删错了列、撤销导入有 bug、批量修改改错了。

### 10.1 每月备份（导入完顺手做）

- `pnpm db:backup`：对 prod 跑 `pg_dump -Fc`，存到**仓库外**的 `~/hearth-backups/hearth-YYYY-MM-DD.dump`
- 连接串用 prod 的**只读角色**，放在仓库外的 `~/.config/hearth/backup.env`，不进 git、不进 Vercel
- 只保留最近 12 份，旧的脚本自动删
- 需要本机装 `pg_dump`，版本**不低于** Neon 上的 Postgres 版本（看 Neon 控制台，用 Homebrew 装对应的 `postgresql@<版本>`）
- 备份文件包含全部财务数据：不进 git、不放公开的网盘

### 10.2 迁移前打快照

- prod 跑 `db:migrate` 之前，先在 Neon 控制台从 prod 建一个 branch，命名 `pre-migrate-YYYYMMDD`
  - 建 branch 时选 **Data and schema**、当前时间点（Schema only 不带数据，不能当备份）
  - 建完后 Neon 显示的往往是新 branch 的连接串。迁移要用 **prod** 的连接串，回到 prod branch 重新复制
- 本地对 prod 跑命令时，不改 `.env.local`：新开一个终端，`read -s DATABASE_URL` 粘贴连接串，再 `export DATABASE_URL`（shell 里的值优先于 `.env.local`，密码也不进 shell 历史）。做完关掉终端
- 跑之前用 `echo ${DATABASE_URL#*@} | cut -d/ -f1` 打印主机名，确认和 Vercel 上 `DATABASE_URL` 的主机名一致
- 迁移出问题时可以从这个 branch 恢复
- 确认没问题后删掉（免费版 branch 数量有限）

### 10.3 恢复演练

- 第一次备份后，用 `pg_restore` 恢复到一个新的 dev branch，打开 app 看数据对不对
- 没恢复过的备份不算备份

### 10.4 冷启动

不需要处理。Neon 唤醒和 Vercel 函数启动加起来一两秒，只在隔一段时间第一次打开时出现。不要为了这个加定时 ping，会白白消耗免费额度。

---

## 11. LLM（M6.7 小票识别先接，其他 AI 功能以后）

> 功能和原则见 `prd.md` 第 4 节"AI 功能"。免费额度经常变，接之前去官网再确认一遍。

### 11.1 选型

Hearth 的用量很小（每月几十个商家名），免费额度够用。只考虑**不拿免费数据训练**的服务：

| 服务 | 免费额度（2026-10 查的，大概） | 训练数据 | 用途 |
|---|---|---|---|
| **Groq**（首选） | 每分钟 30 次，每天 1000 次；Llama 3.3 70B 等 | 不训练 | 线上的分类建议 |
| Cloudflare Workers AI（备选） | 每天约 1 万 neurons | 不训练 | Groq 不能用时 |
| GitHub Models | 每分钟 15 次，每天 150 到 1000 次 | 不训练 | 开发时试效果 |
| 本地 Ollama | 无限，跑在自己电脑上 | 数据不出电脑 | 只能做成本地脚本，Vercel 上的 app 连不到 |

不用：Gemini 免费版（澳洲用户的提示词可能被用于训练）；OpenRouter 免费模型（背后的服务商各家政策不同，不好确认）。

小票识别需要支持图片的模型（2026-10-27 查的）：

| 服务 | 模型 | 限额 | 说明 |
|---|---|---|---|
| **Groq**（首选） | `qwen/qwen3.8-27b` | 免费版（2026-10-29 控制台 Settings → Limits 查的）：每分钟 30 次、每天 1000 次、每分钟 8K tokens、每天 200K tokens。一张图算 2048 个输入 token，一次最多 3 张，图片不超过 20MB | 卡脖子的是 tokens：一张小票连提示词和分类列表大概 3K 到 4K tokens，每分钟只能识别两张左右，每天几十张。两个人用够了 |
| Cloudflare Workers AI（备选） | 没核实 | 每天约 1 万 neurons | 当时没查到现在有哪些看图模型、数据政策，要用之前再查 |

Groq 另一个看图模型 `muse-spark-open` 在限量预览，要申请，不用。

### 11.2 接法
- 用 OpenAI 兼容的接口格式，直接 `fetch`，不引入 SDK。上面几家都支持这种格式
- 服务商地址、API key、模型名放环境变量：`LLM_BASE_URL`、`LLM_API_KEY`，模型按用途分开：`LLM_VISION_MODEL`（小票，M6.7）；以后做文字类功能（分类建议等）再加 `LLM_TEXT_MODEL`。换服务商只改环境变量，不改代码
- 调用代码放 `src/server/llm/`，只在服务器端调用，API key 不进浏览器
- 分小批调用（比如每次 20 个商家），避免超过 Vercel Hobby 的函数执行时间上限
- 返回结果用 Zod 校验，格式不对就当作没有建议，不报错
- 免费服务随时可能改额度或停掉：调用失败时界面显示"暂时没有建议"，其他功能照常

### 11.3 小票识别（M6.7，规则见 R20）

- **reader 是注入的**（R20.1）。接口和工厂在 `src/server/receipt-readers/`：

  ```ts
  // 所有 reader 返回同一个原始结果（R20.1），schema 在 src/lib/rules/receipt.ts
  type ReceiptInput = { kind: 'image'; image: Blob } | { kind: 'text'; text: string };
  type ReadResult = { ok: true; raw: RawReceipt; reader: string } | { ok: false; reason: string };
  interface ReceiptReader {
    id: 'llm' | 'text';
    input: 'image' | 'text';          // 核对界面据此显示"拍照"还是"粘贴文字"
    read(input: ReceiptInput, categories: string[]): Promise<ReadResult>;
  }
  function getReceiptReader(): ReceiptReader | null;   // 按 RECEIPT_READER，none 返回 null
  ```

  - Server Action 调 `scanReceipt(ctx, input, reader = getReceiptReader())`，测试传假的 reader，不碰网络
  - `llm` reader 里再注入一层 `LlmClient`（`src/server/llm/client.ts`，现在只有 OpenAI 兼容这一种实现）。换 Groq、Cloudflare、GitHub Models 只改 `LLM_*`；以后要接不兼容 OpenAI 格式的服务商，加一个 `LlmClient` 实现就行，reader 不改
  - `text` reader 不做（R20.1b，2026-10-29 实验结果）。接口的 `id`、`input` 里留着 `text`，给以后的本地 OCR 用；现在 `RECEIPT_READER=text` 当作不认识的值，打警告、当作 `none`
  - 想关掉 AI：`RECEIPT_READER` 改成 `none`，Vercel 上 Redeploy
- `llm` reader 的模型用 `LLM_VISION_MODEL`
- 图片在浏览器里用 canvas 压缩成 JPEG（长边 ≤ 1600px，≤ 1MB），不加库。iPhone 的 HEIC 照片 Safari 选图时会转成 JPEG；电脑上的 Chrome 解不了 HEIC，提示"换成 JPG 再传"
- 用 FormData 传给 Server Action（`bodySizeLimit` 已经是 2MB），服务器端转成 base64 data URL 放进 `image_url`
- 要求返回 JSON（`response_format: { type: 'json_object' }`，服务商不支持就靠提示词），用 Zod 校验，格式见 R20.1
- 超时 30 秒，超时、HTTP 错误、Zod 不通过都当作识别失败，不重试
- 图片只在这次请求的内存里，不写磁盘、不存数据库、不打日志
- 测提示词效果、文字解析效果用真实小票时，脚本放 `tests/local/`（不提交），真实小票不进 fixtures

