# Hearth 业务规则

> 这份文档是核心逻辑的唯一标准。每条规则都要有对应的单元测试，测试用例直接从这里的例子来。
> 规则代码放在 `src/lib/import/`、`src/lib/rules/`、`src/lib/tax/`，全部是纯函数，不碰数据库。
> 规则编号（R1、R2…）在代码注释和测试名里引用，方便对照。

---

## R1. CSV 解析

**输入**：CSV 文件文本 + 账户的银行
**输出**：`ParsedRow[]`，每行 `{ date: 'YYYY-MM-DD', amountCents: number, description: string, balanceCents: number | null, rowIndex: number }`

按 `financial_account.bank` 选解析器：

| bank                  | 解析器 | 说明                               |
| --------------------- | ------ | ---------------------------------- |
| anz                   | R1A    |                                    |
| cba                   | R1B    |                                    |
| anz_plus、cash、other | 无     | 不能导入 CSV，只能手动录入（R8.1） |

### R1.0 两个解析器共用的规则

> 引用下面某一条时写 `R1.0-N`，如 `R1.0-4` 是金额。

1. 用 Papa Parse 解析，兼容带引号和不带引号的列
2. 跳过空行和只有空白的行；支持 CRLF 和 LF
3. 日期 `DD/MM/YYYY` → `YYYY-MM-DD`，非法日期报错
4. 金额**按字符串转成分**，不用 `parseFloat` 再乘 100（会有浮点误差）。允许前面带 `+` 或 `-`
   - `"-58.40"` → `-5840`
   - `"+500.00"` → `50000`
   - `"2000.00"` → `200000`
   - `"0.72"` → `72`
   - `"5"` → `500`
   - 金额为 0 报错
5. 描述：去掉首尾空白，**保留中间原样**（清洗在 R3 做）
6. 任意一行出错 → 整个文件解析失败，错误信息带行号，**不导入任何一行**
7. 输出顺序和文件一致（两家银行都是新的在前），不在解析层排序

### R1A ANZ

- 没有表头，3 列：日期、金额、描述
- 金额带引号，描述不带引号
- 描述不带引号，里面有逗号时会被切成 4 列以上：第 3 列以后用 `,` 拼回去当描述。少于 3 列报错
- `balanceCents` 为 `null`

| 输入行                                                                                | 输出                                                                                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `29/09/2026,"-58.40",VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE`              | `{ date: '2026-09-29', amountCents: -5840, description: 'VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE', balanceCents: null }` |
| `02/09/2026,"2000.00",ANZ M-BANKING FUNDS TFER TRANSFER 815033  FROM       400006691` | `{ date: '2026-09-02', amountCents: 200000, ... }`                                                                                  |
| `31/02/2026,"-1.00",X`                                                                | 报错：第 n 行日期非法                                                                                                               |
| 空行                                                                                  | 跳过                                                                                                                                |

### R1B CBA（2026-10 用真实导出确认）

- 没有表头，4 列：日期、金额、描述、余额，**全部带引号**
- 金额和余额都带正负号：`"+500.00"`、`"-20.00"`、`"+12345.67"`
- 同一天里也是新的在前

| 输入行                                                                      | 输出                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `21/10/2026,"+500.00","Transfer from xx5678 CommBank app Home","+12345.67"` | `{ date: '2026-10-21', amountCents: 50000, description: 'Transfer from xx5678 CommBank app Home', balanceCents: 1234567 }` |

### R1B.1 余额连续性检查

对相邻两行（文件顺序，第 i 行比第 i+1 行新）：

```
balance[i] − amount[i] == balance[i+1]
```

- 不成立 → **不报错**，导入照常进行，导入结果里显示警告"第 i 行和第 i+1 行之间余额不连续"
- 这能发现文件被手动改过、或银行导出不完整

### R1B.2 自动得出期初期末余额

- 期末 = 第一行（最新）的余额
- 期初 = 最后一行（最旧）的余额 − 最后一行的金额
- 自动填进 `import_batch` 的 `opening_balance_cents`、`closing_balance_cents`，然后跑 R9，不用手动填

---

## R2. 提取和脱敏

在清洗之前做。顺序：**先提取，再脱敏**。

### R2.1 提取卡号后四位

- 正则：`/\bCARD (?:XX)?(\d{4})\b/i`
- ANZ：`VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE` → `1111`
- CBA：`Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026` → `1234`
- 没有匹配 → `null`

### R2.2 提取转账对方账号

