# 测试数据（fixtures）

> 全部是**假数据**：账号、卡号、金额都是编的，格式照着 2026 年 9 月真实 ANZ 导出做。
> 真实导出**不要**放进这个目录，也不要提交到 git。

## 格式说明（和真实导出一致）

- 没有表头，3 列：日期、金额（带引号）、描述（不带引号）
- 行尾是 **CRLF**（`\r\n`），文件末尾有空行
- `joint-2026-09-lf.csv` 是同样内容的 LF 版本，解析器两种都要支持

---

## 测试用的家庭配置

测试前先建好这些（seed 或测试 setup 里）：

| 归属人 | kind |
|---|---|
| Male | person |
| Female | person |
| Home | shared |

| 账户 | bank | type | 默认归属人 | number_suffix |
|---|---|---|---|---|
| ANZ Joint | anz | joint | Home | `0001` |
| ANZ Male | anz | everyday | Male | `0002` |
| ANZ Female | anz | everyday | Female | `0003` |

| 卡（都在 ANZ Joint 上） | 归属人 |
|---|---|
| `1111` | Male |
| `2222` | Female |

分类、分类默认归属人、预置规则用 `docs/seed-categories.md` 的内容（Home & utilities、Insurance & financial、Groceries 默认 Home）。

---

## 文件清单

| 文件 | 导入到 | 测什么 |
|---|---|---|
| `anz/joint-2026-09.csv` | ANZ Joint | 主测试文件，覆盖大部分规则 |
| `anz/joint-2026-09-lf.csv` | ANZ Joint | 同上，LF 行尾 |
| `anz/joint-2026-09-overlap.csv` | ANZ Joint | 和上面日期重叠，测去重（R4） |
| `anz/me-2026-09.csv` | ANZ Male | 测转账配对（R6.2）和兜底建议（R6.3） |
| `anz/wife-2026-09.csv` | ANZ Female | 测税前收入、Tax (ATO)、税后估算（R14） |
| `anz/invalid-date.csv` | 任意 | 第 1 行 31/02，整个文件应失败（R1） |
| `anz/invalid-zero-amount.csv` | 任意 | 金额 0，应失败（R1） |

---

## 期望结果：`joint-2026-09.csv`

在空数据库上导入，没有 pending 交易时。归属人一列括号里是 `member_source`。

| # | 日期 | 金额(分) | merchant | 卡 | 分类 | 归属人 | transfer_status | 测的规则 |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-30 | 500 | REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED | | Bank fees | Home (account) | none | R7 系统规则 |
| 2 | 2026-09-30 | -500 | ACCOUNT SERVICING FEE | | Bank fees | Home (account) | none | R7 |
| 3 | 2026-09-29 | -9840 | BPAY SEENE | | Home & utilities / Electricity | Home (category) | none | R3 去 `{123456}` |
| 4 | 2026-09-28 | -450 | GONG CHA & HO/SPENCER ST MELBOURNE | 1111 | Entertainment & eat-out / Coffee & tea | Male (card) | none | R4 occurrence=1 |
| 5 | 2026-09-28 | -450 | 同上 | 1111 | 同上 | Male (card) | none | R4 occurrence=2，**不能被当成重复** |
| 6 | 2026-09-25 | -15000 | ATM CBA HAWTHORN VIC | | Cash withdrawal | Home (account) | none | R3 `NON-ANZ ATM`→`ATM`，R7 |
| 7 | 2026-09-22 | 8000 | PAYID DEPOSIT REF DINNER SPLIT | | Uncategorised | Home (account) | none | 导入 me 文件后变 suggested |
| 8 | 2026-09-22 | -6120 | POCHANA MELBOURNE MELBOURNE | | Entertainment & eat-out / Restaurants | Home (account) | none | R3 `ZLR*`、反斜杠、` AU` |
| 9 | 2026-09-20 | -3875 | CROWN ASIAN SPENCER DOCKLANDS | 2222 | Groceries / Supermarket | **Home (category)** | none | R5 分类默认优先于卡号 |
| 10 | 2026-09-18 | 4390 | MEDICARE BENEFIT | | Personal & medical / Other | Home (account) | none | R7.1 正数冲减 |
| 11 | 2026-09-15 | -50000 | TRANSFER TO ****0003 | | Internal transfer | Home (account) | auto | R2.3 脱敏、R6.1 |
| 12 | 2026-09-12 | -2500 | CHARGEFOX PTY LTD NORTH MELBOUR | | Transport & auto / Petrol / EV charging | Home (account) | none | R3 `794PIN*` |
| 13 | 2026-09-10 | 150 | MELB ASIAN MARKET | | Groceries / Supermarket | Home (category) | none | R7.1 退款 |
| 14 | 2026-09-10 | -6230 | MELB ASIAN MARKET | | Groceries / Supermarket | Home (category) | none | |
| 15 | 2026-09-08 | -1200 | UNKNOWN SHOP PTY LTD MELBOURNE | 3333 | Uncategorised | Home (account) | none | R5 未登记的卡 → 账户默认 |
| 16 | 2026-09-05 | -3337 | EASI AU ****2605 | 2222 | Uncategorised | Female (card) | none | R2.3 9 位数字也脱敏 |
| 17 | 2026-09-03 | 200000 | TRANSFER FROM ****0002 | | Internal transfer | Home (account) | auto | R6.1 |
| 18 | 2026-09-02 | 30000 | TRANSFER FROM ****9999 | | Uncategorised | Home (account) | none | R6.1 外部账号，不算转账 |
| 19 | 2026-09-01 | -6748 | COLES 0559 MELBOURNE | 1111 | Groceries / Supermarket | **Home (category)** | none | R5 分类默认优先于卡号 |

