# Hearth 数据库设计

> 数据库：Neon Postgres
> ORM：Drizzle（表定义在 `src/db/schema.ts`）
> 业务规则见 `business-rules.md`，这里只定结构

---

## 0. 通用约定

| 约定     | 说明                                                              |
| -------- | ----------------------------------------------------------------- |
| 主键     | `id uuid`，默认 `gen_random_uuid()`                               |
| 表名     | 单数、snake_case（`transaction`、`transaction_split`）            |
| 字段名   | snake_case；Drizzle 里用 camelCase 映射                           |
| 金额     | `integer`，单位是**分**，正数收入、负数支出                       |
| 交易日期 | `date`（只有日期，按 `Australia/Melbourne`）                      |
| 时间戳   | `timestamptz`，默认 `now()`                                       |
| 数据隔离 | 所有业务表都有 `household_id`，所有查询必须带它                   |
| 删除     | 业务数据用 `is_archived` 软删除；交易可以硬删除（只限手动录入的） |
| 枚举     | 用 Postgres enum（Drizzle `pgEnum`）                              |

**命名冲突注意**：Better Auth 自带一张叫 `account` 的表（存登录方式），所以银行账户表叫 `financial_account`，不要叫 `account`。

---

## 1. 枚举

```
member_kind          person | shared | child
bank                 anz | anz_plus | cba | cash | other
account_type         everyday | savings | credit_card | joint | cash
account_purpose      everyday | bills | emergency | savings | goal     （M9-3 建）
condition_type       min_deposit | no_withdrawal | balance_growth | linked_min_deposit | linked_card_count | other   （M10-4 建）
condition_outcome    bonus | fee_waiver                                （M10-4 建）
deposit_filter       any | exclude_linked                              （M10-4 建）
category_kind        expense | income | system
system_category_key  internal_transfer | cash_withdrawal | bank_fee | uncategorized
transaction_status   pending | confirmed
transaction_source   csv | manual | receipt
transfer_status      none | auto | suggested | confirmed
rule_match_type      contains | starts_with
item_type            fruit | vegetable | meat | seafood | dairy_egg | pantry | snack | drink | household | other
goal_type            keep | spend                                     （M11-4 建，待确认）
goal_recurrence      once | yearly                                    （M11-4 建，待确认）
goal_status          active | done                                    （M11-4 建，待确认）
```

`item_type` 说明：R21.1 的 key，列表在 `src/lib/rules/item-type.ts`（`ITEM_TYPE_KEYS`），enum 从那里取。不含 `untyped`（统计里的"未分"不是一个类型）。以后加类型要迁移 `ALTER TYPE ... ADD VALUE`

`transfer_status` 说明：

- `none`：不是内部转账
- `auto`：靠账号尾号自动识别，直接生效
- `suggested`：兜底规则猜的，等人确认，**确认前按普通交易统计**
- `confirmed`：人工确认过

---

## 2. 登录相关（Better Auth 生成）

`user`、`session`、`account`、`verification` 四张表由 Better Auth CLI 生成，不手写。不在 `user` 上加业务字段，家庭关系放在下面的 `household_user`。

---

## 3. 业务表

### household

| 字段       | 类型        | 约束     | 说明             |
| ---------- | ----------- | -------- | ---------------- |
| id         | uuid        | PK       |                  |
| name       | text        | not null | 如 "Wang Family" |
| created_at | timestamptz | not null |                  |

### household_user

登录用户和家庭的关系。MVP 只有一行。

| 字段         | 类型        | 约束                           | 说明                       |
| ------------ | ----------- | ------------------------------ | -------------------------- |
| id           | uuid        | PK                             |                            |
| household_id | uuid        | FK → household, not null       |                            |
| user_id      | text        | FK → user.id, not null, unique | 一个用户只属于一个家庭     |
| member_id    | uuid        | FK → member, null              | 这个登录用户对应哪个归属人 |
| created_at   | timestamptz | not null                       |                            |

### member

归属人：**钱用在谁身上**。不是登录账号，也不是"谁付的钱"。

| 字段         | 类型        | 约束                    | 说明                               |
| ------------ | ----------- | ----------------------- | ---------------------------------- |
| id           | uuid        | PK                      |                                    |
| household_id | uuid        | FK, not null            |                                    |
| name         | text        | not null                | Male / Female / Home（以后加 Kid） |
| kind         | member_kind | not null                | Home = `shared`，Kid = `child`     |
| sort_order   | integer     | not null, default 0     |                                    |
| is_archived  | boolean     | not null, default false |                                    |
| created_at   | timestamptz | not null                |                                    |