- 只在描述含 `FUNDS TFER` 或 `TRANSFER` 时提取（不区分大小写）
- 两种格式：
  - 完整账号（ANZ）：`/\b(?:FROM|TO)\s+(\d{8,})\b/i`
  - 银行已经打码的尾号（CBA）：`/\b(?:FROM|TO)\s+XX(\d{4})\b/i`
- `TRANSFER 681801  TO  012345400006691` → `012345400006691`
- `TRANSFER 815033  FROM       400006691` → `400006691`
- `Transfer from xx5678 CommBank app Home` → `5678`
- `Transfer To MISS X Y PayID Phone from CommBank App Eat Eat` → `null`（PayID 转账只有人名，没有账号）
- 注意 `681801`、`815033` 是转账流水号，不是账号，不提取
- 提取出的数字**只在内存里用于 R6 匹配，不入库**

### R2.3 脱敏

- 把描述里所有**连续 8 位及以上的数字**替换成 `****` + 后 4 位
- `TO  012345400006691` → `TO  ****6691`
- `FROM       400006691` → `FROM       ****6691`
- `EASI AU 280672605`（9 位）→ `EASI AU ****2605`（宁可多脱敏）
- CBA 的 BPAY 客户号、贷款号、直接扣款参考号也会被脱敏：`LN REPAY 700006979` → `LN REPAY ****6979`
- BPAY 账单码 `{022288}`（6 位）、门店号 `0559`、卡号后四位、流水号 `681801`（6 位）、CBA 的 `xx5678` **不受影响**

---

## R3. 清洗商家名

**输入**：脱敏后的描述
**输出**：`merchant`（大写字符串）

ANZ 和 CBA 用同一套步骤，不适用的步骤自然不生效。按顺序执行：

1. 转大写
2. 去掉 ANZ 交易类型前缀（只去开头）：
   - `VISA DEBIT PURCHASE CARD \d{4}`
   - `ANZ INTERNET BANKING BPAY` → 替换成 `BPAY`
   - `ANZ M-BANKING FUNDS TFER` → 替换成 `TRANSFER`，并去掉后面的 `TRANSFER \d+`
   - `EFTPOS`
   - `NON-ANZ ATM` → 替换成 `ATM`
3. 去掉 CBA 的附加信息：
   - ` VALUE DATE: \d{2}/\d{2}/\d{4}`
   - ` AUS CARD XX\d{4}`
   - CBA 的 BPAY：`^(.+?) COMMBANK APP BPAY .*$` → `BPAY $1`（和 ANZ 的格式统一）
   - 转账里的 ` TO PAYID PHONE`、` PAYID PHONE`、` FROM COMMBANK APP`、` COMMBANK APP`
