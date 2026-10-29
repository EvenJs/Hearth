# 测试数据（fixtures）

> 全部是**假数据**：账号、卡号、人名、金额都是编的，格式照着 2026 年真实 ANZ 和 CBA 导出做。金额已确认不和真实流水重合。
> 真实导出**不要**放进这个目录，也不要提交到 git。

## 格式说明（和真实导出一致）

- **ANZ**：没有表头，3 列：日期、金额（带引号）、描述（不带引号）；文件末尾有空行
- **CBA**：没有表头，4 列：日期、金额、描述、余额，全部带引号，金额和余额带 `+`/`-`
- 行尾都是 **CRLF**（`\r\n`）
- `anz/joint-2026-09-lf.csv` 是同样内容的 LF 版本，解析器两种都要支持
- CBA 文件的余额是按期初 $10,000.00 逐行算出来的，余额链是连续的（`broken-balance.csv` 除外）

---

## 测试用的家庭配置

测试前先建好这些（seed 或测试 setup 里）：

| 归属人 | kind   |
| ------ | ------ |
| Male   | person |
| Female | person |
| Home   | shared |

| 账户             | bank     | type     | 默认归属人 | number_suffix |
| ---------------- | -------- | -------- | ---------- | ------------- |
| ANZ Joint        | anz      | joint    | Home       | `0001`        |
| ANZ Male         | anz      | everyday | Male       | `0002`        |
| CBA Female       | cba      | everyday | Female     | `0003`        |
| CBA Female Saver | cba      | savings  | Female     | `7777`        |
| ANZ Plus Male    | anz_plus | savings  | Male       | `0004`        |

`CBA Female Saver` 是假的账户，只用来测 CBA 4 位尾号的转账识别（R6.1）。真实家庭里没有这个账户。

| 卡（都在 ANZ Joint 上） | 归属人 |
| ----------------------- | ------ |
| `1111`                  | Male   |
| `2222`                  | Female |

分类、分类默认归属人、预置规则用 `docs/seed-categories.md` 的内容（Home & utilities、Insurance & financial、Groceries 默认 Home）。

---

## 文件清单

| 文件                            | 导入到     | 测什么                                                         |
| ------------------------------- | ---------- | -------------------------------------------------------------- |
| `anz/joint-2026-09.csv`         | ANZ Joint  | 主测试文件，覆盖大部分规则                                     |
| `anz/joint-2026-09-lf.csv`      | ANZ Joint  | 同上，LF 行尾                                                  |
| `anz/joint-2026-09-overlap.csv` | ANZ Joint  | 和上面日期重叠，测去重（R4）                                   |
| `anz/me-2026-09.csv`            | ANZ Male   | 测转账配对（R6.2）和兜底建议（R6.3）                           |
| `anz/invalid-date.csv`          | ANZ 任意   | 第 1 行 31/02，整个文件应失败（R1）                            |
| `anz/invalid-zero-amount.csv`   | ANZ 任意   | 金额 0，应失败（R1）                                           |
| `cba/female-2026-09.csv`        | CBA Female | CBA 解析和清洗、余额、税前收入、Tax (ATO)、和 joint 的转账配对 |
| `cba/broken-balance.csv`        | CBA Female | 余额不连续时只警告不失败（R1B.1）                              |
| `anz-statement/*.txt`           | ANZ Joint  | ANZ PDF 对账单（R1C、R12.2），读文字以后的样子，见"ANZ 对账单用例" |
| `receipts/*.json`               | —          | 小票识别（R20），见最后一节"小票用例"                       |

---

## 期望结果：`joint-2026-09.csv`

在空数据库上导入，没有 pending 交易时。归属人一列括号里是 `member_source`。