导入结果计数：`row_count = 19`、`inserted_count = 19`、`duplicate_count = 0`。

**入库检查**：任何表、任何字段里都不能出现 `400000002`、`012345400000003`、`499999999`、`280672605`。

### R5.1 重算
把 #16 手动改成 Groceries / Supermarket → 归属人自动变成 Home（category）。
再把 #16 的归属人手动改成 Female（manual），然后把分类改成 Uncategorised → 归属人**保持** Female。

### 2026 年 9 月统计（只导入这一个文件时，R10）

| 指标 | 期望 |
|---|---|
| 支出 | 46673 分（$466.73） |
| 收入 | 0 |
| 储蓄率 | "—"（收入为 0） |
| 未分类 | 4 笔（#7、#15、#16、#18） |
| Groceries / Supermarket | 3875 + 6230 − 150 + 6748 = 16703 |
| Personal & medical / Other | -4390（负数，照实显示） |
| Bank fees | 0（扣费和退回抵消） |
| 支出按归属人 | Male 900，Female 0，Home 45773 |

### 按周汇总（R10.2，时间段 2026 年 9 月，指标支出）

| 周 | 支出(分) |
|---|---|
| 9/1–9/6（部分） | 6748 |
| 9/7–9/13 | 8580 |
| 9/14–9/20 | -515 |
| 9/21–9/27 | 21120 |
| 9/28–9/30（部分） | 10740 |
| 合计 | 46673 |

### 拆分（R15，在上面导入完成后操作）

对 #19 依次拆出：15.00 → Home & utilities / Household supplies；8.00 → Personal & medical / Cosmetics & toiletries（都不选归属人）。

| 拆分 | 金额(分) | 分类 | 归属人 |
|---|---|---|---|
| 主 | -4448 | Groceries / Supermarket | Home (category) |
| 2 | -1500 | Home & utilities / Household supplies | Home (category) |
| 3 | -800 | Personal & medical / Cosmetics & toiletries | Male (card) |

拆分后 9 月统计：

| 指标 | 期望 |
|---|---|
| 支出 | 46673（不变） |
| Groceries / Supermarket | 14403 |
| Home & utilities / Household supplies | 1500 |
| 支出按归属人 | Male 1700，Female 0，Home 44973 |

删除拆分 3 后，主拆分回到 -5248。

---

## 期望结果：再导入 `joint-2026-09-overlap.csv`