4. 去掉开头的支付通道前缀：`ZLR*`、`SQ *`、`SMP*`、`LS `、`\d+PIN* `（如 `794PIN*`）
5. 去掉 BPAY 账单码：`\{\d+\}`
6. 反斜杠 `\` 替换成空格
7. 连续空白合并成一个空格，去掉首尾空白
8. 反复去掉结尾的地区词：`AU`、`AUS`、`VI`、`VIC`、`VICAU`、`NS`、`NSW`（至少保留一个词）

| 脱敏后描述                                                             | merchant                                 |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE`                   | `COLES 0559 MELBOURNE`                   |
| `EFTPOS MELB ASIAN MARKET\`                                            | `MELB ASIAN MARKET`                      |
| `EFTPOS SECRET KITCHEN     \MELBOURNE         AU`                      | `SECRET KITCHEN MELBOURNE`               |
| `EFTPOS 794PIN* CHARGEFOX PTY LTD\NORTH MELBOUR\`                      | `CHARGEFOX PTY LTD NORTH MELBOUR`        |
| `ANZ INTERNET BANKING BPAY SEENE                         {022288}`     | `BPAY SEENE`                             |
| `ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ****6691`               | `TRANSFER TO ****6691`                   |
| `EFTPOS ZLR*POCHANA MELBOURNE \MELBOURNE AU`                           | `POCHANA MELBOURNE MELBOURNE`            |
| `VISA DEBIT PURCHASE CARD 2222 SQ *KUMO MELBOURNE`                     | `KUMO MELBOURNE`                         |
| `NON-ANZ ATM CBA\HAWTHORN VIC AU`                                      | `ATM CBA HAWTHORN`                       |
| `ACCOUNT SERVICING FEE`                                                | `ACCOUNT SERVICING FEE`                  |
| `Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026`     | `MYER PTY LTD DOCKLANDS`                 |
| `myki tap Transport VIC VIC VI AUS Card xx1234 Value Date: 29/08/2026` | `MYKI TAP TRANSPORT`                     |
| `ZLR*Tower Sushi & Gourm Melbourne AU`                                 | `TOWER SUSHI & GOURM MELBOURNE`          |
| `MCDONALDS VIC MARKET MELBOURNE VICAU`                                 | `MCDONALDS VIC MARKET MELBOURNE`         |
| `seene CommBank app BPAY 959502 ****9999`                              | `BPAY SEENE`                             |
| `DEFT PAYMENTS CommBank app BPAY 96503 ****7890 INV No 0012345`        | `BPAY DEFT PAYMENTS`                     |
| `Transfer To TEST FRIEND PayID Phone from CommBank App Eat Eat`        | `TRANSFER TO TEST FRIEND EAT EAT`        |
| `Fast Transfer From OTHER FRIEND to PayID Phone dinner`                | `FAST TRANSFER FROM OTHER FRIEND DINNER` |
| `Transfer from xx7777 CommBank app Home`                               | `TRANSFER FROM XX7777 HOME`              |
| `LIGHTNING BROADBAND Value Date: 11/09/2026`                           | `LIGHTNING BROADBAND`                    |

清洗结果不需要完美，分类规则用关键词包含匹配，门店号、地名多出来不影响。

**CBA 的已知问题**：转账备注里的中文导出后会变成下划线（如 `Transfer To Y CHENG ... __`），所以转账备注最好用英文写，规则才能匹配。

---

## R4. 去重

### R4.1 生成 key

```
dedupe_key = sha256( account_id | date | amount_cents | normalizedDescription | occurrence | balance_cents )
```

- `balance_cents`：CBA 有余额，写进 key；ANZ 没有，写空字符串
- `normalizedDescription`：**脱敏后**的原始描述，转大写，连续空白合并为一个空格，去首尾空白（不是 merchant，清洗规则以后会改，key 不能跟着变）
- `occurrence`：同一个文件内，`(date, amount_cents, normalizedDescription)` 完全相同的第几笔，从 1 开始，按文件里的出现顺序计数

### R4.2 导入时

- 数据库里已有相同 `(account_id, dedupe_key)` → 跳过，计入 `duplicate_count`
- 没有 → 继续走 R8（pending 匹配）和插入

| 场景                                                   | 结果                              |
| ------------------------------------------------------ | --------------------------------- |
| 文件里同一天同店两笔 `-4.50`                           | occurrence 1 和 2，两笔都插入     |
| 同一个文件导入两次                                     | 第二次全部跳过                    |
| 9 月 1 到 30 日已导入，再导 9 月 15 日到 10 月 15 日   | 9 月 15 到 30 日跳过，10 月的插入 |
| 先导的文件里某天有 2 笔相同，后导的文件里同一天有 3 笔 | 前 2 笔跳过，第 3 笔插入          |

**已知风险**：如果银行在两次导出之间改了某笔的描述，会被当成新交易。用 R9 对账发现。

---

## R5. 归属人

归属人的含义是**钱用在谁身上**，不是谁付的钱。卡号只能说明谁付的，所以优先级排在分类后面。

**R5 在 R7 分类之后执行**，因为要用到分类。

每笔新交易的拆分 `member_id`，按优先级，`member_source` 记录用的是哪一条：

| 优先级 | 来源                                                                | member_source |
| ------ | ------------------------------------------------------------------- | ------------- |
| 1      | 手动指定（手动录入，或用户在 F8 改过）                              | manual        |
| 2      | 分类默认：二级分类的 `default_member_id`，为空时用一级的            | category      |
| 3      | 卡号映射：`card` 表里 `(account_id, card_last4)` 对应的 `member_id` | card          |
| 4      | 账户的 `default_member_id`                                          | account       |

系统分类和 Uncategorised 没有分类默认，直接走 3、4。

| 账户                       | 卡              | 分类                     | 结果                 |
| -------------------------- | --------------- | ------------------------ | -------------------- |
| Joint（默认 Home）         | `1111 → Male`   | Coffee & tea             | Male（card）         |
| Joint（默认 Home）         | `1111 → Male`   | Groceries / Supermarket  | **Home**（category） |
| Joint（默认 Home）         | `2222 → Female` | Uncategorised            | Female（card）       |
| Joint（默认 Home）         | 没有卡号        | Restaurants              | Home（account）      |
| Joint（默认 Home）         | `9999` 未登记   | Uncategorised            | Home（account）      |
| Male 个人账户（默认 Male） | 没有卡号        | Home & utilities / Water | **Home**（category） |
| Male 个人账户（默认 Male） | 没有卡号        | Public transport         | Male（account）      |

### R5.1 分类改变时重新计算

分类因为任何原因改变（手动改、规则重新应用、pending 确认除外），如果 `member_source != manual`，按上表重新计算归属人。`manual` 的永远不动。

---

## R6. 内部转账识别

### R6.1 自动识别（导入时）

条件全部满足：

- 描述含 `FUNDS TFER` 或 `TRANSFER`
- R2.2 提取出了对方账号数字
- 这个数字和本家庭某个 `financial_account.number_suffix` **尾部对得上**，且不是当前账户自己
  - 提取的数字以尾号结尾（ANZ 完整账号的情况），或
  - 尾号以提取的数字结尾（CBA 只给 4 位的情况）

结果：`transfer_status = auto`，分类设为系统分类"内部转账"，`category_source = system`

- 对上**多个**家庭账户（如提取到 `5678`，家里有 `115678` 和 `225678`）→ 不认成转账，走 R7，留给 R6.3 兜底
- 没有尾号的账户（现金）不参与匹配

| 对方账号          | 家庭账户尾号    | 结果                       |
| ----------------- | --------------- | -------------------------- |
| `012345400006691` | 某账户 `6691`   | auto                       |
| `400006691`       | 某账户 `6691`   | auto                       |
| `400006691`       | 某账户 `006691` | auto（尾号 4 到 6 位都行） |
| `400006747`       | 没有匹配        | 不是内部转账，走 R7        |
| `5678`（CBA）     | 某账户 `5678`   | auto                       |
| `5678`（CBA）     | 某账户 `115678` | auto                       |
| `5678`（CBA）     | 某账户 `0567`   | 不匹配                     |

**PayID 转账没有账号**（如 `Fast Transfer From <人名>`），R6.1 认不出来，靠 R6.2 配对或 R6.3 兜底。

### R6.2 配对

每次导入完成后，对**整个家庭**里还没配对的 `auto` 转账（包括以前导入的），在对方账户里找另一半：

- 对方账户 = R6.1 匹配到的那个账户
- 金额相反（`a = -b`）
- 日期相差 ≤ 2 天
- 对方那笔还没配对

找到恰好 1 笔 → 两边互相写 `transfer_pair_id`。另一半如果还不是转账（比如 CBA 那边只显示人名，被分成了 Uncategorised）：

- `transfer_status` 改成 `auto`，分类改成内部转账，`category_source = system`
- 如果另一半的分类是 `manual`，不改它，只配对，并在 F8 提示。`transfer_status` 也不改（保持 `none`），因为 auto 不计收支，改了等于把手动分类从统计里抹掉

找到 0 笔（对方账户还没导入）或多笔 → 不配对，不影响它被标成转账。

为什么要对整个家庭重跑：先导 ANZ joint、后导 CBA 时，转账的识别发生在 ANZ 那边，要等 CBA 导进来才找得到另一半。

### R6.3 兜底建议

导入完成后，对**本次导入新插入的**交易里，**不是**转账、且属于"未分类"的：

- 在本家庭其他账户里找：金额相反、日期相差 ≤ 2 天、也是未分类、还没配对（候选可以是以前导入的）
- 恰好 1 个候选 → 两边都标 `transfer_status = suggested`，配对
  - "恰好 1 个"要求**两边互相**都只有对方这一个候选。A 只有 B，但 B 有 A 和 C 两个候选 → 不建议
- 只从本次新插入的交易出发，是为了每一对只在后导入的那一边进来时检查一次。拒绝过的两笔都是旧交易，以后的导入不会再建议（撤销后重新导入会再建议一次，可以接受）
- 为什么只建议不自动生效：朋友 AA 的转账（PayID，R6.1 认不出）可能刚好和另一笔金额相反、日期接近，要人来判断

确认前**按普通交易统计**（还是未分类）。在 F8 里确认或拒绝，两边一起改：

| 字段             | 确认                                  | 拒绝       |
| ---------------- | ------------------------------------- | ---------- |
| transfer_status  | `confirmed`                           | `none`     |
| 分类             | 内部转账                              | 保持未分类 |
| category_source  | `manual`（人决定的，R7.2 不会覆盖）   | 不变       |
| transfer_pair_id | 保留                                  | 清空       |
| 归属人           | 不变（未分类和内部转账都没有分类默认，R5.1 重算结果一样） | 不变       |

---

## R7. 分类

对每笔新交易，按顺序，**第一个命中的生效**：

1. 已经被 R6.1 标为内部转账 → 内部转账
2. 系统规则（硬编码，不在 `category_rule` 表）：

   | 条件（merchant）                                 | 分类                                |
   | ------------------------------------------------ | ----------------------------------- |
   | 以 `ATM` 开头                                    | 现金支出（system: cash_withdrawal） |
   | 含 `ACCOUNT SERVICING FEE`（包括 `REVERSAL OF`） | 银行费用（system: bank_fee）        |

   其他银行费用（如信用卡利息）等拿到对应 CSV 后再加，不提前猜。

3. 用户规则（`category_rule` 表）：
   - 对 merchant 做匹配：`contains` 是包含，`starts_with` 是开头匹配，都不区分大小写
   - 多条命中时：`priority` 大的优先；相同时**关键词长的优先**（`DOWNTOWN GROCER` 优先于 `GROCER`）；再相同按创建时间早的
4. 都没命中 → 未分类（system: uncategorized）

`category_source`：1、2 写 `system`，3 写 `rule`，用户手动改的写 `manual`。

`is_pre_tax`：分类确定后，等于该分类的 `is_pre_tax_default`。用户可以单独改；之后分类再变时重新按分类设置。

### R7.1 正数金额（退款、报销）

- 正数交易同样走上面的规则
- 命中支出类规则（如 `MELB ASIAN MARKET` +0.72）→ 归到那个支出分类，在统计里**冲减**该分类支出（见 R10）
- 没命中 → 未分类，由用户决定是收入还是退款

### R7.2 重新应用规则

用户新建或修改规则后，可以选择对已有交易重新分类：

- **只改 `category_source = rule` 或未分类的交易**
- `manual` 和 `system` 的不动
- 分类变了的，按 R5.1 重新计算归属人
- **有多个拆分的交易跳过**，只处理只有一个拆分的交易

---

## R8. pending 交易匹配

### R8.1 手动录入时

| 账户                                            | status    | 原因                  |
| ----------------------------------------------- | --------- | --------------------- |
| bank = cash、anz_plus、other（没有 CSV 解析器） | confirmed | 不会有银行流水来确认  |
| bank = anz、cba                                 | pending   | 等导入 CSV 时匹配确认 |

ANZ Plus 只能看 PDF 对账单，利息每月手动记一笔（Income / Interest，税前），录入后直接 confirmed。

日期默认今天（`Australia/Melbourne`）。手动录入的交易没有 `dedupe_key`。

### R8.2 导入时匹配

对每笔通过去重检查（R4）的 CSV 行，在同账户的 `pending` 交易里找候选：

- `amount_cents` 完全相等
- CSV 日期 − pending 日期 ∈ [0, 3] 天（银行入账不会早于消费）
- 还没被本次导入的其他行匹配走

| 候选数 | 处理                                                 |
| ------ | ---------------------------------------------------- |
| 0      | 正常插入新交易                                       |
| 1      | **确认这笔 pending，不插入新交易**（见 R8.3）        |
| ≥ 2    | 正常插入新交易，两边都提示"可能重复"，让用户手动处理 |

### R8.3 确认时更新的字段

| 字段                                     | 处理                             |
| ---------------------------------------- | -------------------------------- |
| status                                   | → confirmed                      |
| date                                     | → 银行日期                       |
| raw_description、merchant、card_last4    | → 银行的                         |
| dedupe_key、import_batch_id              | → 填上                           |
| confirmed_at                             | → now()                          |
| 拆分（分类、归属人、note，包括多个拆分） | **保留用户录入的**，不用规则覆盖 |
| source                                   | 保留 `manual`                    |

**例外：银行那行是内部转账。** 确认时对银行那行跑 R6.1，认出是内部转账时 R6.1 优先：

- `transfer_status = auto`，主拆分分类改成内部转账，`category_source = system`
- 归属人按 R5.1（手动录入的是 `manual`，不动），备注保留
- pending 有多个拆分时不改，保留用户的拆分，在 F8 提示
- 之后照常参加 R6.2 配对

理由：手动录入时多半没想到这是转给自己的账户，按银行信息纠正更合理。转给朋友的钱 R6.1 认不出，不受影响。

### R8.4 导入后提示

导入完成后，该账户里日期 ≤ 本次 `date_to` − 3 天、仍是 pending 的交易 → 在导入结果页列出，提示检查。

---

## R9. 对账校验

有期初和期末余额时（ANZ 由用户手动填，CBA 按 R1B.2 自动得出）：

```
opening_balance + Σ(该账户所有 confirmed 交易，date ∈ [date_from, date_to]) == closing_balance
```

- 用**数据库里**的交易合计，不只是本次文件（能发现之前漏导的）
- pending 不算
- 相等 → `reconciled = true`；不等 → `false`，显示差额

---

## R10. 统计口径

所有统计基于 `transaction_split`，按**交易的 `date`** 归入时间段。

| 指标     | 计算                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| 收入     | Σ 拆分金额，分类 kind = `income`。包括 Tax (ATO) 的负数，所以交了税收入会变少；其中税前部分单独显示"其中税前 $X" |
| 支出     | −Σ 拆分金额，分类 kind = `expense`，**加上**系统分类"现金支出"、"银行费用"                                       |
| 不计入   | 系统分类"内部转账"（`transfer_status` 为 `auto` 或 `confirmed`）；"未分类"单独显示，不计入收支                   |
| 储蓄率   | (收入 − 支出) ÷ 收入；收入为 0 时显示"—"                                                                         |
| 分类支出 | 二级汇总到一级；退款（正数）直接冲减，所以某分类可能是负数，照实显示                                             |
| pending  | 计入统计，界面上可区分显示                                                                                       |

例子：本月 Groceries 有 −120.00 和 +0.72（退款）→ Groceries 支出 = 119.28。

"未分类"不计入收支是为了逼自己去处理它，看板上显示未分类的笔数和金额，点进去到 F8。

**已知局限**：税前收入在年底交税前会让储蓄率偏高。看板上同时显示 R14 的"预计年底补税"，自己心里有数。

### R10.1 时间段

| 选项   | 范围                                                        |
| ------ | ----------------------------------------------------------- |
| 本周   | 本周一到今天                                                |
| 上周   | 上周一到上周日                                              |
| 本月   | 本月 1 日到今天                                             |
| 上月   | 上月 1 日到上月最后一天                                     |
| 本季度 | 自然季度第一天到今天                                        |
| 今年   | 1 月 1 日到今天                                             |
| 本财年 | 7 月 1 日到今天（今天在 1 到 6 月时，从去年 7 月 1 日开始） |
| 自定义 | 用户选起止日期，含首尾                                      |

"今天"按 `Australia/Melbourne`。对比时用上一个同长度时间段（本月 1 到 21 日对比上月 1 到 21 日）。

### R10.2 汇总表

在选定时间段内，按时间粒度切分，再按一个维度分组求和。

| 参数 | 选项                             |
| ---- | -------------------------------- |
| 粒度 | 按周 / 按月                      |
| 分组 | 分类（一级，可展开二级）/ 归属人 |
| 指标 | 支出（默认）/ 收入               |

- 周从**周一**开始，到周日结束
- 时间段首尾不满一周或一个月的，只算时间段内的日子，表头标"部分"（如 `9/1–9/6 部分`）
- 每格金额按 R10 口径；行合计、列合计都显示
- 点任意格子跳到 F8，带上该时间段和分组条件

例子：`joint-2026-09.csv`，时间段 2026 年 9 月，按周，支出合计：

| 周                | 支出(分) |
| ----------------- | -------- |
| 9/1–9/6（部分）   | 5840     |
| 9/7–9/13          | 8580     |
| 9/14–9/20         | -705     |
| 9/21–9/27         | 21120    |
| 9/28–9/30（部分） | 10740    |
| 合计              | 45575    |

9/14 那周是负数：Medicare 报销 +45.80 大于当周支出 38.75，照实显示。

---

## R11. 预算

- 预算挂在一级分类上 → 统计该一级下所有二级的支出
- 进度 = 本月该分类支出 ÷ 月度上限
- ≥ `warn_at_percent` → 黄色提醒；≥ 100% → 红色
- 只按自然月计算

---

## R12. 导入流程（一次事务）

```
1. R1 解析整个文件            失败 → 报错，什么都不写
   CBA：R1B.1 余额检查（只记警告）、R1B.2 得出期初期末