| #   | 日期       | 金额(分) | merchant                                                             | 卡   | 分类                                    | 归属人              | transfer_status | 测的规则                             |
| --- | ---------- | -------- | -------------------------------------------------------------------- | ---- | --------------------------------------- | ------------------- | --------------- | ------------------------------------ |
| 1   | 2026-09-30 | 500      | REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED |      | Bank fees                               | Home (account)      | none            | R7 系统规则                          |
| 2   | 2026-09-30 | -500     | ACCOUNT SERVICING FEE                                                |      | Bank fees                               | Home (account)      | none            | R7                                   |
| 3   | 2026-09-29 | -9840    | BPAY SEENE                                                           |      | Home & utilities / Electricity          | Home (category)     | none            | R3 去 `{123456}`                     |
| 4   | 2026-09-28 | -450     | GONG CHA & HO/SPENCER ST MELBOURNE                                   | 1111 | Entertainment & eat-out / Bubble tea    | Male (card)         | none            | R4 occurrence=1                      |
| 5   | 2026-09-28 | -450     | 同上                                                                 | 1111 | 同上                                    | Male (card)         | none            | R4 occurrence=2，**不能被当成重复**  |
| 6   | 2026-09-25 | -15000   | ATM CBA HAWTHORN                                                     |      | Cash withdrawal                         | Home (account)      | none            | R3 `NON-ANZ ATM`→`ATM`，R7           |
| 7   | 2026-09-22 | 8000     | PAYID DEPOSIT REF DINNER SPLIT                                       |      | Uncategorised                           | Home (account)      | none            | 导入 me 文件后变 suggested           |
| 8   | 2026-09-22 | -6120    | POCHANA MELBOURNE MELBOURNE                                          |      | Entertainment & eat-out / Restaurants   | Home (account)      | none            | R3 `ZLR*`、反斜杠、` AU`             |
| 9   | 2026-09-20 | -3875    | CROWN ASIAN SPENCER DOCKLANDS                                        | 2222 | Groceries / Supermarket                 | **Home (category)** | none            | R5 分类默认优先于卡号                |
| 10  | 2026-09-18 | 4580     | MEDICARE BENEFIT                                                     |      | Personal & medical / Other              | Home (account)      | none            | R7.1 正数冲减                        |
| 11  | 2026-09-15 | -50000   | TRANSFER TO \*\*\*\*0003                                             |      | Internal transfer                       | Home (account)      | auto            | R2.3 脱敏、R6.1（对方是 CBA Female） |
| 12  | 2026-09-12 | -2500    | CHARGEFOX PTY LTD NORTH MELBOUR                                      |      | Transport & auto / Petrol / EV charging | Home (account)      | none            | R3 `794PIN*`                         |
| 13  | 2026-09-10 | 150      | MELB ASIAN MARKET                                                    |      | Groceries / Supermarket                 | Home (category)     | none            | R7.1 退款                            |
| 14  | 2026-09-10 | -6230    | MELB ASIAN MARKET                                                    |      | Groceries / Supermarket                 | Home (category)     | none            |                                      |
| 15  | 2026-09-08 | -1200    | UNKNOWN SHOP PTY LTD MELBOURNE                                       | 3333 | Uncategorised                           | Home (account)      | none            | R5 未登记的卡 → 账户默认             |
| 16  | 2026-09-05 | -2715    | EASI AU \*\*\*\*2605                                                 | 2222 | Uncategorised                           | Female (card)       | none            | R2.3 9 位数字也脱敏                  |
| 17  | 2026-09-03 | 200000   | TRANSFER FROM \*\*\*\*0002                                           |      | Internal transfer                       | Home (account)      | auto            | R6.1                                 |
| 18  | 2026-09-02 | 30000    | TRANSFER FROM \*\*\*\*9999                                           |      | Uncategorised                           | Home (account)      | none            | R6.1 外部账号，不算转账              |
| 19  | 2026-09-01 | -5840    | COLES 0559 MELBOURNE                                                 | 1111 | Groceries / Supermarket                 | **Home (category)** | none            | R5 分类默认优先于卡号                |

导入结果计数：`row_count = 19`、`inserted_count = 19`、`duplicate_count = 0`。

**入库检查**：任何表、任何字段里都不能出现 `400000002`、`012345400000003`、`499999999`、`280672605`。

### R5.1 重算

把 #16 手动改成 Groceries / Supermarket → 归属人自动变成 Home（category）。
再把 #16 的归属人手动改成 Female（manual），然后把分类改成 Uncategorised → 归属人**保持** Female。

### 2026 年 9 月统计（只导入这一个文件时，R10）

