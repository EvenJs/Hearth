# BOQ、Westpac 对账单用例（R1F、R1G，M9.5）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。Westpac 部分 M9.5-1 写，BOQ 部分 M9.5-3 写，同行内部转账（R6.1）M9.5-5 补。

**这一组另加的账户**（导入用例要先建好，解析用例只用尾号）。`bank = westpac` 是 M9.5-7 加的值：

| 账户 | bank | type | 默认归属人 | number_suffix |
| --- | --- | --- | --- | --- |
| Westpac Choice Male | westpac | everyday | Male | `0005` |
| Westpac Life Male | westpac | savings | Male | `0006` |

## Westpac（R1G，M9.5-1）

`westpac-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1G 第一层的输出），不是 PDF，也不是真对账单。格式照 2026-11-15 看到的 2 份真实对账单（Choice、Life 各一份）的行结构（R1G）：第 1 行 `Statement Period`、账期行（月份全称）、产品名和 `Account Name`、户名地址、`BSB  Account Number` 下一行是 `ddd-ddd  ddd ddd`、汇总 4 行、利率表、交易表（表头、`STATEMENT OPENING BALANCE`、交易 1 到 2 行、`CLOSING BALANCE`，日期 `DD/MM/YY`）、每页的页脚 `… Statement No. N  Page X of Y`、后两页说明。分页用单独一行 `<<<PAGE>>>`（和 R1C 到 R1E 一样）。

户名、地址、BSB `039-999`、账号 `120 005` / `120 006`、流水号、金额都是编的。

### 主文件 `choice-2026-11.txt`（导入到 `Westpac Choice Male`，尾号 `0005`）

```
Statement Period
01 November 2026 - 30 November 2026
Westpac Choice  Account Name
MR MALE A TEST
Customer ID
1 TEST STREET  0000 0000  Enquiries, Postal
PO BOX 0000
EXAMPLETON VIC 3000  BSB  Account Number
039-999  120 005
Opening Balance  $1,000.00
Total Credits  + $3,250.00
Total Debits  - $1,786.45
Closing Balance  + $2,463.55
INTEREST RATES (per annum) ON CREDIT BALANCES
Effective Date  Rate
$0
01 Nov 2026  0.01 %
Note text about how interest is calculated on this account.
interest.
Transactions
Please check the entries on this statement and promptly inform Westpac of any possible error or unauthorised transaction
DATE  TRANSACTION DESCRIPTION  DEBIT  CREDIT  BALANCE
01/11/26  STATEMENT OPENING BALANCE  1,000.00
01/11/26  Deposit-Osko Payment 1000001 TEST FRIEND 31
Oct 2026  500.00  1,500.00
03/11/26  Withdrawal Mobile 1000002 Tfr Westpac Lif  300.00  1,200.00
03/11/26  Withdrawal Mobile 1000003 Tfr Westpac Lif  300.00  900.00
10/11/26  Deposit-Osko Payment 1000004 ACME PTY LTD 09
Nov 2026  2,750.00  3,650.00
15/11/26  Withdrawal Mobile 1000005 Tfr Westpac Lif  1,186.45  2,463.55
30/11/26  CLOSING BALANCE  2,463.55
Convenience at your fingertips
Use Online, Mobile or the Westpac App to check balances and view your account activity
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 1 of 3
<<<PAGE>>>
Westpac Choice
Important information
Please check this statement carefully. The Closing Balance shown may not be your available balance.
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 2 of 3
<<<PAGE>>>
Westpac Choice
Westpac Help  Contact us  Other text
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 3 of 3
```

几处故意的：

- 两笔 Osko 都是 2 行，**金额在第 2 行**，原始日期拆成两半（`31` / `Oct 2026`）；第一笔的原始日期 `31 Oct 2026` 在账期前一天，不能当交易日期
- 两笔 `03/11/26` 转出同一天同额，流水号不同（真实的也是每笔不同），描述不同，`occurrence` 都是 1
- 利率表的 `01 Nov 2026  0.01 %` 不是交易（日期不是 `DD/MM/YY`）；第 2 页说明里的 `Closing Balance` 不在行首，不是汇总
- 第 1 页的户名、地址、`Customer ID`、说明，后两页，页脚都不用

解析结果：5 行，**旧的在前**，和 R1G.1 那张表一样。账期 `2026-11-01` 到 `2026-11-30`，期初 100000，期末 246355，借合计 178645，贷合计 325000。

### `life-2026-11.txt`（导入到 `Westpac Life Male`，尾号 `0006`）

Choice 那 3 笔转出在 Life 这边的样子（流水号和 Choice 那边**不一样**，真实的也是）：

```
Statement Period
01 November 2026 - 30 November 2026
Westpac Life  Account Name
MR MALE A TEST
Customer ID
1 TEST STREET  0000 0000  Enquiries, Postal
PO BOX 0000
EXAMPLETON VIC 3000  BSB  Account Number
039-999  120 006
Opening Balance  $0.00
Total Credits  + $1,786.45
Total Debits  - $0.00
Closing Balance  + $1,786.45
INTEREST RATES (per annum) ON CREDIT BALANCES
Effective Date  Rate
$0
01 Nov 2026  0.01 %
BONUS INTEREST RATES (per annum)
Effective Date  Rate
$0
01 Nov 2026  0.01 %
Transactions
Please check the entries on this statement and promptly inform Westpac of any possible error or unauthorised transaction
DATE  TRANSACTION DESCRIPTION  DEBIT  CREDIT  BALANCE
01/11/26  STATEMENT OPENING BALANCE  0.00
03/11/26  Deposit Online 2000001 Tfr Westpac Cho  300.00  300.00
03/11/26  Deposit Online 2000002 Tfr Westpac Cho  300.00  600.00
15/11/26  Deposit Online 2000003 Tfr Westpac Cho  1,186.45  1,786.45
30/11/26  CLOSING BALANCE  1,786.45
Convenience at your fingertips
Use Online, Mobile or the Westpac App to check balances and view your account activity
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 1 of 3
<<<PAGE>>>
Westpac Life
Important information
Please check this statement carefully. The Closing Balance shown may not be your available balance.
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 2 of 3
<<<PAGE>>>
Westpac Life
Westpac Help  Contact us  Other text
Westpac Banking Corporation ABN 00 000 000 000 AFSL and Australian credit licence 000000  Statement No. 2  Page 3 of 3
```

期初 `$0.00` 不带 `+`、借合计 `- $0.00`，和真实的一样。

### 其他文件

都是在 `choice-2026-11.txt` 上改一点：

| 文件 | 和主文件的区别 |
| --- | --- |
| `one-day.txt` | 网银按需申请的一天对账单：`Statement No. 1`；账期 `03 November 2026 - 03 November 2026`；汇总 `Opening Balance  + $1,500.00`、`Total Credits  + $0.00`、`Total Debits  - $600.00`、`Closing Balance  + $900.00`；表里是 `03/11/26  STATEMENT OPENING BALANCE  1,500.00`、主文件那两笔 `03/11/26  Withdrawal Mobile …`（原样）、`03/11/26  CLOSING BALANCE  900.00`。和主文件账期重叠 |
| `empty-2026-12.txt` | `Statement No. 3`；账期 `01 December 2026 - 31 December 2026`；汇总 `Opening Balance  + $2,463.55`、`Total Credits  + $0.00`、`Total Debits  - $0.00`、`Closing Balance  + $2,463.55`；表头下面是 `01/12/26  STATEMENT OPENING BALANCE  2,463.55`，直接接 `31/12/26  CLOSING BALANCE  2,463.55`，0 笔 |
| `broken-balance.txt` | `10/11/26` 那笔 Osko 第 2 行的余额改成 `3,650.10` |
| `wrong-account.txt` | 账号那行改成 `039-999  120 002`（`ANZ Male` 的尾号） |
| `unknown-line.txt` | `03/11/26  Withdrawal Mobile 1000002 … 1,200.00` 下面插一行 `EXTRA NOTE`（假装描述换到了金额后面） |
| `multi-page.txt` | 在 `03/11/26  Withdrawal Mobile 1000003 …` 和 `10/11/26  Deposit-Osko …` 之间插 3 行：第 1 页的页脚（`… Statement No. 2  Page 1 of 4`）、`<<<PAGE>>>`、`Westpac Choice`，后面几页的页码跟着改成 `of 4`（假装表跨到了第 2 页，样子是编的） |
| `summary-mismatch.txt` | 汇总的 `Total Debits` 改成 `- $1,786.46` |

### 解析用例（纯函数，M9.5-2）

失败的 `page`、`index` 照 R1G：`index` 是这一页从上往下数的第几笔，和交易无关的错误两个都是 `null`。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| W1 | `choice-2026-11.txt`，尾号 `0005` | 5 行，和 R1G.1 那张表一样（旧的在前）；账期 `2026-11-01` 到 `2026-11-30`，期初 100000，期末 246355。户名、地址、汇总、利率表、说明、页脚、后两页都没进任何描述 |
| W2 | 同上 | 第 1 行是 `2026-11-01`、`50000`、描述 `Deposit-Osko Payment 1000001 TEST FRIEND 31 Oct 2026`（日期用 `DATE` 那列，不是描述里的 `31 Oct`；账期第一天算这一份）；两笔 `2026-11-03` 的顺序是余额 120000 在前、90000 在后 |
| W3 | `life-2026-11.txt`，尾号 `0006` | 3 行：`2026-11-03`、`30000`、`Deposit Online 2000001 Tfr Westpac Cho`、`30000`；`2026-11-03`、`30000`、`Deposit Online 2000002 Tfr Westpac Cho`、`60000`；`2026-11-15`、`118645`、`Deposit Online 2000003 Tfr Westpac Cho`、`178645`。期初 0，期末 178645 |
| W4 | `one-day.txt`，尾号 `0005` | 2 行，和 W1 的第 2、3 行完全一样（日期、金额、描述、余额）；账期 `2026-11-03` 到 `2026-11-03`，期初 150000，期末 90000 |
| W5 | `empty-2026-12.txt` | 0 行，成功；期初 = 期末 = 246355（期初带 `+` 也认） |
| W6 | `broken-balance.txt` | 失败"第 4 笔余额接不上"，`page = 1`，`index = 4` |
| W7 | `wrong-account.txt`，尾号 `0005` | 失败"这份对账单不是这个账户的"；信息里没有 `120002`、`120 002`、`039-999`、`039999`，最多有 `0002` |
| W8 | `choice-2026-11.txt`，尾号 `null` | 失败，提示先去账户设置填尾号 |
| W9 | 主文件删掉账号那行 `039-999  120 005`（测试里现改） | 失败"找不到账号" |
| W10 | `unknown-line.txt` | 失败"交易表里第 2 笔下面有一行认不出来"，`page = 1`，`index = 2` |
| W11 | 主文件第一笔 Osko 的第 2 行改成 `Oct 2026`（去掉金额余额，测试里现改） | 失败"第 1 笔找不到金额和余额"，`page = 1`，`index = 1` |
| W12 | `multi-page.txt` | 失败"交易表跨页了，还没见过跨页的 Westpac 对账单"，`page = 1`（表头那页），`index = null` |
| W13 | `summary-mismatch.txt` | 失败，信息里有逐笔借合计 $1,786.45 和 Total Debits $1,786.46，`page = null` |
| W14 | 主文件删掉 `Total Credits` 那行（测试里现改） | 失败"找不到汇总" |
| W15 | 主文件 `Opening Balance  $1,000.00` 改成 `Opening Balance  - $1,000.00`（测试里现改） | 失败"没见过透支的对账单"，`page = null` |
| W16 | 主文件账期行改成 `01 November 2026 - 29 November 2026`（测试里现改） | 失败"账期和 OPENING / CLOSING BALANCE 的日期对不上"，`page = null` |
| W17 | 主文件账期行改成 `01 November 2026 - 30 November 2027`，`CLOSING BALANCE` 那行的日期改成 `30/11/27`（测试里现改） | 失败"账期超过 12 个月，还没见过这么长的 Westpac 对账单"，`page = null` |
| W18 | 主文件 `10/11/26  Deposit-Osko` 改成 `02/11/26  Deposit-Osko`（测试里现改） | 失败"第 4 笔的日期比上一笔早"，`page = 1`，`index = 4` |
| W19 | 主文件 `15/11/26  Withdrawal` 改成 `01/12/26  Withdrawal`（测试里现改） | 失败"第 5 笔的日期不在账期里"，`page = 1`，`index = 5` |
| W20 | 主文件 `15/11/26  Withdrawal` 改成 `31/11/26  Withdrawal`（测试里现改） | 失败"第 5 笔的日期不对"，`page = 1`，`index = 5` |
| W21 | 主文件删掉第 1 行 `Statement Period`（测试里现改） | 失败"这不像 Westpac 对账单" |
| W22 | `fixtures/anz-statement/joint-2026-09.txt`、`fixtures/anz-plus-statement/growth-2026-09.txt`、`fixtures/cba-statement/female-2026-09.txt` 给 R1G | 都失败"这不像 Westpac 对账单" |
| W23 | `choice-2026-11.txt` 给 R1C（`parseAnzStatement`）、R1D（`parseAnzPlusStatement`）、R1E（`parseCbaStatement`） | 分别失败"找不到对账单标题"、"这不像 ANZ Plus 对账单"、"这不像 CBA 对账单" |
| W24 | 自动选解析器：`choice-2026-11.txt`、`life-2026-11.txt`、`joint-2026-09.txt`、`growth-2026-09.txt`、`female-2026-09.txt`、一份只有 `Hello` 一行的文字 | 分别是 R1G、R1G、R1C、R1D、R1E、失败"认不出这份对账单，只支持 ANZ、ANZ Plus、CBA、Westpac 的 PDF 对账单"（M9.5-3 加 BOQ 以后这句跟着改） |

### 导入用例（连数据库，M9.5-9）

前提：建好上面两个 Westpac 账户。`Tfr Westpac Lif` / `Tfr Westpac Cho` 那几笔认不认成内部转账，等 M9.5-5（R6.1）定了再补，这里只看解析、去重、对账。

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| WD1 | 空数据库 | 不选账户，导入 `choice-2026-11.txt` | 认出 `Westpac Choice Male`；新增 5，`source = pdf`，`date_from = 2026-11-01`，`date_to = 2026-11-30`，期初 100000、期末 246355，`reconciled = true`；归属人都是 Male（账户默认）。`import_batch`、`transaction` 里没有 `120005`、`039999` |
| WD2 | WD1 | 再导入 `choice-2026-11.txt` | 新增 0，跳过 5 |
| WD3 | 空数据库 | 先导 `one-day.txt`，再导 `choice-2026-11.txt` | `one-day.txt`：新增 2，`date_from = date_to = 2026-11-03`，`reconciled = true`。`choice-2026-11.txt`：R4.2 跳过 2（key 一样：不用账期、`Statement No.`），新增 3，`reconciled = true`；R12.2 不提示首尾衔接（没有 `date_to` 早于 2026-11-01 的批次），提示"和 2026-11-03 到 2026-11-03 那份对账单的账期重叠了，重叠的交易已经跳过" |
| WD4 | WD1 | 导入 `empty-2026-12.txt` | 新增 0，建了批次，`date_from = 2026-12-01`，`reconciled = true`；R12.2 提示"和上一份对账单（2026-11-01 到 2026-11-30）接上了"，没有重叠提示 |
| WD5 | WD1 | 导入 `one-day.txt` | 跳过 2，新增 0；R12.2 不提示首尾衔接，提示和 2026-11-01 到 2026-11-30 那份重叠 |
| WD6 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 整份失败"找不到尾号是 0002 的 Westpac 账户"（`ANZ Male` 尾号是 `0002` 也不算）；什么都没写 |
| WD7 | 再建一个 `westpac` 账户，尾号 `20005` | 不选账户，导入 `choice-2026-11.txt` | 整份失败"有 2 个 Westpac 账户的尾号都对得上"；什么都没写 |
| WD8 | 空数据库 | 不选账户，导入 `life-2026-11.txt` | 认出 `Westpac Life Male`（不是 Choice）；新增 3 |
| WD9 | 空数据库 | 不选账户，导入 `anz-statement/joint-2026-09.txt`、`anz-plus-statement/growth-2026-09.txt`、`cba-statement/female-2026-09.txt` | 照旧分别认出 `ANZ Joint`、`ANZ Plus Male`、`CBA Female`（四选一以后 R1C、R1D、R1E 不受影响） |

## BOQ（R1F，M9.5-3）

M9.5-3 写。
