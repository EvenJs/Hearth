# ANZ Plus 对账单用例（R1D，M7.5）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

`anz-plus-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1D 第一层的输出），不是 PDF，也不是真对账单。格式照 2026-10-30 看到的 4 份真实对账单的行结构（R1D）：第 1 行 `Account Statement`、账期带户名、地址 3 行、产品名、汇总两行（标签一行、值一行）、`Interest Earned` 两行、`Transactions`、表头、交易行（新的在前，每行金额、余额两段）、`Effective Date` 行、表底 `Opening Balance`、说明文字和页码。分页用单独一行 `<<<PAGE>>>`（和 R1C 一样）。

户名、地址、BSB `012 345`、账号 `400 000 004`（测试家庭 `ANZ Plus Male` 的尾号 `0004`）、金额都是编的。转账对方 `012345-400000002` 是 `ANZ Male`（尾号 `0002`）。

## 主文件 `growth-2026-09.txt`

```
Account Statement
1 September 2026 - 30 September 2026  Male Test
1/23 Example St
Melbourne VIC 3000
AUS
ANZ Plus Growth Saver
Branch Number (BSB)  Account Number  Opening Balance  Closing Balance
012 345  400 000 004  $10,000.00  $10,725.00
Interest Earned  Account Name
+ $25.00  Male Test
Transactions
Date  Description  Credit  Debit  Balance
30 Sep  BONUS CREDIT INTEREST PAID  $20.00  $10,725.00
30 Sep  CREDIT INTEREST PAID  $5.00  $10,705.00
15 Sep  TRANSFER TO 012345-400000002 #100002  $300.00  $10,700.00
Effective Date 14/09/2026
02 Sep  TRANSFER FROM 012345-400000002 #100001  $1,000.00  $11,000.00
Opening Balance  $10,000.00
Please check this statement carefully.
Footer text about ANZ Plus.
Australia and New Zealand Banking Group Limited (ANZ).  Page 1 of 1
```

解析结果见 R1D.1 那张 4 行的表。

## 其他文件

都是在主文件上改一点：

| 文件 | 和主文件的区别 |
| --- | --- |
| `growth-2026-10.txt` | `1 October 2026 - 31 October 2026`，期初、期末都是 `$10,725.00`（= 主文件期末），**没有 `Interest Earned` 那两行**（账户名那两行还在），表头下面直接是表底 `Opening Balance  $10,725.00`，0 笔 |
| `first-day.txt` | 表底上面多一笔 `01 Sep  TRANSFER FROM 012345-400000002 #100000  $10.00  $10,010.00`，上面每行余额都加 10.00，期末 `$10,735.00` |
| `notes-page-2.txt` | 表底 `Opening Balance` 后面插一行 `<<<PAGE>>>`，说明文字和页码在第 2 页（页码改成 `Page 1 of 2`、`Page 2 of 2`） |
| `multi-page.txt` | `CREDIT INTEREST PAID` 那行后面插一行 `<<<PAGE>>>`，下面两笔和表底在第 2 页 |
| `broken-balance.txt` | `TRANSFER TO` 那行的余额改成 `$10,600.00` |
| `wrong-account.txt` | 账号改成 `400 000 002`（`ANZ Male` 的尾号） |
| `interest-mismatch.txt` | `Interest Earned` 改成 `+ $30.00` |
| `unknown-line.txt` | `TRANSFER TO` 那行下面、`Effective Date` 上面插一行 `MELBOURNE AU`（假装描述换行） |
| `year-rollover.txt` | 账期改成 `15 December 2026 - 14 January 2027`，交易日期改成 Dec、Jan（余额不变） |

## 解析用例（纯函数，M7.5-2）