| 行 | 结果 |
|---|---|
| 08/10 WOOLWORTHS（卡 2222） | 新增，Groceries / Supermarket，Home（category） |
| 03/10 FROM ****0002 | 新增，Internal transfer，auto |
| 30/09 两行费用、29/09 BPAY、25/09 ATM | 跳过（重复） |
| 28/09 GONG CHA 第 1、2 笔 | 跳过（重复） |
| 28/09 GONG CHA 第 3 笔 | **新增**（occurrence=3），Male（card） |

计数：`row_count = 9`、`inserted_count = 3`、`duplicate_count = 6`。

---

## 期望结果：再导入 `me-2026-09.csv`（到 ANZ Male）

| 行 | 结果 |
|---|---|
| 21/09 PAYID PAYMENT -80.00 | Uncategorised，Male；和 Joint #7（22/09 +80.00）互为兜底建议，两边 `transfer_status = suggested`，配对 |
| 14/09 MYKI | Transport & auto / Public transport，Male（account） |
| 03/09 TO ****0001 -2000.00 | Internal transfer，auto；和 Joint #17 配对（`transfer_pair_id` 互相指向） |
| 01/09 PAY/SALARY | Uncategorised（没有工资规则），正数 |

suggested 确认前，#7 和 PAYID PAYMENT 仍按 Uncategorised 统计。

---

## 期望结果：导入 `wife-2026-09.csv`（到 ANZ Female）

| 行 | 分类 | 归属人 | is_pre_tax |
|---|---|---|---|
| 30/09 CREDIT INTEREST PAID +12.34 | Income / Interest | Female (account) | true |
| 28/09 BPAY TAX OFFICE PAYMENTS -900.00 | Income / Tax (ATO) | Female (account) | false |
| 25/09 PAYID DEPOSIT FROM BETA CONSULTING PTY +3000.00 | Uncategorised | Female (account) | false |
| 15/09 KIS HAIR（卡 4444，未登记） | Personal & medical / Hair & beauty | Female (account) | false |

然后手动把 BETA CONSULTING 那笔改成 Income / Contract income (B2B) → `is_pre_tax` 自动变 true。

### 税后估算（R14，财年 2026）

Female 的 tax_profile：`payg_gross = 60,000.00`，`payg_withheld = 9,720.00`（R14.5 场景 A）。

| 时点 | 税前收入 | taxable | incomeTax | medicare | total | prepaid | owing |
|---|---|---|---|---|---|---|---|
| 刚导入（B2B 还没分类） | 12.34 | 60,012 | 8,523.60 | 1,200.24 | 9,723.84 | 900.00 | **-896.16**（预计退税） |
| B2B 改成 Contract income 后 | 3,012.34 | 63,012 | 9,423.60 | 1,260.24 | 10,683.84 | 900.00 | **63.84** |

Male 没有 tax_profile 也没有税前收入 → 全部为 0，卡片提示去设置页填写。

### 9 月收入统计（只算这个文件）
收入 = 1234 − 90000 + 300000（分类后）= 211234 分，其中税前 301234 分。

---

## pending 匹配用例（R8）

在导入 `joint-2026-09.csv` **之前**，先在 ANZ Joint 手动录入这些 pending：

| pending | 金额 | 日期 | 期望 |
|---|---|---|---|
| P1 | -61.20 | 2026-09-20 | 匹配 #8（相差 2 天）→ 确认，不新增；日期变 09-22，保留 P1 的分类和归属人 |
| P2 | -38.75 | 2026-09-20 | 匹配 #9（相差 0 天）→ 确认 |
| P3 | -25.00 | 2026-09-11 | 和 P4 一起，#12 有 2 个候选 → #12 正常新增，提示可能重复 |
| P4 | -25.00 | 2026-09-12 | 同上 |
| P5 | -10.00 | 2026-09-05 | 没有匹配 → 保持 pending，导入结果里提示检查 |
| P6 | -67.48 | 2026-09-02 | #19 日期 09-01 **早于** pending → 不匹配（R8.2 银行日期不早于消费日期）；#19 新增；P6 提示检查 |

计数：`inserted_count = 17`、`matched_pending_count = 2`。
