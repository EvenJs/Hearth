# BOQ、Westpac 对账单用例（R1F、R1G，M9.5）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。Westpac 部分 M9.5-1 写，BOQ 部分 M9.5-3 写，同行内部转账（R6.1）M9.5-5 写，在最后一节。

**这一组另加的账户**（导入用例要先建好，解析用例只用尾号）。`bank = boq`、`westpac` 和 `statement_name` 列是 M9.5-7 加的；`statement_name` 照对账单上印的产品名填（BOQ 是 `Account name` 那行，Westpac 是左上角）：

| 账户 | bank | type | 默认归属人 | number_suffix | statement_name |
| --- | --- | --- | --- | --- | --- |
| BOQ Everyday Male | boq | everyday | Male | `0007` | `Everyday Account` |
| BOQ Future Saver Male | boq | savings | Male | `0008` | `Future Saver` |
| Westpac Choice Male | westpac | everyday | Male | `0005` | `Westpac Choice` |
| Westpac Life Male | westpac | savings | Male | `0006` | `Westpac Life` |

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
| W24 | 自动选解析器：`choice-2026-11.txt`、`life-2026-11.txt`、`joint-2026-09.txt`、`growth-2026-09.txt`、`female-2026-09.txt`、一份只有 `Hello` 一行的文字 | 分别是 R1G、R1G、R1C、R1D、R1E、失败"认不出这份对账单，只支持 ANZ、ANZ Plus、CBA、BOQ、Westpac 的 PDF 对账单"（五选一，R1F；BOQ 的见 Q30） |

### 导入用例（连数据库，M9.5-9）

前提：建好上面两个 Westpac 账户。这里只看解析、去重、对账；`Tfr Westpac Lif` / `Tfr Westpac Cho` 认成内部转账的见最后一节 TD。

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