失败的 `page`、`index` 照 R1D：`index` 是这一页从上往下数的第几笔，和交易无关的错误两个都是 `null`。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| A1 | `growth-2026-09.txt`，尾号 `0004` | 4 行，和 R1D.1 的表一样（旧的在前）；账期 `2026-09-01` 到 `2026-09-30`，期初 1000000，期末 1072500，利息 2500。`Effective Date` 没进描述；地址、页脚没进任何描述 |
| A2 | `growth-2026-10.txt` | 0 行，成功；期初 = 期末 = 1072500，利息 0 |
| A3 | `first-day.txt` | 5 行，第一行 `2026-09-01`、`1000`（账期是闭区间，1 号算这一份） |
| A4 | `notes-page-2.txt` | 4 行，和 A1 一样 |
| A5 | `multi-page.txt` | 失败"交易表跨页了，还没见过跨页的 ANZ Plus 对账单"，`page = 1`（表头那页），`index = null` |
| A6 | `broken-balance.txt` | 失败"第 3 笔余额接不上"，`page = 1`，`index = 3` |
| A7 | `wrong-account.txt`，尾号 `0004` | 失败"这份对账单不是这个账户的"；信息里没有 `400000002`、`400 000 002`，最多有 `0002` |
| A8 | `growth-2026-09.txt`，尾号 `null` | 失败，提示先去账户设置填尾号 |
| A9 | `interest-mismatch.txt` | 失败，信息里有利息合计 $25.00 和 Interest Earned $30.00，`page = null` |
| A10 | `unknown-line.txt` | 失败"交易表里第 3 笔下面有一行认不出来"，`page = 1`，`index = 3` |
| A11 | `year-rollover.txt` | 失败"账期跨年了，还没见过跨年的 ANZ Plus 对账单"，`page = null` |
| A12 | 主文件去掉 `Interest Earned` 那两行（测试里现改） | 失败：利息合计 $25.00，但没有 Interest Earned（当 0） |
| A13 | 主文件 `02 Sep` 改成 `02 Oct`（测试里现改） | 失败"第 4 笔的日期不在账期里"，`page = 1`，`index = 4` |
| A14 | 主文件汇总的期末改成 `$10,726.00`（测试里现改） | 失败：最新一笔的余额和期末对不上，`page = null` |
| A15 | 主文件表底改成 `Opening Balance  $9,999.00`（测试里现改） | 失败：表底的期初和汇总对不上，`page = null` |
| A16 | 主文件第 1 行改成 `ANZ ACCOUNT STATEMENT`，或者产品行改成 `Growth Saver`（测试里现改） | 失败"这不像 ANZ Plus 对账单" |
| A17 | `fixtures/anz-statement/joint-2026-09.txt` 给 R1D | 失败"这不像 ANZ Plus 对账单" |
| A18 | `growth-2026-09.txt` 给 R1C（`parseAnzStatement`） | 失败"找不到对账单标题" |

## 导入用例（连数据库，M7.5-5）

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| B1 | 空数据库 | 不选账户，导入 `growth-2026-09.txt` | 认出 `ANZ Plus Male`；新增 4，`source = pdf`，`date_from = 2026-09-01`，`date_to = 2026-09-30`，期初期末从汇总来，`reconciled = true`。两笔转账的描述是 `012345-****0002`，`import_batch`、`transaction` 里没有 8 位以上连续数字 |
| B2 | B1 | 再导入 `growth-2026-09.txt` | 新增 0，跳过 4 |
| B3 | B1 | 导入 `growth-2026-10.txt` | 新增 0，建了批次，`date_from = 2026-10-01`，`reconciled = true`；R12.2 提示"和上一份对账单接上了" |
| B4 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 整份失败"找不到尾号是 0002 的 ANZ Plus 账户"（`ANZ Male` 尾号是 `0002` 也不算）；什么都没写 |
| B5 | 把 `ANZ Plus Male` 归档 | 不选账户，导入 `growth-2026-09.txt` | 整份失败"找不到尾号是 0004 的 ANZ Plus 账户"；什么都没写 |
| B6 | 再建一个 `anz_plus` 账户，尾号 `00004` | 不选账户，导入 `growth-2026-09.txt` | 整份失败"有 2 个 ANZ Plus 账户的尾号都对得上"；什么都没写 |
| B7 | 空数据库 | 往 `ANZ Plus Male` 传一份 CSV | 拒绝，信息说 ANZ Plus 只能导 PDF 对账单 |

和 ANZ 账户的转账配对（R6.2）、替换手动记的利息（R8.2）的用例在 M7.5-4、M7.5-5 加。