唯一：`(household_id, name)`

### financial_account

银行账户和现金账户。

| 字段              | 类型         | 约束                    | 说明                                                        |
| ----------------- | ------------ | ----------------------- | ----------------------------------------------------------- |
| id                | uuid         | PK                      |                                                             |
| household_id      | uuid         | FK, not null            |                                                             |
| name              | text         | not null                | 如 "ANZ Joint"、"现金（我）"                                |
| bank              | bank         | not null                | 决定用哪个解析器；anz_plus 只能导 PDF 对账单（R1D），cash、other 不能导入（R1） |
| type              | account_type | not null                |                                                             |
| default_member_id | uuid         | FK → member, not null   |                                                             |
| number_suffix     | varchar(6)   | null                    | 账号尾号，4 到 6 位数字，用于识别内部转账；现金账户为空     |
| purpose           | account_purpose | not null, default `everyday` | 用途（R23.4）。M9-3 建 |
| linked_account_id | uuid         | FK → financial_account, null | 关联账户，最多一个（R23.4）。不级联（账户只软删除）。M9-3 建 |
| is_archived       | boolean      | not null, default false |                                                             |
| created_at        | timestamptz  | not null                |                                                             |

唯一：`(household_id, name)`
检查：`number_suffix ~ '^[0-9]{4,6}$'`（不为空时）；`linked_account_id <> id`（M9-3 建）。别的校验（同家庭、没归档、不是现金）在 R23.4 的代码里做

**不存完整账号、BSB。**

### account_balance（M9-3 建）

手动填的余额锚点（R23.1、R23.3），包括新建账户时自动写的开户余额。PDF 对账单的锚点不存这里，用 `import_batch` 的 `closing_balance_cents` + `date_to`。

| 字段          | 类型        | 约束                             | 说明                                   |
| ------------- | ----------- | -------------------------------- | -------------------------------------- |
| id            | uuid        | PK                               |                                        |
| household_id  | uuid        | FK, not null                     |                                        |
| account_id    | uuid        | FK → financial_account, not null |                                        |
| date          | date        | not null                         | 这一天**结束时**的余额，不晚于填的那天 |
| balance_cents | integer     | not null                         | 可以是 0 或负数（信用卡）              |
| created_by    | text        | FK → user.id, not null           |                                        |
| created_at    | timestamptz | not null                         | 同一天几条时取最晚的（R23.1）          |

索引：`(account_id, date)`
- 不加 `(account_id, date)` 唯一：同一天可以有几条，取 `created_at` 最晚的
- 只能硬删除，不能改（R23.3）。差额实时算，不存

### account_condition（M10-4 建）

每月条件的配置（R24.1）。判断结果不存，每次实时算。

| 字段           | 类型              | 约束                             | 说明 |
| -------------- | ----------------- | -------------------------------- | ---- |
| id             | uuid              | PK                               |      |
| household_id   | uuid              | FK, not null                     |      |
| account_id     | uuid              | FK → financial_account, not null | 配条件的账户。关联类型看的是它的 `linked_account_id`，不另存 |
| type           | condition_type    | not null                         |      |
| outcome        | condition_outcome | not null                         | 拿 bonus / 免月费 |
| amount_cents   | integer           | null                             | `min_deposit`、`linked_min_deposit` 的金额 |
| deposit_filter | deposit_filter    | null                             | `min_deposit`、`linked_min_deposit` 的"哪些存入算数"（R24.3） |
| card_count     | integer           | null                             | `linked_card_count` 的笔数 |
| description    | text              | null                             | `other` 的文字 |
| effective_from | date              | not null                         | 月初日期，从这个月开始判断 |
| disabled_from  | date              | null                             | 月初日期，从这个月起不判断；`null` = 在用 |
| created_by     | text              | FK → user.id, not null           |      |
| created_at     | timestamptz       | not null                         |      |

索引：`(account_id)`
检查：
- `effective_from`、`disabled_from` 是月初（`extract(day from …) = 1`）；`disabled_from >= effective_from`（不为空时）
- 参数和类型对得上：
  - `min_deposit`、`linked_min_deposit`：`amount_cents > 0`、`deposit_filter` 不为空，`card_count`、`description` 为空
  - `linked_card_count`：`card_count >= 1`，其他参数为空
  - `other`：`description` 不为空，其他参数为空
  - `no_withdrawal`、`balance_growth`：参数都为空