`boq-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1F 第一层的输出），不是 PDF，也不是真对账单。格式照 2026-11-15 看到的 2 份真实对账单（Everyday、Future Saver 各一份）的行结构（R1F）：每页第 1 行标题、`Statement period`、账期行、户名地址、`Account summary` 下面 7 行两栏交错（产品名、汇总、BSB、账号）、交易表（小标题、表头、第一个表头下面的 `A` 和年份行、每笔 2 到 3 行、日期 `DD-Mon  DD-Mon`）、页脚（`Bank of Queensland Limited ABN …`、`Page X of Y  | Statement continues over`）、后两页说明。分页用单独一行 `<<<PAGE>>>`（和 R1C 到 R1G 一样）。

户名、地址、BSB `129-999`、账号 `100000007` / `100000008`、金额都是编的。

### 主文件 `everyday-2026-11.txt`（导入到 `BOQ Everyday Male`，尾号 `0007`）

```
Everyday Account Statement
Statement period
01 Nov 2026 - 30 Nov 2026
MR MALE A TEST
UNIT 1 0000/000 TEST ST
EXAMPLETON VIC 3000
Account summary
Account name  Everyday Account
Opening balance  $0.00
Account BSB  129-999
Total credits  $3,500.00
Account number  100000007
Total debits  $ 1,512.50
Closing balance  $1,987.50
Transactions
Date  Processed  Description  Debits ($)  Credits ($)  Balance ($)
A
2026
03-Nov  03-Nov  From: TEST FRIEND  1,000.00  1,000.00
NA
03-Nov  03-Nov  To: Future Saver  -400.00  600.00
NOTPROVIDED
03-Nov  03-Nov  To: Future Saver  -600.00
NOTPROVIDED
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 1 of 4  | Statement continues over
<<<PAGE>>>
Everyday Account Statement
Transactions
Date  Processed  Description  Debits ($)  Credits ($)  Balance ($)
05-Nov  05-Nov  From: ACME PTY LTD  2,500.00  2,500.00
Wages
NA
06-Nov  06-Nov  To: Future Saver  -100.00  2,400.00
NOTPROVIDED
06-Nov  06-Nov  To: Future Saver  -100.00  2,300.00
NOTPROVIDED
06-Nov  06-Nov  To: Future Saver  -100.00  2,200.00
NOTPROVIDED
06-Nov  06-Nov  To: Future Saver  -100.00  2,100.00
NOTPROVIDED
06-Nov  06-Nov  To: Future Saver  -100.00  2,000.00
NOTPROVIDED
10-Nov  10-Nov  TEST CAFE MELBOURNE  -12.50  1,987.50
Eftpos Purchase -
Card 1234
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 2 of 4  | Statement continues over
<<<PAGE>>>
Everyday Account Statement
Important information about your account and how to report a lost card.
Page 3 of 4  | Statement continues over
<<<PAGE>>>
Everyday Account Statement
How we calculate interest
Interest is paid monthly. Interest is calculated on the daily closing balance of your account.
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 4 of 4
```

几处故意的：

- 第 3 笔**余额没印**（上一笔 600.00 − 600.00 = 0），是第 1 页最后一笔，和真实的一样
- 表跨 2 页，第 2 页表头下面**没有年份行**；第 3 页没有 ABN 那行（真实的也没有）
- `11-06` 一天 5 笔 `To: Future Saver`，同额同描述，余额不同
- 两种 `From:`：`TEST FRIEND`（续行只有 `NA`）、`ACME PTY LTD`（续行是备注 `Wages` + `NA`，3 行）
- `Account name  Everyday Account` 是产品名；户名地址、`Card 1234` 都不进卡号映射
- 说明页里的 `closing balance` 不在行首，不是汇总

解析结果：10 行，**旧的在前**：

| # | date | amountCents | description | balanceCents |
| --- | --- | --- | --- | --- |
| 1 | 2026-11-03 | 100000 | `From: TEST FRIEND NA` | 100000 |
| 2 | 2026-11-03 | -40000 | `To: Future Saver NOTPROVIDED` | 60000 |
| 3 | 2026-11-03 | -60000 | `To: Future Saver NOTPROVIDED` | 0 |
| 4 | 2026-11-05 | 250000 | `From: ACME PTY LTD Wages NA` | 250000 |
| 5 | 2026-11-06 | -10000 | `To: Future Saver NOTPROVIDED` | 240000 |
| 6 | 2026-11-06 | -10000 | `To: Future Saver NOTPROVIDED` | 230000 |
| 7 | 2026-11-06 | -10000 | `To: Future Saver NOTPROVIDED` | 220000 |
| 8 | 2026-11-06 | -10000 | `To: Future Saver NOTPROVIDED` | 210000 |
| 9 | 2026-11-06 | -10000 | `To: Future Saver NOTPROVIDED` | 200000 |
| 10 | 2026-11-10 | -1250 | `TEST CAFE MELBOURNE Eftpos Purchase - Card 1234` | 198750 |

账期 `2026-11-01` 到 `2026-11-30`，期初 0，期末 198750，借合计 151250，贷合计 350000。第 1 到 3 笔在第 1 页（`index` 1 到 3），第 4 到 10 笔在第 2 页（`index` 1 到 7）。

### `saver-2026-11.txt`（导入到 `BOQ Future Saver Male`，尾号 `0008`）

主文件那 7 笔 `To: Future Saver` 在 Saver 这边的样子。表从第 2 页开始：

```
Future Saver Statement
Statement period
01 Nov 2026 - 30 Nov 2026
MR MALE A TEST  Current rate
UNIT 1 0000/000 TEST ST  0.00% p.a
EXAMPLETON VIC 3000
Base rate
0.00% p.a.
Bonus rate
0.00% p.a.
Account summary
Account name  Future Saver
Opening balance  $0.00
Account BSB  129-999
Total credits  $1,500.00
Account number  100000008
Total debits  $ 0.00
Closing balance  $1,500.00
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 1 of 4  | Statement continues over
<<<PAGE>>>
Future Saver Statement
Transactions
Date  Processed  Description  Debits ($)  Credits ($)  Balance ($)
A
2026
03-Nov  03-Nov  From: Everyday  400.00  400.00
Account
NOTPROVIDED
03-Nov  03-Nov  From: Everyday  600.00  1,000.00
Account
NOTPROVIDED
06-Nov  06-Nov  From: Everyday  100.00  1,100.00
Account
NOTPROVIDED
06-Nov  06-Nov  From: Everyday  100.00  1,200.00
Account
NOTPROVIDED
06-Nov  06-Nov  From: Everyday  100.00  1,300.00
Account
NOTPROVIDED
06-Nov  06-Nov  From: Everyday  100.00  1,400.00
Account
NOTPROVIDED
06-Nov  06-Nov  From: Everyday  100.00  1,500.00
Account
NOTPROVIDED
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 2 of 4  | Statement continues over
<<<PAGE>>>
Future Saver Statement
Important information about your account and how to report a lost card.
Page 3 of 4  | Statement continues over
<<<PAGE>>>
Future Saver Statement
How we calculate interest
Interest is paid monthly. Interest is calculated on the daily closing balance of your account.
Bank of Queensland Limited ABN 00 000 000 000 (BOQ) AFSL and Australian credit licence 000000
Page 4 of 4
```

- 第 1 页只有汇总，没有表头；第 1 页右边粘着的利率、`Base rate` / `Bonus rate` 几行都不用
- `From: Everyday` + 续行 `Account`：对方产品名被拆成两行，和真实的一样
- `Total debits  $ 0.00`

解析结果：7 行（都在第 2 页），描述都是 `From: Everyday Account NOTPROVIDED`：`2026-11-03` `40000` 余额 `40000`；`2026-11-03` `60000` `100000`；`2026-11-06` `10000` 五笔，余额 `110000`、`120000`、`130000`、`140000`、`150000`。期初 0，期末 150000。

### 其他文件

除了 `cross-year.txt`，都是在 `everyday-2026-11.txt` 上改一点：

| 文件 | 和主文件的区别 |
| --- | --- |
| `on-demand.txt` | 网银按需申请的：账期 `03 Nov 2026 - 06 Nov 2026`；汇总 `Total debits  $ 1,500.00`、`Closing balance  $2,000.00`（`Opening balance`、`Total credits` 不变）；删掉第 10 笔（`10-Nov  TEST CAFE …` 和它的 2 行续行）。和主文件账期重叠 |
| `empty-2026-12.txt` | 账期 `01 Dec 2026 - 31 Dec 2026`；汇总 `Opening balance  $1,987.50`、`Total credits  $0.00`、`Total debits  $ 0.00`、`Closing balance  $1,987.50`；删掉第 1 页的 3 笔（`2026` 下面直接是页脚）和整个第 2 页，后面的页码改成 `of 3`，0 笔（空的样子是编的） |
| `cross-year.txt` | 单独写的：账期 `15 Dec 2026 - 14 Jan 2027`；汇总 `Opening balance  $1,987.50`、`Total credits  $0.00`、`Total debits  $ 112.50`、`Closing balance  $1,875.00`；表只有第 1 页，`A`、`2026` 下面是 `20-Dec  20-Dec  TEST CAFE MELBOURNE  -12.50  1,975.00` / `Eftpos Purchase -` / `Card 1234`、`05-Jan  05-Jan  To: Future Saver  -100.00  1,875.00` / `NOTPROVIDED`，然后页脚（跨年的样子是编的） |
| `broken-balance.txt` | 第 6 笔（第 2 页 `2,300.00` 那笔）的余额改成 `2,300.10` |
| `wrong-account.txt` | 账号那行改成 `Account number  100000002`（`ANZ Male` 的尾号） |
| `summary-mismatch.txt` | 汇总改成 `Total debits  $ 1,512.51` |

### 解析用例（纯函数，M9.5-4）

失败的 `page`、`index` 照 R1F：`index` 是这一页从上往下数的第几笔，和交易无关的错误两个都是 `null`。"测试里现改"的都在主文件上改。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| Q1 | `everyday-2026-11.txt`，尾号 `0007` | 10 行，和上面那张表一样（旧的在前）；账期 `2026-11-01` 到 `2026-11-30`，期初 0，期末 198750。户名、地址、汇总、`A`、`2026`、小标题、表头、页脚、后两页都没进任何描述 |
| Q2 | 同上 | 第 3 行余额 0（**没印，算出来的**）；第 5 到 9 行是 5 笔同日同额同描述，余额 240000 到 200000 依次递减；第 4 到 10 行年份都是 2026（第 2 页没有年份行） |
| Q3 | `saver-2026-11.txt`，尾号 `0008` | 7 行，描述都是 `From: Everyday Account NOTPROVIDED`（拆成两行的产品名拼回去了），余额和上面一样；期初 0，期末 150000 |
| Q4 | 第 3 笔第一行末尾补上 `  0.00`（印了 0） | 和 Q1 完全一样（第 3 行余额 0） |
| Q5 | 第 3 笔金额改成 `-500.00`，余额照旧空着 | 失败"第 3 笔没有余额，算出来也不是 0"，`page = 1`，`index = 3` |
| Q6 | `on-demand.txt` | 9 行，和 Q1 的第 1 到 9 行完全一样（日期、金额、描述、余额）；账期 `2026-11-03` 到 `2026-11-06`，期初 0，期末 200000 |
| Q7 | `cross-year.txt` | 2 行：`2026-12-20`、`-1250`、`TEST CAFE MELBOURNE Eftpos Purchase - Card 1234`、`197500`；`2027-01-05`、`-10000`、`To: Future Saver NOTPROVIDED`、`187500`（Dec → Jan 加一年） |
| Q8 | `empty-2026-12.txt` | 0 行，成功；期初 = 期末 = 198750 |
| Q9 | `broken-balance.txt` | 失败"第 3 笔余额接不上"，`page = 2`，`index = 3` |
| Q10 | 第 2 笔的 `-400.00` 改成 `400.00`（符号和余额对不上） | 失败"第 2 笔余额接不上"，`page = 1`，`index = 2` |
| Q11 | `wrong-account.txt`，尾号 `0007` | 失败"这份对账单不是这个账户的"；信息里没有 `100000002`、`129-999`、`129999`，最多有 `0002` |
| Q12 | `everyday-2026-11.txt`，尾号 `null` | 失败，提示先去账户设置填尾号 |
| Q13 | 删掉 `Account number  100000007` 那行 | 失败"找不到账号" |
| Q14 | `summary-mismatch.txt` | 失败，信息里有逐笔借合计 $1,512.50 和 Total debits $1,512.51，`page = null` |
| Q15 | 删掉 `Total credits` 那行 | 失败"找不到汇总" |
| Q16 | `Closing balance  $1,987.50` 改成 `Closing balance  -$1,987.50` | 失败"没见过透支的对账单"，`page = null` |
| Q17 | 第 10 笔的余额 `1,987.50` 改成 `-1,987.50` | 失败"没见过透支的对账单"，`page = 2`，`index = 7` |
| Q18 | 第 10 笔改成 `10-Nov  11-Nov  TEST CAFE …` | 失败"第 7 笔的 Date 和 Processed 不一样，还没见过"，`page = 2`，`index = 7` |
| Q19 | 第 4 笔两个日期改成 `02-Nov` | 失败"第 1 笔的日期比上一笔早"，`page = 2`，`index = 1` |
| Q20 | 第 10 笔两个日期改成 `01-Dec` | 失败"第 7 笔的日期不在账期里"，`page = 2`，`index = 7` |
| Q21 | 第 10 笔两个日期改成 `31-Nov` | 失败"第 7 笔的日期不对"，`page = 2`，`index = 7` |
| Q22 | 删掉第 1 页的 `2026` 那行 | 失败"找不到年份"，`page = 1`，`index = null` |
| Q23 | 第 1 页的 `2026` 改成 `2025` | 失败"年份行和账期对不上"，`page = null` |
| Q24 | 第 3 笔的 `NOTPROVIDED` 挪到第 2 页表头下面 | 失败"第 3 笔跨页了，还没见过跨页的交易"，`page = 1`，`index = 3` |
| Q25 | 第 4 笔的 `NA` 下面插一行 `EXTRA NOTE` | 失败"第 1 笔的描述超过 3 行，还没见过"，`page = 2`，`index = 1` |
| Q26 | 第 2 笔的 `NOTPROVIDED` 下面插一行 `NOTE  5.00` | 失败"第 2 笔下面有一行像金额，认不出来"，`page = 1`，`index = 2` |
| Q27 | 第 10 笔的 `Card 1234` 改成 `2027` | 失败"第 7 笔下面有一行像年份行，还没见过跨年时的样子"，`page = 2`，`index = 7` |
| Q28 | 删掉 `Account summary` 那行 | 失败"这不像 BOQ 对账单" |
| Q29 | `anz-statement/joint-2026-09.txt`、`anz-plus-statement/growth-2026-09.txt`、`cba-statement/female-2026-09.txt`、`westpac-statement/choice-2026-11.txt` 给 R1F | 都失败"这不像 BOQ 对账单" |
| Q30 | `everyday-2026-11.txt`、`saver-2026-11.txt` 给 R1C、R1D、R1E、R1G | 分别失败"找不到对账单标题，这不像 ANZ 对账单"、"这不像 ANZ Plus 对账单"、"这不像 CBA 对账单"、"这不像 Westpac 对账单" |
| Q31 | 自动选解析器：`everyday-2026-11.txt`、`saver-2026-11.txt`、`choice-2026-11.txt`、`joint-2026-09.txt`、`growth-2026-09.txt`、`female-2026-09.txt`、一份只有 `Hello` 一行的文字 | 分别是 R1F、R1F、R1G、R1C、R1D、R1E、失败"认不出这份对账单，只支持 ANZ、ANZ Plus、CBA、BOQ、Westpac 的 PDF 对账单" |

### 导入用例（连数据库，M9.5-9）

前提：建好上面两个 BOQ 账户。这里只看解析、去重、对账；`To: Future Saver` / `From: Everyday Account` 认成内部转账的见最后一节 TD。

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| QD1 | 空数据库 | 不选账户，导入 `everyday-2026-11.txt` | 认出 `BOQ Everyday Male`；新增 10，`source = pdf`，`date_from = 2026-11-01`，`date_to = 2026-11-30`，期初 0、期末 198750，`reconciled = true`；归属人都是 Male（账户默认，`Card 1234` 不进卡号映射）。第 3 笔的 `balance_cents = 0`；`import_batch`、`transaction` 里没有 `100000007`、`129999` |
| QD2 | QD1 | 再导入 `everyday-2026-11.txt` | 新增 0，跳过 10 |
| QD3 | QD1 | 导入主文件改成 Q4 那样（第 3 笔印了 `0.00`） | 新增 0，跳过 10（余额不印和印 0 的 key 一样） |
| QD4 | 空数据库 | 先导 `on-demand.txt`，再导 `everyday-2026-11.txt` | `on-demand.txt`：新增 9，`date_from = 2026-11-03`，`date_to = 2026-11-06`。`everyday-2026-11.txt`：R4.2 跳过 9（5 笔同日同额的 `occurrence` 两边都是 1 到 5），新增 1，`reconciled = true`；R12.2 不提示首尾衔接，提示"和 2026-11-03 到 2026-11-06 那份对账单的账期重叠了，重叠的交易已经跳过" |
| QD5 | QD1 | 导入 `empty-2026-12.txt` | 新增 0，建了批次，`date_from = 2026-12-01`，`reconciled = true`；R12.2 提示"和上一份对账单（2026-11-01 到 2026-11-30）接上了" |
| QD6 | 空数据库 | 不选账户，导入 `saver-2026-11.txt` | 认出 `BOQ Future Saver Male`（不是 Everyday）；新增 7 |
| QD7 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 整份失败"找不到尾号是 0002 的 BOQ 账户"（`ANZ Male` 尾号是 `0002` 也不算）；什么都没写 |
| QD8 | 再建一个 `boq` 账户，尾号 `00007` | 不选账户，导入 `everyday-2026-11.txt` | 整份失败"有 2 个 BOQ 账户的尾号都对得上"；什么都没写 |
| QD9 | 空数据库 | 不选账户，导入 `anz-statement/joint-2026-09.txt`、`anz-plus-statement/growth-2026-09.txt`、`cba-statement/female-2026-09.txt`、`westpac-statement/choice-2026-11.txt` | 照旧分别认出 `ANZ Joint`、`ANZ Plus Male`、`CBA Female`、`Westpac Choice Male`（五选一以后不受影响） |

## 同行内部转账（R6.1 按账户名认，M9.5-5）

### 识别用例（纯函数，M9.5-6）

输入：当前账户、一笔描述（解析器输出的样子）、本家庭账户（`bank`、`statement_name`、`number_suffix`、`is_archived`）。没特别说的，本家庭账户就是 fixtures 家庭加上面 4 个，`statement_name` 照上表；"改成"是测试里现改。期望里的"不认"是 R6.1 不出对方账户（走 R7）。

| 用例 | 当前账户 | 描述 | 账户改动 | 期望 |
| --- | --- | --- | --- | --- |
| T1 | Westpac Choice Male | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | | auto，对方 `Westpac Life Male`（截断） |
| T2 | Westpac Life Male | `Deposit Online 2000001 Tfr Westpac Cho` | | auto，对方 `Westpac Choice Male`（截断） |
| T3 | BOQ Everyday Male | `To: Future Saver NOTPROVIDED` | | auto，对方 `BOQ Future Saver Male`（后面带了 `NOTPROVIDED`） |
| T4 | BOQ Future Saver Male | `From: Everyday Account NOTPROVIDED` | | auto，对方 `BOQ Everyday Male`（拆成两行拼回来的名字） |
| T5 | Westpac Choice Male | `Withdrawal Mobile 1000002 Tfr Westpac Life` | | auto，对方 `Westpac Life Male`（没截断，一字不差也算） |
| T6 | BOQ Everyday Male | `To: Future Saver Holiday NOTPROVIDED` | | auto，对方 `BOQ Future Saver Male`（名字后面是备注） |
| T7 | Westpac Choice Male | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | Westpac Life Male 的 `statement_name` 改成 `westpac  LIFE` | auto（不分大小写，空白压成一个） |
| T8 | Westpac Choice Male | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | 加一个 westpac 账户 `statement_name = Westpac Life Bonus`，尾号 `0009` | 不认（对上 2 个） |
| T9 | BOQ Everyday Male | `To: Future Saver NOTPROVIDED` | 加一个 boq 账户 `statement_name = Future`，尾号 `0010` | 不认（`Future`、`Future Saver` 都对上） |
| T10 | BOQ Everyday Male | `To: Future Saver NOTPROVIDED` | BOQ Future Saver Male 的 `bank` 改成 `westpac` | 不认（同名的在别家银行） |
| T11 | BOQ Everyday Male | `To: Everyday Account NOTPROVIDED` | | 不认（对上的是自己） |
| T12 | BOQ Everyday Male | `To: Future Saver NOTPROVIDED` | BOQ Future Saver Male 的 `statement_name` 改成空 | 不认 |
| T13 | BOQ Everyday Male | `To: Future Saver NOTPROVIDED` | BOQ Future Saver Male 归档 | 不认 |
| T14 | BOQ Everyday Male | `To: Future Savers NOTPROVIDED` | | 不认（`Future Saver` 后面紧跟的不是空格） |
| T15 | BOQ Future Saver Male | `From: TEST FRIEND NA` | | 不认（外行转入，靠 R6.3） |
| T16 | Westpac Choice Male | `Deposit-Osko Payment 1000001 TEST FRIEND 31 Oct 2026` | | 不认（不是表里的开头） |
| T17 | ANZ Male | `To: Future Saver NOTPROVIDED` | | 不认（`anz` 不在按名字认的表里） |
| T18 | BOQ Everyday Male | `To: Future Saver TRANSFER FROM 400009999` | | 不认：R2.2 取到了 `400009999`，只按账号认，对不上就走 R7，不再按名字试（描述是编的） |
| T19 | ANZ Male | `TRANSFER TO 012345-400000004 #123456` | | auto，对方 `ANZ Plus Male`（原来按账号认的不受影响） |
| T20 | BOQ Everyday Male | `To: ` | | 不认（开头后面是空的） |

