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