- 不删：修改 = 停用旧的、建新的；删除 = 停用（R24.1）。所以没有 `is_archived`
- 别的校验（本家庭、没归档、有关联账户、生效月份不晚于本月）在 R24.1 的代码里做

### account_condition_check（M10-4 建）

"其他"类型每月的手动勾（R24.7）。

| 字段         | 类型        | 约束                             | 说明 |
| ------------ | ----------- | -------------------------------- | ---- |
| id           | uuid        | PK                               |      |
| household_id | uuid        | FK, not null                     |      |
| condition_id | uuid        | FK → account_condition, not null | 只有 `type = other` 的（应用层保证） |
| month        | date        | not null                         | 月初日期 |
| is_met       | boolean     | not null                         | 满足了 / 没满足 |
| created_by   | text        | FK → user.id, not null           | 最后勾的人 |
| updated_at   | timestamptz | not null                         |      |

唯一：`(condition_id, month)`
检查：`month` 是月初
- 改 = 更新这一行；清掉（回到"还没勾"）= 硬删除这一行

### card

卡号后四位映射到归属人。

| 字段         | 类型    | 约束                             | 说明            |
| ------------ | ------- | -------------------------------- | --------------- |
| id           | uuid    | PK                               |                 |
| household_id | uuid    | FK, not null                     |                 |
| account_id   | uuid    | FK → financial_account, not null |                 |
| last4        | char(4) | not null                         |                 |
| member_id    | uuid    | FK → member, not null            |                 |
| label        | text    | null                             | 如 "我的借记卡" |

唯一：`(account_id, last4)`

### category

两级分类。一级 `parent_id` 为空。

| 字段               | 类型                | 约束                    | 说明                                                            |
| ------------------ | ------------------- | ----------------------- | --------------------------------------------------------------- |
| id                 | uuid                | PK                      |                                                                 |
| household_id       | uuid                | FK, not null            |                                                                 |
| parent_id          | uuid                | FK → category, null     | 为空 = 一级分类                                                 |
| name_zh            | text                | null                    | 中文名，可选                                                    |
| name_en            | text                | not null                |                                                                 |
| kind               | category_kind       | not null                | 子分类必须和父分类相同                                          |
| system_key         | system_category_key | null                    | 只有系统分类有                                                  |
| default_member_id  | uuid                | FK → member, null       | 分类默认归属人（如 Groceries → Home），二级为空时继承一级（R5） |
| is_pre_tax_default | boolean             | not null, default false | 只对 income 分类有意义（如 Interest、Contract income）          |
| is_other           | boolean             | not null, default false | 每个一级自动建的 "Other" 二级，不能删除                         |
| sort_order         | integer             | not null, default 0     |                                                                 |
| is_archived        | boolean             | not null, default false |                                                                 |

唯一：`(household_id, parent_id, name_en)`；`(household_id, system_key)`（不为空时）
应用层保证：最多两级；系统分类不能删除、不能改 `kind`；新建一级分类时自动建一个 Other 二级。
`name_zh` 允许为空，为空时界面显示 `name_en`。

### category_rule

关键词 → 分类。

| 字段         | 类型            | 约束                         | 说明                                   |
| ------------ | --------------- | ---------------------------- | -------------------------------------- |
| id           | uuid            | PK                           |                                        |
| household_id | uuid            | FK, not null                 |                                        |
| keyword      | text            | not null                     | 存大写                                 |
| match_type   | rule_match_type | not null, default `contains` |                                        |
| category_id  | uuid            | FK → category, not null      | 指向二级分类（没有二级时可以指向一级） |
| priority     | integer         | not null, default 0          | 越大越优先                             |
| is_system    | boolean         | not null, default false      | 预置规则                               |
| created_at   | timestamptz     | not null                     |                                        |

唯一：`(household_id, keyword, match_type)`

### import_batch

每次 CSV 导入一条记录，用于审计、撤销和对账。