| 指标                       | 期望                             |
| -------------------------- | -------------------------------- |
| 支出                       | 45575 分（$455.75）              |
| 收入                       | 0                                |
| 储蓄率                     | "—"（收入为 0）                  |
| 未分类                     | 4 笔（#7、#15、#16、#18）        |
| Groceries / Supermarket    | 3875 + 6230 − 150 + 5840 = 15795 |
| Personal & medical / Other | -4580（负数，照实显示）          |
| Bank fees                  | 0（扣费和退回抵消）              |
| 支出按归属人               | Male 900，Female 0，Home 44675   |

### 按周汇总（R10.2，时间段 2026 年 9 月，指标支出）

| 周                | 支出(分) |
| ----------------- | -------- |
| 9/1–9/6（部分）   | 5840     |
| 9/7–9/13          | 8580     |
| 9/14–9/20         | -705     |
| 9/21–9/27         | 21120    |
| 9/28–9/30（部分） | 10740    |
| 合计              | 45575    |

### 看板（R10.3 到 R10.6，只导入这一个文件，时间段 2026 年 9 月）

**Top 商家**（R10.3，按笔数）

| 排名 | merchant                           | 笔数 | 金额(分) |
| ---- | ---------------------------------- | ---- | -------- |
| 1    | GONG CHA & HO/SPENCER ST MELBOURNE | 2    | 900      |
| 2    | ATM CBA HAWTHORN                   | 1    | 15000    |
| 3    | BPAY SEENE                         | 1    | 9840     |
| 4    | POCHANA MELBOURNE MELBOURNE        | 1    | 6120     |
| 5    | MELB ASIAN MARKET                  | 1    | 6080     |

- 第 6 名起：COLES 0559 MELBOURNE（1 笔，5840）、CROWN ASIAN SPENCER DOCKLANDS（1，3875）、CHARGEFOX PTY LTD NORTH MELBOUR（1，2500）、ACCOUNT SERVICING FEE（1，500）
- 不出现：只有退款的 #1 REVERSAL…、#10 MEDICARE BENEFIT（0 笔）；未分类的 #7、#15、#16、#18；转账 #11、#17
- MELB ASIAN MARKET：#14 -6230 算 1 笔，#13 +150 退款只冲减金额

**归属人筛选**（R10.6）：选 Male → 支出 900；Top 商家只有 GONG CHA（2 笔，900）；按周汇总只有 9/28–9/30 部分一列有 900。

**对比上期**（R10.4）：上期没有数据，收入、支出、储蓄率都显示"—"。

**近 12 个月**（R10.5，今天 2026-10-24）：2025-11 到 2026-10 共 12 个月；只有 2026-09 有数据，收入 0、支出 45575、净额 -45575，其他 11 个月都是 0。

### 拆分（R15，在上面导入完成后操作）

对 #19 依次拆出：15.00 → Home & utilities / Household supplies；8.00 → Personal & medical / Cosmetics & toiletries（都不选归属人）。

| 拆分 | 金额(分) | 分类                                        | 归属人          |
| ---- | -------- | ------------------------------------------- | --------------- |
| 主   | -3540    | Groceries / Supermarket                     | Home (category) |
| 2    | -1500    | Home & utilities / Household supplies       | Home (category) |
| 3    | -800     | Personal & medical / Cosmetics & toiletries | Male (card)     |

拆分后 9 月统计：

| 指标                                  | 期望                            |
| ------------------------------------- | ------------------------------- |
| 支出                                  | 45575（不变）                   |
| Groceries / Supermarket               | 13495                           |
| Home & utilities / Household supplies | 1500                            |
| 支出按归属人                          | Male 1700，Female 0，Home 43875 |

删除拆分 3 后，主拆分回到 -4340。

---

## 期望结果：再导入 `joint-2026-09-overlap.csv`

| 行                                    | 结果                                            |
| ------------------------------------- | ----------------------------------------------- |
| 08/10 WOOLWORTHS（卡 2222）           | 新增，Groceries / Supermarket，Home（category） |
| 03/10 FROM \*\*\*\*0002               | 新增，Internal transfer，auto                   |
| 30/09 两行费用、29/09 BPAY、25/09 ATM | 跳过（重复）                                    |
| 28/09 GONG CHA 第 1、2 笔             | 跳过（重复）                                    |
| 28/09 GONG CHA 第 3 笔                | **新增**（occurrence=3），Male（card）          |

计数：`row_count = 9`、`inserted_count = 3`、`duplicate_count = 6`。

---

## 期望结果：再导入 `me-2026-09.csv`（到 ANZ Male）

