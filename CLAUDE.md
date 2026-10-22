# CLAUDE.md

## 项目

Hearth 是一个家庭记账 web app，给我和老婆两个人用。核心流程：导入银行 CSV → 自动脱敏、清洗、去重、分类、分归属人 → 看板和流水查询。现金和随手记的消费手动录入。

目标是**快速能用**，一个人维护，全部免费服务。不要过度设计。

## 文档（改代码前先读相关的）

| 文档 | 什么时候读 |
|---|---|
| `docs/prd.md` | 做任何功能前 |
| `docs/tech-stack.md` | 装依赖、选库前 |
| `docs/schema.md` | 碰数据库前 |
| `docs/business-rules.md` | 写导入、分类、统计逻辑前。**这是核心逻辑的唯一标准** |
| `docs/seed-categories.md` | 改分类或预置规则前 |
| `docs/roadmap.md` | 开始新任务前，确认当前在哪个里程碑 |
| `docs/tasks/mN.md` | 做具体任务时，按任务编号读对应说明 |
| `fixtures/README.md` | 写测试前 |
| `docs/design/README.md` | 做页面前，看页面清单和对应编号的设计图 |

文档和代码冲突时，先停下来问我，不要自己选一个。

## 技术栈

Next.js 16（App Router）· TypeScript strict · Neon Postgres · Drizzle ORM · Better Auth · Tailwind + shadcn/ui · Recharts · Zod + react-hook-form · Papa Parse · Vitest · pnpm · Vercel

不要引入文档里没有的库。真的需要时先问我。

## 命令

```
pnpm dev            本地开发
pnpm test           跑测试
pnpm lint           检查
pnpm db:generate    生成迁移（drizzle-kit generate）
pnpm db:migrate     执行迁移（drizzle-kit migrate）
pnpm db:seed        种子数据
```

## 硬规则

### 数据和隐私
- **金额一律用整数分**（`integer`），不用浮点数。字符串转金额不能用 `parseFloat(x) * 100`
- **不存完整账号和卡号**。描述里 8 位以上连续数字入库前必须脱敏（R2.3）
- 不保存上传的 CSV 原文件
- 真实银行数据不进 git，不写进测试，不贴进代码注释。测试只用 `fixtures/` 里的假数据
- 所有业务查询必须带 `household_id`，经过 `src/server/` 的数据访问层，页面和组件里不直接写查询

### 数据库
- 用 `drizzle-orm/neon-serverless`，**不用** `neon-http`（导入需要事务）
- **改表结构前先问我**。迁移文件生成后给我看 SQL 再执行
- 迁移里有 `DROP`、`ALTER ... TYPE`、删列、改列名时，要单独指出来
- prod 跑迁移前提醒我先建 Neon branch 快照（tech-stack 10.2）
- 银行账户表叫 `financial_account`，因为 Better Auth 已经有 `account` 表
- 分类和归属人在 `transaction_split` 上，不在 `transaction` 上

### 代码组织
- 业务规则写成纯函数，放 `src/lib/import/`、`src/lib/rules/`、`src/lib/tax/`，不 import 数据库或 Next.js
- 规则函数的注释和测试名带上规则编号，如 `// R4.1`、`it('R4: same row twice in one file gets occurrence 1 and 2')`
- 数据写入用 Server Actions，输入用 Zod 校验
- 税率表按财年写在 `src/lib/tax/rates.ts`，没有对应财年时报错，不要沿用旧表
- 归属人的含义是"钱用在谁身上"，不是"谁付的钱"，优先级见 R5
- 日期按 `Australia/Melbourne` 处理，交易日期是 `YYYY-MM-DD` 字符串，不要转成 JS `Date` 再转回去

### 测试
- `src/lib/` 下的规则**先写测试再写实现**
- 期望值来自 `business-rules.md` 和 `fixtures/README.md`，不要根据实现反推期望值
- 测试失败时修实现，不要改测试去迁就实现，除非我同意规则本身错了

### UI
- 中文界面，金额显示 `Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' })`
- **电脑优先**：按 1280px 以上宽度设计，可以用侧边栏、宽表格、多列看板
- 手机只要求"能用"：375px 宽不出现横向滚动、不报错，不做精细排版。唯一例外是快速录入（F3），手机上要顺手
- 用 shadcn/ui 组件，不要自己从零写按钮、弹窗、表格

## 工作方式

- 一次只做 `docs/tasks/` 里的一个任务，不要顺手做后面的
- 小步改，每完成一个能跑的小块就停下来让我看
- 不确定的事情问我，不要猜。尤其是：规则文档没写到的边界情况、要加新依赖、要改表结构
- 完成后告诉我：改了哪些文件、怎么验证、还有什么没做