| 字段                  | 类型        | 约束                             | 说明                                              |
| --------------------- | ----------- | -------------------------------- | ------------------------------------------------- |
| id                    | uuid        | PK                               |                                                   |
| household_id          | uuid        | FK, not null                     |                                                   |
| account_id            | uuid        | FK → financial_account, not null |                                                   |
| file_name             | text        | not null                         |                                                   |
| source                | text        | not null, default `csv`          | `csv` / `pdf`（ANZ 对账单，R1C；M6.6 加）。R12.2 找上一份对账单用 |
| date_from             | date        | not null                         | 文件里最早日期；PDF 是账期开始日的**第二天**（R1C） |
| date_to               | date        | not null                         | 文件里最晚日期；PDF 是账期结束日                  |
| row_count             | integer     | not null                         | 文件有效行数                                      |
| inserted_count        | integer     | not null                         | 新增                                              |
| duplicate_count       | integer     | not null                         | 跳过的重复                                        |
| matched_pending_count | integer     | not null                         | 确认的 pending                                    |
| opening_balance_cents | integer     | null                             | 用于对账。ANZ CSV 手动填（可选），ANZ PDF 从汇总页读（R1C），CBA 自动算（R1B.2） |
| closing_balance_cents | integer     | null                             | 同上                                              |
| reconciled            | boolean     | null                             | 没有余额时为空                                    |
| warnings              | jsonb       | null                             | 导入警告，如 CBA 余额不连续（R1B.1）              |
| created_by            | text        | FK → user.id, not null           |                                                   |
| created_at            | timestamptz | not null                         |                                                   |

**不保存上传的原始文件**（CSV 和 PDF 都不存）。

### transaction

| 字段             | 类型               | 约束                             | 说明                                   |
| ---------------- | ------------------ | -------------------------------- | -------------------------------------- |
| id               | uuid               | PK                               |                                        |
| household_id     | uuid               | FK, not null                     |                                        |
| account_id       | uuid               | FK → financial_account, not null |                                        |
| date             | date               | not null                         | 银行入账日期；手动录入为录入时填的日期 |
| amount_cents     | integer            | not null, ≠ 0                    | 正收入负支出                           |
| raw_description  | text               | not null                         | **脱敏后**的原始描述                   |
| merchant         | text               | not null                         | 清洗后的商家名                         |
| card_last4       | char(4)            | null                             | 从描述里提取                           |
| balance_cents    | integer            | null                             | 银行给的余额（CBA 有，ANZ 没有）       |
| status           | transaction_status | not null                         |                                        |
| source           | transaction_source | not null                         | `csv` = 银行导入，ANZ PDF 对账单（R1C）进来的也是 `csv`，批次来源看 `import_batch.source`（M6.6-4 定） |
| transfer_status  | transfer_status    | not null, default `none`         |                                        |
| transfer_pair_id | uuid               | FK → transaction, null           | 对应的另一半转账。外键不级联，撤销导入时先清空两边（R12.1） |
| dedupe_key       | text               | null                             | 只有来自 CSV 的交易有                  |
| import_batch_id  | uuid               | FK → import_batch, null          |                                        |
| note             | text               | null                             | 用户备注                               |
| created_by       | text               | FK → user.id, not null           | 录入人                                 |
| created_at       | timestamptz        | not null                         |                                        |
| updated_at       | timestamptz        | not null                         |                                        |
| confirmed_at     | timestamptz        | null                             | pending 被确认的时间                   |

唯一：`(account_id, dedupe_key)`（`dedupe_key` 不为空时，partial unique index）
索引：`(household_id, date)`、`(account_id, date)`、`(household_id, status)`、`(household_id, merchant)`

### transaction_split

**分类和归属人在这张表上，不在 transaction 上。** 普通交易只有一行。

| 字段            | 类型    | 约束                                          | 说明                                                                                   |
| --------------- | ------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| id              | uuid    | PK                                            |                                                                                        |
| household_id    | uuid    | FK, not null                                  |                                                                                        |
| transaction_id  | uuid    | FK → transaction, not null, on delete cascade |                                                                                        |
| amount_cents    | integer | not null, ≠ 0                                 | 符号和所属交易一致                                                                     |
| category_id     | uuid    | FK → category, not null                       |                                                                                        |
| member_id       | uuid    | FK → member, not null                         |                                                                                        |
| category_source | text    | not null                                      | `rule` / `manual` / `system`，用来判断能否被规则覆盖                                   |
| is_primary      | boolean | not null, default false                       | 主拆分，拆出其他部分后剩余金额留在这里；每笔交易恰好一个                               |
| member_source   | text    | not null                                      | `manual` / `category` / `card` / `account`，非 manual 时改分类会重新计算归属人（R5.1） |
| is_pre_tax      | boolean | not null, default false                       | 税前收入，用于税后估算（R14）                                                          |
| note            | text    | null                                          |                                                                                        |
| is_one_off      | boolean | null                                          | M7.7-4 加（2026-11-01）。一次性开销：`null` 没看过 / `true` 是 / `false` 确认不是。只有支出口径的拆分会有非 `null` 的值（R22.1、R22.2） |
| goal_id         | uuid    | FK → goal, null, on delete restrict           | **M11-4 加，待确认**。挂的目标（R25.7）。只有支出口径的拆分会有值；怎么变见 R25.8 |