| 行                                 | 结果                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 21/09 PAYID PAYMENT -80.00         | Uncategorised，Male；和 Joint #7（22/09 +80.00）互为兜底建议，两边 `transfer_status = suggested`，配对 |
| 14/09 MYKI                         | Transport & auto / Public transport，Male（account）                                                   |
| 03/09 TO \*\*\*\*0001 -2000.00     | Internal transfer，auto；和 Joint #17 配对（`transfer_pair_id` 互相指向）                              |
| 01/09 PAY/SALARY FROM ACME PTY LTD | Income / Salary（规则 SALARY），Male，不是税前                                                         |

suggested 确认前，#7 和 PAYID PAYMENT 仍按 Uncategorised 统计。

### R6.3 确认和拒绝（在 me 导入完成后，两个用例分开测）

| 操作 | Joint #7 | PAYID PAYMENT |
| --- | --- | --- |
| 确认 | `confirmed`，Internal transfer，`category_source = manual`，Home（account），配对保留 | 同左，Male（account） |
| 拒绝 | `none`，Uncategorised，`transfer_pair_id` 清空 | 同左 |

- 确认后两笔都不计收支，也不再算未分类
- 拒绝后再导入 `cba/female-2026-09.csv`：两笔仍是 `none`，不会再被建议（R6.3 只从本次新插入的交易出发）

---

## 期望结果：导入 `cba/female-2026-09.csv`（到 CBA Female）

按 joint → overlap → me → 这个文件的顺序导入。账户默认 Female，CBA 账户上没有登记卡。

| #   | 日期  | 金额(分) | merchant                                              | 卡   | 分类                                              | 归属人           | 备注                                                             |
| --- | ----- | -------- | ----------------------------------------------------- | ---- | ------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| 1   | 09-30 | 1234     | CREDIT INTEREST                                       |      | Income / Interest                                 | Female (account) | is_pre_tax = true                                                |
| 2   | 09-28 | -90000   | BPAY TAX OFFICE PAYMENTS                              |      | Income / Tax (ATO)                                | Female (account) | 描述脱敏成 `****1234`                                            |
| 3   | 09-25 | 300000   | FAST TRANSFER FROM ACME TRADING PTY LTD INVOICE 0925  |      | Uncategorised                                     | Female (account) | B2B，导入后手动分类                                              |
| 4   | 09-24 | 100000   | TRANSFER FROM XX7777 HOME                             |      | Internal transfer                                 | Female (account) | R6.1 CBA 尾号 → CBA Female Saver，auto，无法配对（Saver 没导入） |
| 5   | 09-22 | -45560   | BPAY DEFT PAYMENTS                                    |      | Home & utilities / Body corporate fees            | Home (category)  | 20 位参考号脱敏                                                  |
| 6   | 09-20 | 400      | CBA YELLO HLPCKG CSHBK                                |      | Income / Other                                    | Female (account) |                                                                  |
| 7   | 09-19 | 3860     | DIRECT CREDIT 002221 MCARE BENEFITS \*\*\*\*6789 ABCD |      | Personal & medical / Other                        | Female (account) | 正数冲减                                                         |
| 8   | 09-16 | -6490    | CROWN ASIAN SPENCER DOCKLANDS                         | 5555 | Groceries / Supermarket                           | Home (category)  | R3 去掉 Card、Value Date                                         |
| 9   | 09-16 | -29840   | DIRECT DEBIT 000793 BUPA AUSTRALIA \*\*\*\*4000       |      | Insurance & financial / Personal & life insurance | Home (category)  |                                                                  |
| 10  | 09-16 | 50000    | FAST TRANSFER FROM TEST HOLDER JOINT                  |      | **Internal transfer**                             | Female (account) | R6.2：和 joint #11 配对，从 Uncategorised 改成 auto              |
| 11  | 09-15 | -2280    | KIS HAIR MELBOURNE                                    | 4444 | Personal & medical / Hair & beauty                | Female (account) | 未登记的卡                                                       |
| 12  | 09-12 | -300     | TOWER SUSHI & GOURM MELBOURNE                         |      | Uncategorised                                     | Female (account) | occurrence = 1                                                   |
| 13  | 09-12 | -300     | 同上                                                  |      | Uncategorised                                     | Female (account) | occurrence = 2，余额不同，**不能被当成重复**                     |
| 14  | 09-10 | -7500    | LIGHTNING BROADBAND                                   |      | Home & utilities / Internet                       | Home (category)  |                                                                  |
| 15  | 09-08 | 2250     | FAST TRANSFER FROM OTHER FRIEND DINNER                |      | Uncategorised                                     | Female (account) | 朋友 AA 转回来                                                   |
| 16  | 09-08 | -4500    | TRANSFER TO TEST FRIEND EAT EAT                       |      | Entertainment & eat-out / Restaurants             | Female (account) | 规则 EAT EAT                                                     |
| 17  | 09-05 | -680     | OVERLAY COFFEE MELBOURNE                              | 5555 | Entertainment & eat-out / Coffee & tea            | Female (account) |                                                                  |
| 18  | 09-03 | -7135    | BPAY SEENE                                            |      | Home & utilities / Electricity                    | Home (category)  | 和 ANZ 的 BPAY SEENE 归一致                                      |
| 19  | 09-02 | -148000  | LOAN REPAYMENT LN REPAY \*\*\*\*6789                  |      | Home & utilities / Mortgage                       | Home (category)  |                                                                  |
| 20  | 09-01 | 41000    | SALARY EXAMPLE SCHOOL WAGES \*\*\*\*2026              |      | Income / Salary                                   | Female (account) | 不是税前                                                         |