2. 对每行：R2 提取脱敏 → R3 清洗 → R4 生成 key
3. 开启事务
4.   创建 import_batch
5.   对每行：
       已存在 key → 计数跳过
       R8 找 pending → 确认（R8.3，含 R6.1 例外）或插入新交易
       新交易：R6.1 转账 → R7 分类和 is_pre_tax → R5 归属人 → 写 transaction（CBA 带 balance_cents）+ 一行主拆分（is_primary = true）
6.   R6.2 配对（整个家庭）、R6.3 兜底建议
7.   R9 对账（有余额时）
8.   更新 import_batch 计数
9. 提交事务                   任意一步出错 → 全部回滚
10. 返回结果：新增、跳过、确认 pending、未分类数、待检查 pending、对账结果、余额警告
```

### R12.1 撤销导入

- 按 `import_batch` 撤销：删除该批次插入的交易（拆分级联删除）
- **每个账户只能撤销最近一次导入**。更早的批次如果和后面的批次日期重叠，重叠的行在后面那次被当成重复跳过了，撤销早的会让这段数据变空
- 被该批次确认的 pending → 恢复成 pending，清空 dedupe_key、import_batch_id、confirmed_at（日期、描述恢复不了，保留银行的；被 R8.3 例外改成转账的，分类也恢复不了）

**撤销前弹窗提醒**：批次里有手动改过的交易（`category_source` 或 `member_source` 是 `manual`、有多个拆分、有备注），或者有被确认的 pending 时，列出各有几笔，用户确认后才撤销。都没有就直接撤销。

**和别的交易的配对**：被删的交易、恢复成 pending 的交易，如果和别的交易配了对（`transfer_pair_id`），先处理对方再删：

| 对方的情况                                                         | 处理                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `transfer_status = none`（R6.2 配对时它是 manual 分类，没改）      | 只清空 `transfer_pair_id`                                                  |
| `suggested` 或 `confirmed`（R6.3 来的）                            | 清空配对，`transfer_status = none`，分类改回未分类，`category_source = system` |
| `auto`，用它自己的描述重跑 R6.1 还能认出                           | 保持内部转账，只清空配对，等重新导入时再配上                               |
| `auto`，重跑 R6.1 认不出（当初是 R6.2 改的，如 CBA 的 PayID 转账） | 同第二行，改回未分类                                                       |

- 改回未分类的，按 R5.1 重算归属人
- 重跑 R6.1 用的是数据库里**脱敏后**的描述，完整账号已经没了：`****1234` 当成 4 位尾号，按 CBA 的方式匹配（家庭账户的尾号以这 4 位结尾）
- 先清空配对再删交易，所以 `transfer_pair_id` 的外键不用改

---

## R13. 从手动改分类生成规则

用户在 F8 给某笔交易改分类后，可以"存成规则"：

- 关键词默认填 merchant **去掉末尾的门店号和地名**后的部分，用户可以改（如 `COLES 0559 MELBOURNE` → 建议 `COLES`）
- 简单做法：取 merchant 里第一个纯数字词之前的部分；没有数字词就取整个 merchant
- 保存后询问是否对"未分类"的已有交易应用（R7.2）

---

## R14. 税后估算

**只是估算，不是税务建议。** 没有算业务开支抵扣、各种 offset、Medicare levy 低收入减免，所以结果偏保守（偏高）。实际以 ATO 和会计为准。

B2B 收入不含 GST（没有注册），到账金额全额算税前收入。

代码放 `src/lib/tax/`，纯函数。

### R14.1 财年

- 7 月 1 日到次年 6 月 30 日，用开始年份表示：`2026` = 2026-27
- 交易按 `date` 归入财年

### R14.2 每人的税前收入

对每个 kind = person 的归属人，在一个财年内：

```
preTaxIncome = Σ 拆分金额（is_pre_tax = true，member = 这个人）
             + Σ 拆分金额（is_pre_tax = true，member kind = shared）÷ person 人数