索引：`(household_id, category_id)`、`(household_id, member_id)`、`(transaction_id)`、`(goal_id)`（M11-4 加）
应用层保证：同一交易所有拆分的 `amount_cents` 合计 = 交易的 `amount_cents`；至少有一行；恰好一行 `is_primary = true`。拆分规则见 R15。
唯一：`(transaction_id)` where `is_primary`（partial unique index）

### receipt（M6.7，2026-10-27 加）

小票识别的结果，挂在一笔交易上（R20）。**不存图片。**

| 字段           | 类型        | 约束                                           | 说明                                                                 |
| -------------- | ----------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| id             | uuid        | PK                                             |                                                                      |
| household_id   | uuid        | FK, not null                                   |                                                                      |
| transaction_id | uuid        | FK → transaction, null, **on delete set null** | 挂的交易。为空 = 没挂上（撤销导入、删了交易以后，R20.7）             |
| merchant       | text        | not null                                       | 小票上的店名，R20.2 整理后（脱敏，最长 100）                         |
| receipt_date   | date        | not null                                       | 小票日期                                                             |
| total_cents    | integer     | not null, > 0                                  | 小票总额，正数                                                       |
| parsed_json    | jsonb       | not null                                       | `{ items: [{ name, amountCents, category, type }], discounts: [{ label, amountCents }], payment: 'card' \| 'cash' \| 'unknown' }`，用户核对后的版本。**不含卡号、人名**。`type` 是商品类型（R21.1 的 key），M7.6 以前存的没有，读的时候可选 |
| reader         | text        | not null                                       | 用哪个 reader 读的（R20.1）：`llm:<模型名>`、`text`、`manual`（识别失败或 `none` 时手动填的） |
| created_by     | text        | FK → user.id, not null                         |                                                                      |
| created_at     | timestamptz | not null                                       |                                                                      |

唯一：`(transaction_id)`（不为空时，partial unique index）
索引：`(household_id, receipt_date)`

`transaction.source = receipt` 表示交易是小票建的（R20.5）；挂到已有交易上的小票不改交易的 `source`。

### item_type_rule（M7.6-4，2026-11-01 加）

从用户手动改商品类型里学到的：商品名 → 商品类型（R21.5）。预置关键词在代码里，不在这张表。

| 字段         | 类型        | 约束                   | 说明                                                       |
| ------------ | ----------- | ---------------------- | ---------------------------------------------------------- |
| id           | uuid        | PK                     |                                                            |
| household_id | uuid        | FK, not null           |                                                            |
| name_key     | text        | not null               | 规范化后的商品名（`normalizeItemName`，大写、单空格，最长 100） |
| item_type    | item_type   | not null               | R21.1 的 key（不含 `untyped`）                               |
| created_by   | text        | FK → user.id, not null | 最后一次改的人                                             |
| updated_at   | timestamptz | not null               | 最后一次改的时间                                           |

唯一：`(household_id, name_key)`。同名再学一次就 upsert 覆盖（最后一次为准）。

### budget

| 字段                | 类型        | 约束                    | 说明             |
| ------------------- | ----------- | ----------------------- | ---------------- |
| id                  | uuid        | PK                      |                  |
| household_id        | uuid        | FK, not null            |                  |
| category_id         | uuid        | FK → category, not null | 一级或二级       |
| monthly_limit_cents | integer     | not null, > 0           | 正数             |
| warn_at_percent     | integer     | not null, default 80    | 到多少百分比提醒 |
| is_pinned           | boolean     | not null, default false | 固定在首页       |
| created_at          | timestamptz | not null                |                  |

唯一：`(household_id, category_id)`

### goal（M11-4 建，待确认）