导入结果：`row_count = 20`、`inserted_count = 20`、没有余额警告。
自动对账（R1B.2、R9）：期初 10,000.00，期末 11,561.59，`reconciled = true`。

**入库检查**：不能出现 `5512345678901234`、`12345678901234567890`、`111122223333444000`、`123456789`、`01092026`。

### 然后手动操作

1. #3 改成 Income / Contract income (B2B) → `is_pre_tax` 自动变 true
2. #15 改成 Entertainment & eat-out / Restaurants（朋友 AA 转回来，冲减支出）

### 9 月统计（只算这个文件，做完上面两步后）

| 指标         | 期望                                                          |
| ------------ | ------------------------------------------------------------- |
| 收入         | 1234 − 90000 + 300000 + 400 + 41000 = 252634，其中税前 301234 |
| 支出         | 248125 − 2250 = 245875                                        |
| Restaurants  | 4500 − 2250 = 2250                                            |
| 支出按归属人 | Home 244525，Female 1350                                      |
| 未分类       | 2 笔（#12、#13）                                              |
| 内部转账     | #4、#10，不计收支                                             |

### 税后估算（R14，财年 2026）

Female 的 tax_profile：`payg_gross = 60,000.00`，`payg_withheld = 9,720.00`（R14.5 场景 A）。

| 时点                       | 税前收入 | taxable | incomeTax | medicare | total     | prepaid | owing                   |
| -------------------------- | -------- | ------- | --------- | -------- | --------- | ------- | ----------------------- |
| 刚导入（#3 还没分类）      | 12.34    | 60,012  | 8,523.60  | 1,200.24 | 9,723.84  | 900.00  | **-896.16**（预计退税） |
| #3 改成 Contract income 后 | 3,012.34 | 63,012  | 9,423.60  | 1,260.24 | 10,683.84 | 900.00  | **63.84**               |

Male 没有 tax_profile 也没有税前收入 → 全部为 0，卡片提示去设置页填写（不做下面 P7 时）。

---

## 期望结果：导入 `cba/broken-balance.csv`（空数据库）

- 3 行全部插入，导入**不失败**
- 警告：第 1 行和第 2 行之间、第 2 行和第 3 行之间余额不连续
- 自动对账仍然通过（期初 9,449.25，期末 11,561.59，中间一行的余额错不影响首尾）。说明余额检查（R1B.1）和对账（R9）各管一件事

---

## pending 匹配用例（R8）

在导入 `joint-2026-09.csv` **之前**，先在 ANZ Joint 手动录入这些 pending：