### 导入用例（连数据库，M9.5-9）

前提：建好上面 4 个账户，`statement_name` 照上表。"不计收支"指 auto 转账不进 R10 的收入、支出。

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| TD1 | 空数据库 | 导入 `everyday-2026-11.txt`，再导入 `saver-2026-11.txt` | Everyday 的 7 笔 `To: Future Saver` 和 Saver 的 7 笔 `From: Everyday Account` **都是** `transfer_status = auto`、内部转账、`category_source = system`，不计收支。R6.2：`11-03` 的 400、600 两对各配上；`11-06` 的 5 笔 100 每笔都有 5 个候选，**都不配对**（`transfer_pair_id` 为空），但还是 auto。`From: TEST FRIEND`、`From: ACME PTY LTD` 不是转账 |
| TD2 | 空数据库 | 先导入 `saver-2026-11.txt`，再导入 `everyday-2026-11.txt` | 和 TD1 一样（两边各自认，和先后无关） |
| TD3 | 空数据库 | 导入 `choice-2026-11.txt`，再导入 `life-2026-11.txt` | Choice 的 3 笔 `Tfr Westpac Lif`、Life 的 3 笔 `Tfr Westpac Cho` 都是 auto，不计收支。R6.2：`11-15` 的 1186.45 配上；`11-03` 的两笔 300 各有 2 个候选，都不配对。两笔 Osko 收款不是转账 |
| TD4 | 空数据库，BOQ Future Saver Male 的 `statement_name` 先空着 | 导入 `everyday-2026-11.txt`；然后编辑 BOQ Future Saver Male，填 `Future Saver` 保存 | 导入时 7 笔 `To: Future Saver` 不是转账（走 R7）。保存时 R6.4 弹窗 N = 7，确认后 7 笔都是 auto、内部转账，归属人 Male；Saver 还没有交易，都不配对 |
| TD5 | TD4 | 导入 `saver-2026-11.txt` | 7 笔 `From: Everyday Account` 是 auto；R6.2 配上 400、600 两对，5 笔 100 不配对 |
| TD6 | 空数据库，再建一个 boq 账户 `BOQ Test`，`statement_name = Future Saver`，尾号 `0011` | 导入 `everyday-2026-11.txt` | 7 笔 `To: Future Saver` 都不是转账（对上 2 个账户，走 R7） |
