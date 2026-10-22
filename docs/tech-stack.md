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
├── src/
│   ├── app/               # Next.js 页面和路由
│   ├── components/        # UI 组件（shadcn/ui 在 components/ui）
│   ├── db/
│   │   ├── schema.ts      # Drizzle 表定义
│   │   └── index.ts       # 数据库连接
│   ├── lib/
│   │   ├── auth.ts        # Better Auth 配置
│   │   ├── import/        # CSV 解析器，每个银行一个文件
│   │   ├── rules/         # 清洗、去重、转账、分类、匹配、统计（纯函数）
│   │   └── tax/           # 税率表和税后估算（纯函数）
│   └── server/            # 数据访问层 + Server Actions
└── tests/
```

---

## 7. 环境变量

```
DATABASE_URL           # Neon 连接串
BETTER_AUTH_SECRET     # 随机生成
BETTER_AUTH_URL        # 本地 http://localhost:3000，线上用 Vercel 域名
```

- `.env.local` 不进 git，仓库里只放 `.env.example`
- Vercel 上在项目设置里配置

---

## 8. 免费额度和限制

| 服务                       | 限制                               | 对 Hearth 的影响                   |
| -------------------------- | ---------------------------------- | ---------------------------------- |
| Vercel Hobby               | 限个人非商业使用；超额后要等 30 天 | 家庭自用没问题                     |
| Neon Free                  | 0.5 GB 存储；闲置后计算归零        | 第一次打开可能慢一点，几乎感觉不到 |
| Claude API（后续 AI 功能） | 按用量付费                         | 不在 MVP 范围                      |

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