目标和应急金（R25.1）。进度、每月要存、预计达成、应急金金额都不存，每次实时算。

| 字段             | 类型            | 约束                              | 说明 |
| ---------------- | --------------- | --------------------------------- | ---- |
| id               | uuid            | PK                                |      |
| household_id     | uuid            | FK, not null                      |      |
| name             | text            | not null                          | 最长 50（R25.1） |
| type             | goal_type       | not null                          |      |
| recurrence       | goal_recurrence | not null, default `once`          |      |
| target_cents     | integer         | null                              | 应急金是 `null`（自动算，R25.6），其他 > 0 |
| target_date      | date            | null                              | `yearly` 必填 |
| account_id       | uuid            | FK → financial_account, null      | 挂的账户，最多一个。不级联（账户只软删除） |
| priority         | integer         | not null                          | 全家一个顺序；应急金存 0 |
| is_emergency     | boolean         | not null, default false           |      |
| emergency_months | integer         | null                              | 应急金的月数，1 到 24 |
| is_pinned        | boolean         | not null, default false           | 固定到首页 |
| status           | goal_status     | not null, default `active`        |      |
| done_at          | timestamptz     | null                              | `done` 时记 |
| prev_goal_id     | uuid            | FK → goal, null, on delete set null | `yearly` 自动建的下一期指向上一期（R25.9 撤销完成用） |
| created_by       | text            | FK → user.id, not null            |      |
| created_at       | timestamptz     | not null                          |      |

索引：`(household_id, status)`、`(account_id)`
唯一：`(household_id)` where `is_emergency`（一个家庭最多一个应急金）
检查：
- `is_emergency` 时：`type = keep`、`recurrence = once`、`target_cents` 为空、`emergency_months between 1 and 24`、`status = active`
- 不是应急金时：`target_cents > 0`、`emergency_months` 为空
- `recurrence = yearly` 时：`type = spend`、`target_date` 不为空
- `status = done` ⇔ `done_at` 不为空
- 删除是硬删除（没有 `is_archived`），挂了交易的不能删（R25.9，`transaction_split.goal_id` 是 `restrict`）
- 名字查重（`active` 里不区分大小写）、账户校验（本家庭、没归档、不是现金）在 R25.1 的代码里做
- `priority` 不加唯一：上下移动时两行交换会撞，代码保证 `active` 的不重复

### tax_profile

每个人每个财年的工资信息，来自工资单或 myGov income statement，手动填写。用于税后估算（R14）。

| 字段                | 类型        | 约束                  | 说明                                |
| ------------------- | ----------- | --------------------- | ----------------------------------- |
| id                  | uuid        | PK                    |                                     |
| household_id        | uuid        | FK, not null          |                                     |
| member_id           | uuid        | FK → member, not null | 只能是 kind = person                |
| financial_year      | smallint    | not null              | 财年开始的年份，2026 = 2026-27 财年 |
| payg_gross_cents    | integer     | not null, default 0   | 全年工资税前总额（实际或预计）      |
| payg_withheld_cents | integer     | not null, default 0   | 全年雇主已代扣的税                  |
| updated_at          | timestamptz | not null              |                                     |

唯一：`(member_id, financial_year)`

**税率表不进数据库**，按财年写在 `src/lib/tax/rates.ts`。

---

## 4. 关系图

```
household ─┬─ household_user ── user (Better Auth)
           ├─ member ── tax_profile
           ├─ financial_account ─┬─ card
           │                     └─ account_condition ── account_condition_check
           ├─ category (自引用 parent_id，default_member_id → member) ── category_rule
           ├─ import_batch
           ├─ transaction ─┬─ transaction_split ── category / member / goal
           │               └─ receipt（0 或 1 张）
           ├─ budget ── category
           └─ goal ── financial_account（0 或 1 个）
```

---

## 5. 后续表（MVP 不建）

```
tag               id, household_id, name
transaction_tag   transaction_id, tag_id
```

Female 没有注册 GST（2026-10-23 确认）。以后注册了，可以在 `transaction_split` 加 `gst_cents integer null`，B2B 收入里的 GST 部分不算收入。

---

## 6. 种子数据

首次运行 seed 脚本时创建：

- 1 个 household
- 3 个 member：Male（person）、Female（person）、Home（shared）
- 分类和预置规则：见 `seed-categories.md`
- 账户和卡号映射：开发时手动配置，不放进 seed（避免真实尾号进 git）