| pending | 金额   | 日期       | 期望                                                                                           |
| ------- | ------ | ---------- | ---------------------------------------------------------------------------------------------- |
| P1      | -61.20 | 2026-09-20 | 匹配 #8（相差 2 天）→ 确认，不新增；日期变 09-22，保留 P1 的分类和归属人                       |
| P2      | -38.75 | 2026-09-20 | 匹配 #9（相差 0 天）→ 确认                                                                     |
| P3      | -25.00 | 2026-09-11 | 和 P4 一起，#12 有 2 个候选 → #12 正常新增，提示可能重复                                       |
| P4      | -25.00 | 2026-09-12 | 同上                                                                                           |
| P5      | -10.00 | 2026-09-05 | 没有匹配 → 保持 pending，导入结果里提示检查                                                    |
| P6      | -58.40 | 2026-09-02 | #19 日期 09-01 **早于** pending → 不匹配（R8.2 银行日期不早于消费日期）；#19 新增；P6 提示检查 |

计数：`inserted_count = 17`、`matched_pending_count = 2`。

### 没有 CSV 的账户（R8.1）

| 用例 | 操作                                                               | 期望                                                           |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| P7   | 在 ANZ Plus Male 手动录入 2026-09-30 +8.50，分类 Income / Interest | 直接 confirmed（anz_plus 没有解析器），is_pre_tax = true，Male |
| P8   | 在 CBA Female 手动录入 -15.00                                      | pending（cba 有解析器）                                        |
| P9   | 尝试给 ANZ Plus Male 导入 CSV                                      | 拒绝：这个账户不能导入                                         |

### pending 被转账行确认（R8.3 例外，单独测，空数据库）

| 用例 | 操作 | 期望 |
| --- | --- | --- |
| P10 | 在 ANZ Joint 手动录入 2026-09-14 -500.00，分类 Entertainment & eat-out / Restaurants，归属人 Female，备注"给老婆"；然后导入 `joint-2026-09.csv` | 匹配 #11（相差 1 天）→ confirmed，日期变 09-15；R6.1 认出转给 CBA Female → `transfer_status = auto`，分类改成 Internal transfer，`category_source = system`；归属人保持 Female（manual），备注保留 |

计数：`inserted_count = 18`、`matched_pending_count = 1`。之后导入 `cba/female-2026-09.csv`，P10 和 CBA #10 照常配对。

---

## 撤销导入用例（R12.1）

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| U1 | 导入 joint → overlap | 撤销 joint 主文件那次 | 拒绝：ANZ Joint 最近一次导入是 overlap |
|    |  | 撤销 overlap | 删除 3 笔（10/08 WOOLWORTHS、10/03 FROM \*\*\*\*0002、GONG CHA 第 3 笔）；joint 的 19 笔不变 |
| U2 | 导入 joint → overlap → me | 撤销 me | 不弹窗（没有手动改过的）。删除 me 的 4 笔。Joint #7：`suggested` → `none`，Uncategorised，`category_source = system`，Home（account），配对清空。Joint #17：重跑 R6.1，`****0002` 对上 ANZ Male → 保持 auto 和 Internal transfer，只清空配对 |
|    |  | 再导入 me | 和第一次一样：#7 和 PAYID PAYMENT 重新被建议，#17 重新配对 |
| U3 | 按 joint → overlap → me → cba 导入，做完 CBA 的两步手动操作 | 撤销 cba | 弹窗：手动改过 2 笔（#3、#15）。确认后删除 CBA 的 20 笔。Joint #11：`****0003` 对上 CBA Female → 保持 auto，只清空配对 |
| U4 | 空数据库，只导入 joint → cba | 撤销 joint | CBA #10：重跑 R6.1 认不出（PayID，没有账号）→ `none`，Uncategorised，`category_source = system`，Female（account），配对清空 |
|    |  | 再导入 joint | #11 和 CBA #10 重新配对，CBA #10 变回 auto + Internal transfer |
| U5 | 导入 joint → overlap → me，确认 #7 和 PAYID PAYMENT 的建议 | 撤销 me | 弹窗：手动改过 1 笔（PAYID PAYMENT，确认后是 manual）。Joint #7：`confirmed` → `none`，Uncategorised，`category_source = system`，配对清空 |
| U6 | 做完 P1 到 P6 那组导入 | 撤销 joint | 弹窗：确认的 pending 2 笔。P1、P2 恢复成 pending，日期保留银行的（09-22、09-20），`dedupe_key`、`import_batch_id`、`confirmed_at` 清空；17 笔新增的删除 |

每个用例做完，检查没有任何交易的 `transfer_pair_id` 指向已经删除的交易。

---

