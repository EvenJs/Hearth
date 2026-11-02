# CBA 对账单用例（R1E，M8.5）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

`cba-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1E 第一层的输出），不是 PDF，也不是真对账单。格式照 2026-11-02 看到的 3 份真实对账单的行结构（R1E）：第 1 行 `Your Statement`、每页的页眉（`Statement NN  Page X of Y)`，左括号读不出来）、账期行、交易表表头、`OPENING BALANCE` / `CLOSING BALANCE`（带年份）、交易 1 到 3 行（金额、余额在最后一行，余额带 ` CR`）、汇总两行、说明页；左边距的三种乱码（条码、`=` 块、`* *`）有的单独一行、有的粘在行首。分页用单独一行 `<<<PAGE>>>`（和 R1C、R1D 一样）。

户名、BSB `06 9999`、账号 `10000003`（测试家庭 `CBA Female` 的尾号 `0003`）、乱码、金额都是编的。20 笔交易和 `cba/female-2026-09.csv` 一样（期初 $10,000.00），只是按 R1E 的样子排：旧的在前、描述拆成几行、`Value Date` 没有冒号、BPAY 的账单码只剩第一位。

## 主文件 `female-2026-09.txt`

```
Your Statement
Statement 31  Page 1 of 3)
Account Number  06 9999 10000003
123
Statement
Female A Test  Period  1 Sep 2026 - 30 Sep 2026
Enquiries 13 0000
Closing Balance  11,561.59 CR
Everyday Account
Note text about your Everyday Account.
Date  Transaction  Debit  Credit  Balance
01 Sep 2026 OPENING BALANCE  10,000.00 CR
01 Sep Salary EXAMPLE SCHOOL
Wages 01092026  410.00  10,410.00 CR
02 Sep Loan Repayment
LN REPAY 123456789  1,480.00  8,930.00 CR
03 Sep seene CommBank app BPAY 9
=XÀâà9)1000999999  71.35  8,858.65 CR
05 Sep SQ *OVERLAY COFFEE Melbourne VI AUS
* *  Card xx5555
Value Date 03/09/2026  6.80  8,851.85 CR
0123.45678.9.0 ab123c4 0000 ab.c1.d234.e567.f g12.34.56
08 Sep Transfer To TEST FRIEND
PayID Phone from CommBank App
Eat Eat  45.00  8,806.85 CR
08 Sep Fast Transfer From OTHER FRIEND
to PayID Phone
dinner  22.50  8,829.35 CR
10 Sep LIGHTNING BROADBAND
Value Date 11/09/2026  75.00  8,754.35 CR
12 Sep ZLR*Tower Sushi & Gourm Melbourne AU  3.00  8,751.35 CR
<<<PAGE>>>
Statement 31  Page 2 of 3)
Account Number  06 9999 10000003
Date  Transaction  Debit  Credit  Balance
12 Sep ZLR*Tower Sushi & Gourm Melbourne AU  3.00  8,748.35 CR
15 Sep KIS HAIR Melbourne AU AUS
Card xx4444
Value Date 13/09/2026  22.80  8,725.55 CR
16 Sep Fast Transfer From TEST HOLDER
to PayID Phone
joint  500.00  9,225.55 CR
0123.45678.9.0 ab123c4 0000 ab.c1.d234.e567.f g12.34.5616 Sep Direct Debit 000793 BUPA AUSTRALIA
111122223333444000  298.40  8,927.15 CR
16 Sep CROWN ASIAN SPENCER Docklands VI AUS
Card xx5555
Value Date 14/09/2026  64.90  8,862.25 CR
19 Sep Direct Credit 002221 MCARE BENEFITS
123456789 ABCD  38.60  8,900.85 CR
20 Sep CBA Yello HLPckg Cshbk  4.00  8,904.85 CR
22 Sep DEFT PAYMENTS CommBank app BPAY 9
12345678901234567890 INV No 0012345  455.60  8,449.25 CR
24 Sep Transfer from xx7777
CommBank app Home  1,000.00  9,449.25 CR
25 Sep Fast Transfer From ACME TRADING PTY LTD
invoice 0925  3,000.00  12,449.25 CR
28 Sep TAX OFFICE PAYMENTS CommBank app BPAY 7
5512345678901234 Sept  900.00  11,549.25 CR
30 Sep Credit Interest  12.34  11,561.59 CR
30 Sep 2026 CLOSING BALANCE  11,561.59 CR
Opening balance  -  Total debits  Total credits  =  Closing balance
10,000.00 CR  3,425.85  4,987.44  11,561.59 CR
<<<PAGE>>>
Statement 31  Page 3 of 3)
Account Number  06 9999 10000003
Important Information
Please check this statement carefully.
=XÀâà9)
0123.45678.9.0 ab123c4 0000 ab.c1.d234.e567.f g12.34.56
```

几处故意的：

- 第 2 页的条码粘在 `16 Sep Direct Debit` 那一笔前面（`…g12.34.56` 后面直接是 `16 Sep`），第 1 页的 `=` 块粘在 BPAY 参考号前面，`* *` 粘在 `Card xx5555` 前面
- `24 Sep Transfer from xx7777`：真实对账单里**没见过**这种转账的写法（R1E，M8.5-4b），照 CSV 编的
- `30 Sep Credit Interest`：真实的 Everyday 对账单没有利息，CSV fixture 有，照搬
- 两笔 `12 Sep ZLR*Tower Sushi`：同一天同额同描述，测 `occurrence`（R1E 输出新的在前）
- 第 1 页 `Closing Balance` 那行、`123`、`Enquiries`、`Everyday Account`、说明文字都不用

解析结果：20 行，**新的在前**，`(date, amountCents, balanceCents)` 和顺序都和 R1B 解析 `cba/female-2026-09.csv` 一样；描述除了下面 3 笔也一样（`Value Date` 补了冒号，续行用一个空格拼）：

| date | PDF 的 description | CSV 的 description |
| --- | --- | --- |
| 2026-09-28 | `TAX OFFICE PAYMENTS CommBank app BPAY 7 5512345678901234 Sept` | `TAX OFFICE PAYMENTS CommBank app BPAY 75556 5512345678901234 Sept` |
| 2026-09-22 | `DEFT PAYMENTS CommBank app BPAY 9 12345678901234567890 INV No 0012345` | `DEFT PAYMENTS CommBank app BPAY 96503 12345678901234567890 INV No 0012345` |
| 2026-09-03 | `seene CommBank app BPAY 9 1000999999` | `seene CommBank app BPAY 959502 1000999999` |

账期 `2026-09-01` 到 `2026-09-30`，期初 1000000，期末 1156159，借合计 342585，贷合计 498744。

## 其他文件

都是在主文件上改一点：

| 文件 | 和主文件的区别 |
| --- | --- |
| `female-2026-10.txt` | `Statement 32`，`Page 1 of 2`、`Page 2 of 2`；账期 `1 Oct 2026 - 31 Oct 2026`；第 1 页 `Closing Balance  11,561.59 CR`；表头下面是 `01 Oct 2026 OPENING BALANCE  11,561.59 CR`，直接接 `31 Oct 2026 CLOSING BALANCE  11,561.59 CR`，汇总值 `11,561.59 CR  0.00  0.00  11,561.59 CR`，0 笔；说明页是第 2 页 |
| `year-rollover.txt` | `Statement 34`，`Page 1 of 2`、`Page 2 of 2`；账期 `16 Dec 2026 - 15 Jan 2027`；第 1 页 `Closing Balance  11,490.59 CR`；表里是 `16 Dec 2026 OPENING BALANCE  11,561.59 CR`、`20 Dec CBA Yello HLPckg Cshbk  4.00  11,565.59 CR`、`05 Jan LIGHTNING BROADBAND` / `Value Date 06/01/2027  75.00  11,490.59 CR`、`15 Jan 2027 CLOSING BALANCE  11,490.59 CR`，汇总值 `11,561.59 CR  75.00  4.00  11,490.59 CR`；说明页是第 2 页 |
| `broken-balance.txt` | 第 2 页 `KIS HAIR` 那一笔的余额改成 `8,625.55 CR` |
| `wrong-account.txt` | 3 页的账号都改成 `06 9999 10000002`（`ANZ Male` 的尾号） |
| `unknown-line.txt` | 第 1 页 `12 Sep ZLR*Tower Sushi … 8,751.35 CR` 下面插一行 `MELBOURNE AU`（假装描述换到了金额后面） |
| `split-across-pages.txt` | 第 1 页的 `<<<PAGE>>>` 和第 2 页的 3 行页眉挪到 `10 Sep LIGHTNING BROADBAND` 和 `Value Date 11/09/2026 …` 之间（第 1 页那笔 Sushi 跟着到第 2 页） |
| `garbage-unknown.txt` | 第 1 页的 `=XÀâà9)1000999999` 改成 `=XÀâ9)1000999999`（`=` 块少一个字符，形状不认识） |
| `overdraft.txt` | `OPENING BALANCE` 那行改成 `01 Sep 2026 OPENING BALANCE  10,000.00 DR` |
| `summary-mismatch.txt` | 汇总值的借合计改成 `3,425.86` |

## 解析用例（纯函数，M8.5-2）

失败的 `page`、`index` 照 R1E：`index` 是这一页从上往下数的第几笔，和交易无关的错误两个都是 `null`。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| C1 | `female-2026-09.txt`，尾号 `0003` | 20 行，和上面的解析结果一样（新的在前）；账期 `2026-09-01` 到 `2026-09-30`，期初 1000000，期末 1156159。三种乱码、页眉、第 1 页的 `Closing Balance`、说明文字都没进任何描述；`Value Date` 都带冒号 |
| C2 | 同上 | 最后一行（最旧的）是 `2026-09-01`、`41000`（账期第一天算这一份，闭区间）；两笔 Sushi 在输出里的顺序是余额 874835 在前、875135 在后（和 CSV 一样） |
| C3 | `female-2026-10.txt` | 0 行，成功；期初 = 期末 = 1156159 |
| C4 | `year-rollover.txt` | 2 行：`2027-01-05`、`-7500`、描述 `LIGHTNING BROADBAND Value Date: 06/01/2027`；`2026-12-20`、`400`。账期 `2026-12-16` 到 `2027-01-15` |
| C5 | `broken-balance.txt` | 失败"第 2 笔余额接不上"，`page = 2`，`index = 2` |
| C6 | `wrong-account.txt`，尾号 `0003` | 失败"这份对账单不是这个账户的"；信息里没有 `10000002`、`06 9999`、`069999`，最多有 `0002` |
| C7 | `female-2026-09.txt`，尾号 `null` | 失败，提示先去账户设置填尾号 |
| C8 | `unknown-line.txt` | 失败"交易表里第 8 笔下面有一行认不出来"，`page = 1`，`index = 8` |
| C9 | `split-across-pages.txt` | 失败"第 7 笔跨页了，还没见过跨页的交易"，`page = 1`，`index = 7` |
| C10 | `garbage-unknown.txt` | 失败"第 3 笔里有一行像乱码，认不出来"，`page = 1`，`index = 3` |
| C11 | `overdraft.txt` | 失败"没见过透支的对账单"，`page = 1`，`index = null` |
| C12 | `summary-mismatch.txt` | 失败，信息里有逐笔借合计 $3,425.85 和 Total debits $3,425.86，`page = null` |
| C13 | 主文件账期行改成 `1 Sep 2026 - 29 Sep 2026`（测试里现改） | 失败"账期和 OPENING / CLOSING BALANCE 的日期对不上"，`page = null` |
| C14 | 主文件账期行改成 `1 Sep 2026 - 30 Sep 2027`，`CLOSING BALANCE` 那行的日期改成 `30 Sep 2027`（测试里现改） | 失败"账期超过 12 个月，还没见过这么长的 CBA 对账单"，`page = null` |
| C15 | 主文件 `20 Sep CBA Yello HLPckg Cshbk` 改成 `20 Sep 1000 CBA Yello HLPckg Cshbk`（测试里现改） | 20 行，成功；那一笔是 `2026-09-20`，描述 `1000 CBA Yello HLPckg Cshbk`（`1000` 不是年份） |
| C16 | 主文件 `03 Sep seene` 改成 `01 Sep seene`（测试里现改） | 失败"第 3 笔的日期比上一笔早"，`page = 1`，`index = 3` |
| C17 | 主文件 `30 Sep Credit Interest` 改成 `30 Aug Credit Interest`（测试里现改） | 失败"第 12 笔的日期不在账期里"，`page = 2`，`index = 12`（Aug 比 Sep 小，按规则进了一年） |
| C18 | 主文件删掉汇总那两行（测试里现改） | 失败"找不到汇总" |
| C19 | 主文件删掉第 1 行 `Your Statement`（测试里现改） | 失败"这不像 CBA 对账单" |
| C20 | `fixtures/anz-statement/joint-2026-09.txt`、`fixtures/anz-plus-statement/growth-2026-09.txt` 给 R1E | 都失败"这不像 CBA 对账单" |
| C21 | `female-2026-09.txt` 给 R1C（`parseAnzStatement`）、R1D（`parseAnzPlusStatement`） | 分别失败"找不到对账单标题"、"这不像 ANZ Plus 对账单" |
| C22 | 自动选解析器：`female-2026-09.txt`、`joint-2026-09.txt`、`growth-2026-09.txt`、一份只有 `Hello` 一行的文字 | 分别是 R1E、R1C、R1D、失败"认不出这份对账单，只支持 ANZ、ANZ Plus、CBA 的 PDF 对账单" |

## 导入用例（连数据库，M8.5-5）

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| D1 | 空数据库 | 不选账户，导入 `female-2026-09.txt` | 认出 `CBA Female`；新增 20，`source = pdf`，`date_from = 2026-09-01`，`date_to = 2026-09-30`，期初 1000000、期末 1156159，`reconciled = true`。merchant 和 `04-cba-female-2026-09.md` 那张表一样（3 笔 BPAY 也一样，`Value Date` 都去掉了）；`Transfer from xx7777` 照 R6.1 认成内部转账（`CBA Female Saver`），auto。`import_batch`、`transaction` 里没有 8 位以上连续数字 |
| D2 | D1 | 再导入 `female-2026-09.txt` | 新增 0，跳过 20 |
| D3 | D1 | 导入 `female-2026-10.txt` | 新增 0，建了批次，`date_from = 2026-10-01`，`reconciled = true`；R12.2 提示"和上一份对账单接上了" |
| D4 | D1 | 导入 `year-rollover.txt` | 新增 2，`reconciled = true`；R12.2 提示"接上了"（期初 = 上一份期末；中间 10 月到 12 月中没有对账单，R12.2 只比余额，不拦） |
| D5 | 空数据库，先导 `cba/female-2026-09.csv` 到 `CBA Female` | 导入 `female-2026-09.txt` | **按 R4.1 现在的 key**：跳过 17（两笔 Sushi 都跳过），新增 3（3 笔 BPAY，**和 CSV 重复了**）；PDF 批次 `reconciled = false`，差 −$1,426.95；R12.2 不提示（没有上一份 PDF 批次，CSV 批次不算）。这 3 笔由 M8.5-4a 处理，M8.5-4a 定了规则以后改这一条的期望 |
| D6 | 空数据库 | 顺序反过来：先导 `female-2026-09.txt`，再导 `cba/female-2026-09.csv` | CSV 批次跳过 17，新增 3（同 D5，M8.5-4a 以后改） |
| D7 | D5 | 撤销 PDF 批次（R12.1） | 只删 PDF 批次新增的 3 笔 BPAY；CSV 批次的 20 笔都还在，没被改 |
| D8 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 整份失败"找不到尾号是 0002 的 CBA 账户"（`ANZ Male` 尾号是 `0002` 也不算）；什么都没写 |
| D9 | 把 `CBA Female` 归档 | 不选账户，导入 `female-2026-09.txt` | 整份失败"找不到尾号是 0003 的 CBA 账户"；什么都没写 |
| D10 | 再建一个 `cba` 账户，尾号 `00003` | 不选账户，导入 `female-2026-09.txt` | 整份失败"有 2 个 CBA 账户的尾号都对得上"；什么都没写 |
| D11 | 空数据库 | 不选账户，导入 `anz-statement/joint-2026-09.txt`、`anz-plus-statement/growth-2026-09.txt` | 照旧分别认出 `ANZ Joint`、`ANZ Plus Male`（三选一以后 R1C、R1D 不受影响） |