```

- Home 名下的税前收入（如 joint account 的利息）在所有 person 之间平分，报税时一般就是这样分
- 平分除不尽的分，余数给排序靠前的人

### R14.3 计算

```
taxable   = payg_gross + preTaxIncome          （来自 tax_profile，没有记录时 payg 为 0）
incomeTax = 按当年税率表分档计算(taxable)
medicare  = taxable × 2%
total     = incomeTax + medicare
prepaid   = −Σ Tax (ATO) 分类里该人的负数拆分（只算负数，退税不算）
owing     = total − payg_withheld − prepaid    （负数表示预计退税）
```

- `taxable` 先向下取整到整元，再按分档算
- 结果四舍五入到分

### R14.4 税率表（resident，不含 Medicare levy）

写在 `src/lib/tax/rates.ts`，按财年存。新财年的税率要手动加，没有该财年的表时报错，不要沿用旧表。

| 应纳税收入          | 2025-26 | 2026-27 |
| ------------------- | ------- | ------- |
| $0 – $18,200        | 0%      | 0%      |
| $18,201 – $45,000   | 16%     | 15%     |
| $45,001 – $135,000  | 30%     | 30%     |
| $135,001 – $190,000 | 37%     | 37%     |
| $190,001 以上       | 45%     | 45%     |

2027-28 起第二档降到 14%，其他档开工时再确认后加入。

### R14.5 例子（2026-27）

| 场景          | payg_gross | 税前收入 | taxable | incomeTax | medicare | total  |
| ------------- | ---------- | -------- | ------- | --------- | -------- | ------ |
| A：工资 + B2B | 60,000     | 30,000   | 90,000  | 17,520    | 1,800    | 19,320 |
| B：B2B 跨档   | 40,000     | 10,000   | 50,000  | 5,520     | 1,000    | 6,520  |
| C：只有 B2B   | 0          | 30,000   | 30,000  | 1,770     | 600      | 2,370  |

场景 A 算 owing：假设 payg_withheld = 9,720（正好是 60,000 工资单独的税），已预缴 900 → owing = 19,320 − 9,720 − 900 = **8,700**。

场景 B 说明为什么不能用"税前收入 × 边际税率"：10,000 的 B2B 实际多出 2,450 的税（一半在 15% 档、一半在 30% 档，加 2% Medicare），用 32% 直接乘会得到 3,200。

场景 D：Home 名下有 100.00 利息，Male 和 Female 各算 50.00。

### R14.6 显示

- 看板上每个 person 一张卡片：本财年税前收入、预计总税额、已缴、**预计年底补税**
- 没有填 tax_profile 时提示去设置页填，仍然按 payg 为 0 计算

---

## R15. 简单拆分

### R15.1 结构

- 每笔交易至少一个拆分，恰好一个 `is_primary = true`（主拆分）
- 导入和手动录入时只建主拆分
- 所有拆分 `amount_cents` 合计永远等于交易的 `amount_cents`

### R15.2 拆出一部分

输入：交易、金额（用户填正数，按交易符号转换）、分类、可选归属人、可选备注

校验：

- 金额 > 0
- 金额 < 主拆分当前金额的绝对值（主拆分不能变成 0 或反号）

执行（一个事务）：

1. 主拆分 `amount_cents` 减去这部分
2. 新建拆分：同符号金额，`is_primary = false`，`category_source = manual`
3. 归属人：用户选了就用，`member_source = manual`；没选就对新拆分按 R5 计算（分类默认 > 卡号 > 账户）
4. `is_pre_tax` 按新分类的默认值

### R15.3 修改和删除

- 改非主拆分的金额：差额从主拆分补或扣，同样要满足 R15.2 的校验
- 删除非主拆分：金额全部加回主拆分
- 主拆分不能删除，可以改分类和归属人
- 交易只剩主拆分时，就是普通交易

### R15.4 和其他规则的关系

- 统计（R10、R10.2、R11、R14）本来就按拆分算，不用改
- 规则重新应用（R7.2）跳过有多个拆分的交易
- pending 确认（R8.3）保留所有拆分；如果银行金额和 pending 金额不同不会匹配，所以合计不变
- 撤销导入（R12.1）删除交易时拆分级联删除

### R15.5 例子

`joint-2026-09.csv` #19：COLES -58.40，主拆分 Groceries / Supermarket，Home。

| 操作                                                                  | 主拆分                 | 其他拆分                                                   |
| --------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| 拆出 15.00 → Home & utilities / Household supplies，不选归属人        | -43.40                 | -15.00 Household supplies，Home（category）                |
| 再拆出 8.00 → Personal & medical / Cosmetics & toiletries，不选归属人 | -35.40                 | 加一行 -8.00 Cosmetics & toiletries，**Male（card 1111）** |
| 拆出 50.00                                                            | 报错：超过主拆分 35.40 |                                                            |
| 删除 Cosmetics 那行                                                   | -43.40                 | 只剩 Household supplies                                    |
