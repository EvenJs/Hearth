# 期望结果：导入 `cba/female-2026-09.csv`（到 CBA Female）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：第 4 步，接 03。

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

## 然后手动操作

1. #3 改成 Income / Contract income (B2B) → `is_pre_tax` 自动变 true
2. #15 改成 Entertainment & eat-out / Restaurants（朋友 AA 转回来，冲减支出）

## 9 月统计（只算这个文件，做完上面两步后）

| 指标         | 期望                                                          |
| ------------ | ------------------------------------------------------------- |
| 收入         | 1234 − 90000 + 300000 + 400 + 41000 = 252634，其中税前 301234 |
| 支出         | 248125 − 2250 = 245875                                        |
| Restaurants  | 4500 − 2250 = 2250                                            |
| 支出按归属人 | Home 244525，Female 1350                                      |
| 未分类       | 2 笔（#12、#13）                                              |
| 内部转账     | #4、#10，不计收支                                             |

## 税后估算（R14，财年 2026）

Female 的 tax_profile：`payg_gross = 60,000.00`，`payg_withheld = 9,720.00`（R14.5 场景 A）。

| 时点                       | 税前收入 | taxable | incomeTax | medicare | total     | prepaid | owing                   |
| -------------------------- | -------- | ------- | --------- | -------- | --------- | ------- | ----------------------- |
| 刚导入（#3 还没分类）      | 12.34    | 60,012  | 8,523.60  | 1,200.24 | 9,723.84  | 900.00  | **-896.16**（预计退税） |
| #3 改成 Contract income 后 | 3,012.34 | 63,012  | 9,423.60  | 1,260.24 | 10,683.84 | 900.00  | **63.84**               |

Male 没有 tax_profile 也没有税前收入 → 全部为 0，卡片提示去设置页填写（不做下面 P7 时）。