## ANZ 对账单用例（R1C、R12.2，M6.6）

`anz-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1C 第一层的输出），不是 PDF，也不是真对账单。格式照真实对账单的结构：表头、汇总、交易行最后三段是"支出 / 存入 / 余额"（空的写 `blank`）、多行描述、`EFFECTIVE DATE` 行、每页的 `TOTALS AT END OF PAGE`、页眉。分页用单独一行 `<<<PAGE>>>`。

2026-10-29 照 `unpdf` 读真实对账单的样子改过（R1C）：汇总页左右两栏拼在一起，标签带冒号、`$` 和金额在后面几行；`Account Number` 的号码在下面两行；`OPENING BALANCE` 那行只有余额，`blank  blank` 在上面年份那行；合计行前面多一个 `blank`，`TOTALS AT END OF PERIOD` 最后还有期末余额。账号用测试家庭的假尾号，金额、期初是编的。

账期照真实对账单的样子，同一天首尾相接：`31 AUGUST 2026 TO 30 SEPTEMBER 2026` 包含的是 9/1 到 9/30（R1C：`(periodFrom, periodTo]`）。

| 文件 | 内容 |
| --- | --- |
| `joint-2026-09.txt` | `31 AUGUST 2026 TO 30 SEPTEMBER 2026`，账号以 `0001` 结尾，期初 5,000.00，和 `anz/joint-2026-09.csv` 同样的 19 笔，分两页 |
| `joint-2026-10.txt` | `30 SEPTEMBER 2026 TO 31 OCTOBER 2026`，期初 = 上一份的期末，**一笔交易都没有** |
| `joint-2026-11-gap.txt` | `31 OCTOBER 2026 TO 30 NOVEMBER 2026`，期初比上一份的期末多 100.00，2 笔交易 |
| `broken-balance.txt` | 和 `joint-2026-09.txt` 一样，第 2 页第 3 笔的余额改错 |
| `wrong-account.txt` | 和 `joint-2026-09.txt` 一样，账号以 `0002` 结尾 |
| `year-rollover.txt` | `15 DECEMBER 2026 TO 15 JANUARY 2027`，DEC 和 JAN 各有交易。JAN 前面有 `2027  blank` 那行，JAN 第一笔（存入）只剩金额、余额两段（R1C 换年的例外） |
| `first-day.txt` | 和 `joint-2026-09.txt` 一样，多一笔 `31 AUG` 的交易 |

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| S1 | 空数据库 | 导入 `joint-2026-09.txt` 到 ANZ Joint | 19 笔，结果和只导入 `joint-2026-09.csv` 一样（上面 19 行的表）。`source = pdf`，`date_from = 2026-09-01`，`date_to = 2026-09-30`，期初期末从汇总页来，`reconciled = true`。卡号消费的 `EFFECTIVE DATE` 没有进描述 |
| S2 | 导入 `joint-2026-09.csv` | 再导入 `joint-2026-09.txt` | 新增 0，跳过 19，`reconciled = true` |
| S3 | 导入去掉 #12 的 joint CSV（测试里现拼） | 导入 `joint-2026-09.txt` | 新增 1（#12），跳过 18，`reconciled = true` |
| S4 | S1 | 导入 `joint-2026-10.txt` | 新增 0，建了批次，`reconciled = true`；R12.2 提示"和上一份对账单接上了" |
| S5 | S4 | 导入 `joint-2026-11-gap.txt` | 2 笔照常导入；R12.2 警告和上一份差 $100.00 |
| S6 | 空数据库 | 导入 `broken-balance.txt` | 整份失败，错误写第 2 页第 3 笔，什么都没写 |
| S7 | 空数据库 | 把 `wrong-account.txt` 导入到 ANZ Joint | 整份失败"这份对账单不是这个账户的"；错误信息里没有完整账号 |
| S8 | 纯函数 | 解析 `year-rollover.txt` | DEC 的是 2026 年，JAN 的是 2027 年 |
| S8b | 纯函数 | 解析 `first-day.txt` | 失败，信息写"账期第一天有交易，R1C 对账期的假设不对" |
| S9 | 导入 `joint-2026-09.csv` | 导入页选 ANZ Joint | 显示"上次导入到 2026-09-30"（CSV 最晚一笔），建议导出 2026-09-23 到今天 |
| S10 | S9 | 再导入一份最早是 2026-10-05 的 CSV（测试里现拼） | 结果页警告和上次之间可能漏了 |
| S11 | 空数据库 | 不选账户，导入 `joint-2026-09.txt` | 认出 ANZ Joint（尾号 `0001`），结果和 S1 一样 |
| S12 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 认出 ANZ Male（尾号 `0002`），导入到 ANZ Male，ANZ Joint 没有交易 |
| S13 | 把 ANZ Joint 的尾号改成 `9999` | 不选账户，导入 `joint-2026-09.txt` | 整份失败"找不到尾号是 0001 的 ANZ 账户"；CBA 账户就算尾号对得上也不算；什么都没写 |
| S14 | 把 ANZ Male 的尾号改成 `50001` | 不选账户，导入 `joint-2026-09.txt` | 整份失败"有 2 个 ANZ 账户的尾号都对得上"；什么都没写 |

另外：解析结果里没有完整账号；测试检查 `import_batch`、`transaction` 里没有 8 位以上连续数字（R2.3 照旧）。

---

## 小票用例（R20，M6.7）

`receipts/` 里的 `.json` 是**假的** reader 原始结果（R20.1 的格式，金额、日期都是原样字符串），测试里用假 reader 直接返回它们；不是真小票，也没有图片。照着真小票的几种格式编的：称重行（已经去掉）、单件折扣、整单折扣。真实小票只在 `tests/local/` 里试，不提交。

| 文件 | 内容 | 用在 |
| --- | --- | --- |
| `coles-a.json` | COLES，`31/08/2026`，card `1111`，总额 `$58.40`，9 件，含单件折扣 `-$0.80` | R-A、R-C |
| `grocer-b.json` | SUNNY GROCER，`25/09/2026`，card `null`，3 件 + 整单折扣 `-$1.00`，总额 `$32.33` | R-B |
| `bad-total.json` | 商品合计 `30.00`，总额 `31.00` | R-D |
| `coles-e.json` | COLES，`28/09/2026`，card `2222`，总额 `$23.45`，商品分类都是 `null` | R-E |
| `coles-a.txt`、`grocer-b.txt` | 假的"手机识别文字"，内容和对应的 `.json` 一样（M6.7-5b，`text` reader 做了才加） | R20.1b |
| `noisy.json` | 多返回了 `customer: "TEST CUSTOMER"`、`cashier`、商品名里有 `12345678` | R20.1、R20.2：多的字段被 Zod 丢掉；8 位数字脱敏成 `****5678` |

期望值见 `business-rules.md` R20.8，汇总：

| 用例 | 前置 | 期望 |
| --- | --- | --- |
| R-A | 导入 `joint-2026-09.csv` | 候选只有 #19，默认选中。#19 拆成：主 -31.40 Groceries / Supermarket，Home（category），`category_source` 还是 `rule`；-15.00 Household supplies，Home（category），manual；-12.00 Cosmetics & toiletries，Male（card 1111），manual |
| R-A' | R-A 做完，再导入 `coles-a.json` 一次 | 提示"可能已经上传过"；候选 0 笔（#19 已经挂了小票） |
| R-B | 纯函数，交易 -32.33，主分类 Groceries / Supermarket | 主 -19.39、Household supplies -9.70、Cosmetics & toiletries -3.24 |
| R-C | 纯函数，`coles-a.json` 挂到 -59.28 | 多一组 -0.88 未分类（`system`）；挂到 -50.00 报错"小票合计比这笔交易多 $8.40" |
| R-D | 纯函数 | `checkReceipt` 失败，差 $1.00 |
| R-E | 空数据库 | 新建 ANZ Joint pending，`source = receipt`，2026-09-28，-23.45，Groceries / Supermarket（rule），Home（category），`card_last4` 空；再导入一行 `2026-09-29 -23.45 ... CARD 2222 COLES 0559 MELBOURNE` → 这笔 pending 被确认，`source` 还是 `receipt`，小票还挂着 |
| R-U | R-A 做完 | 撤销 joint 导入：弹窗写"挂了小票 1 笔"；确认后小票 `transaction_id` 变空；再导入 joint，小票能重新挂到新的 #19 |

所有用例做完，检查 `receipt.parsed_json` 里没有 `1111`、`2222` 这些卡号，没有人名字段。
