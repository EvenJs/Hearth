# R1. 解析（CSV 和 PDF 对账单）

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

**输入**：CSV 文件文本（R1A、R1B），或 ANZ / ANZ Plus / CBA 对账单读出来的文字行（R1C、R1D、R1E）+ 账户的银行
**输出**：`ParsedRow[]`，每行 `{ date: 'YYYY-MM-DD', amountCents: number, description: string, balanceCents: number | null, rowIndex: number }`

按 `financial_account.bank` 选解析器：

| bank                  | 解析器 | 说明                               |
| --------------------- | ------ | ---------------------------------- |
| anz                   | R1A    | CSV。PDF 对账单用 R1C（2026-10-28） |
| cba                   | R1B    | CSV。PDF 对账单用 R1E（2026-11-02），以后主要导 PDF |
| anz_plus              | R1D    | 不能导入 CSV，只能导 PDF 对账单（R1D，2026-10-30） |
| cash、other           | 无     | 不能导入，只能手动录入（R8.1）     |

## R1.0 两个解析器共用的规则

> R1A、R1B 两个 CSV 解析器都用。R1C 对账单只用第 4（金额）、6（出错整份失败）、7（按文件顺序输出）条。R1D 只用第 4、5、6 条，输出顺序见 R1D。R1E 只用第 4、6 条，描述和输出顺序见 R1E。

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

## R1A ANZ

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

## R1C ANZ PDF 对账单（2026-10-28 新增，M6.6）

ANZ 账户除了 CSV，还能导入 PDF 对账单。对账单的账期是固定的、首尾相接，每行都有余额，所以用来**补漏和自动对账**：平时照样导 CSV（及时），对账单出来后把 PDF 导进同一个账户，CSV 已有的被 R4 跳过，漏掉的补上，期初期末自动填进 R9。

2026-10-28 用一份真实的 Access Advantage 半年对账单（50 笔）和同账期的 CSV 对过：日期、金额、描述（多行拼起来）**全部一致**，余额逐行连续，最后等于汇总页的期末余额。所以同一个账户 CSV 和 PDF 可以混着导，不会重复。

2026-10-29 换成 `unpdf` 读，又试了 Joint、Progress Saver 各一份：格式有 5 处和最初写的不一样（汇总、账号、`OPENING BALANCE`、换年少一个 `blank`、合计行前面的 `blank`），下面已经改过来。改完以后三份都解析成功、三项检查通过，Access Advantage 50 笔还是和 CSV 全部一致。

2026-10-29 更正：上面那次其实没测到 Progress Saver。真实的 Progress Saver 对账单标题是 `PROGRESS SAVER ACCOUNT STATEMENT`，**标题行里没有 `ANZ`**，按原来的标题规则直接失败"找不到对账单标题"。标题规则已经改成下面的样子；只改标题后，一份真实的 Progress Saver 半年对账单（32 笔）三项检查都通过。

**两层**：

1. 读文字（`src/server/pdf/`，用 `unpdf`）：把每一页的文字按坐标拼成行，同一行里隔得远的两段之间放两个空格，返回 `{ page, text }[]`。读不出文字（扫描件）→ 报错"读不出文字"
2. 解析（`src/lib/import/anz-statement.ts`，纯函数）：输入上面的行，输出和 R1 一样的 `ParsedRow[]`，外加账期、期初期末、账号尾号。测试只用 `fixtures/anz-statement/` 里编的文字，不用 PDF

**表头**（找不到任何一项 → 整份失败）：

- 标题：有一行**整行**是大写单词加空格、以 ` STATEMENT` 结尾，如 `ANZ ACCESS ADVANTAGE STATEMENT`、`PROGRESS SAVER ACCOUNT STATEMENT`（2026-10-29 改：Progress Saver 的标题没有 `ANZ`）。`STATEMENT NUMBER 17`、`... ON THIS STATEMENT.` 不算标题
- 而且全文有一行含单独的词 `ANZ`（大小写不限，如 `Welcome to your ANZ account at a glance`、页脚的 `Australia and New Zealand Banking Group Limited (ANZ)`）
- 两条缺一条 → 整份失败"找不到对账单标题，这不像 ANZ 对账单"
- 账期：`DD MONTH YYYY TO DD MONTH YYYY`（如 `04 MARCH 2026 TO 04 SEPTEMBER 2026`）→ `periodFrom`、`periodTo`
- **账期是 `(periodFrom, periodTo]`**（2026-10-28 定）：`OPENING BALANCE` 那行的日期是 `periodFrom`，是那天结束时的余额，`periodFrom` 当天的交易在上一份对账单里。上一份的 `periodTo` = 这一份的 `periodFrom`
- 账号：`Account Number` 后面的 `dddd-ddddd`，可能在同一行，也可能在后面 3 行里（汇总页左右两栏拼在一起，号码常常在下面几行）。去掉 `-` 后要以账户的 `number_suffix` 结尾，不然整份失败"这份对账单不是这个账户的"。账户没填尾号也失败，提示先去账户设置填。**账号不存、不进日志，错误信息里最多带后 4 位**
- **自动认账户**（2026-10-29 加，M6.6-6b）：导入对账单不用先选账户。用账号去找本家庭**没归档的 ANZ 账户**里 `number_suffix` 和账号尾部对得上的：
  - 正好一个 → 导入这个账户，之后照上一条核对
  - 一个都没有 → 整份失败"找不到尾号是 dddd 的 ANZ 账户，先去账户设置填上尾号"（dddd 是账号后 4 位）
  - 两个以上（尾号填得太短）→ 整份失败"有 n 个 ANZ 账户的尾号都对得上，去账户设置把尾号填长一点"
  - 找不到账号 → 整份失败"找不到账号"
  - CSV 里没有账号，还是要选账户
- 汇总：`Opening Balance`、`Closing Balance`、`Total Deposits`、`Total Withdrawals`。标签后面可能带冒号，也不一定在行首（左栏的姓名、BSB 会拼在同一行前面）。金额取标签之后、同一行或后面 4 行里的**第一个金额**（`$` 常常单独一行，中间可能隔着左栏的文字）。取错了会被下面的三项检查拦下

**交易行**：

- 以 `DD MON`（如 `05 MAR`）开头，最后三段依次是支出、存入、余额。支出和存入**恰好一个是金额、另一个是 `blank`**，余额是金额
- 栏位的位置每页不一样，**不按列宽切**，按"最后三段"认
- 例外：换年时，只有年份的那行会占掉下一笔的一个 `blank`（PDF 里 `blank` 印在交易行上方，读文字时和年份拼成一行），这一笔末尾只剩**金额、余额两段**（倒数第三段不是金额也不是 `blank`）。这时用上一笔的余额（第一笔用期初）判断方向：上一笔余额 − 金额 = 这一行的余额 → 支出；上一笔余额 + 金额 = 这一行的余额 → 存入；都不是 → 整份失败
- 金额：去掉千分位逗号，按 R1.0-4 转成分。支出是负数，存入是正数
- 描述：交易行里日期之后、金额之前的部分，加上后面的续行，用一个空格拼起来，去首尾空白。和 CSV 的描述一致（R4 的 `normalizedDescription` 会合并空白，空格多少不影响去重）
- 续行：下一行既不是交易行，也不是下面要跳过的行，就是描述的续行
- `OPENING BALANCE` 那行不是交易，**最后一段**是余额，要等于汇总页的期初。真实对账单里这行是 `DD MON  OPENING BALANCE  余额`，它的 `blank  blank` 跑到了上面年份那行
- `balanceCents`：解析出来给检查用，**不写进 key、不存库**（R4.1：ANZ 的 key 不放余额，不然和 CSV 对不上）

**跳过的行**：`EFFECTIVE DATE ...`（实际消费日期，不拼进描述）、`TOTALS AT END OF PAGE`、`TOTALS AT END OF PERIOD`（前面可能多一个 `blank`；PERIOD 那行最后还有期末余额）、页眉页脚（`Page n of m`、对账单标题、`Account Number`、`Transaction Details`、栏位标题 `Date  Transaction Details ...`）、只有年份和 `blank` 的那行（`blank` 可能是一个或两个）。汇总页、对账单最后的说明页没有交易行，不影响

**年份**：交易行只有日和月。

- 按出现顺序（旧的在前），起始年份 = `periodFrom` 的年份；月份比上一笔小（如 DEC → JAN）就加一年
- 遇到只有年份的那行（`2026  blank  blank`），以它为准
- 算出来的日期不在 `(periodFrom, periodTo]` 里 → 整份失败
- 正好等于 `periodFrom` 时，错误信息单独写"账期第一天有交易，R1C 对账期的假设不对"，要回来改规则（这个假设是从 `OPENING BALANCE` 的日期推的，还没见过首日有交易的对账单）

**检查**（任何一条不过 → 整份失败，什么都不导，错误带第几笔和页码）：

- 期初 + 逐笔金额 = 每一行的余额（读错了一行就会在这里断开）
- 最后的余额 = 汇总页的期末
- 支出合计、存入合计 = 汇总页的 Total Withdrawals、Total Deposits

和 CBA 不一样：CBA 的余额不连续只警告（R1B.1），对账单是银行给的正本，对不上多半是解析读错了，所以拒绝。

**输出顺序**：和文件一致（旧的在前，和 CSV 相反）。R4.1 的 `occurrence` 只对完全相同的行计数，顺序不影响结果。

**一笔都没有**（这个月没有交易）：照样能导入，只建 `import_batch` 做对账和首尾衔接（R12.2）。

**R9 的日期范围**：`import_batch.date_from` 存 `periodFrom` 的第二天，`date_to` 存 `periodTo`，R9 照旧按 `[date_from, date_to]` 算，正好是 `(periodFrom, periodTo]`。

## R1C.1 例子

`fixtures/anz-statement/joint-2026-09.txt`（编的，和 `anz/joint-2026-09.csv` 同样的 19 笔）：

- 解析出 19 行，`(date, amountCents, description)` 和 R1A 解析 `joint-2026-09.csv` 的结果一样（不管顺序）
- 先导入 CSV 再导入这份 PDF：新增 0，跳过 19，`reconciled = true`
- 只导入 PDF：结果和只导入 CSV 一样（fixtures/README 那张 19 行的表）

更多用例见 fixtures/README 的"ANZ 对账单用例"。

## R1D ANZ Plus PDF 对账单（2026-10-30 新增，M7.5）

ANZ Plus 不能导出 CSV，只能导出 PDF 对账单。导入后利息不用再手动记，余额能对上，和 ANZ 账户之间的转账两边都有记录（R6.2）。

2026-10-30 用 `tests/local/` 里 4 份真实对账单看过（`unpdf` 读出来遮掉数字字母看行结构）：Growth Saver 2026-07、08、09 三份连续的，Everyday 2026-08 一份。下面每条后面的【】写的是从哪几份看到的，【没见过】的情况碰到就整份失败，回来改规则。4 份都只有 1 页、2 到 4 笔交易，没有跨页、跨年、0 笔的。

**两层**：和 R1C 一样。第一层复用 `src/server/pdf/text.ts`；第二层是 `src/lib/import/anz-plus-statement.ts`（纯函数），不改 R1C 的 `anz-statement.ts`。测试只用 `fixtures/anz-plus-statement/` 里编的文字

**认格式**（两条缺一条 → 整份失败"这不像 ANZ Plus 对账单"）：

- 有一行**整行**是 `Account Statement`【4 份都是第 1 行】
- 而且交易表表头（见下）之前有一行以 `ANZ Plus ` 开头，是产品名，如 `ANZ Plus Growth Saver`、`ANZ Plus Everyday`【4 份都是第 6 行】
- 左上角的 ANZ Plus 是图片，读不出文字，不用它。页脚说明文字里也有 `ANZ Plus`，但在表头之后，不算
- 和 R1C 不会互相认错：R1C 的标题要整行大写、以 ` STATEMENT` 结尾，`Account Statement` 不算【4 份 ANZ Plus 喂给 R1C 都失败"找不到对账单标题"】；`tests/local/` 里另外 7 份 PDF（R1C 的 ANZ 对账单等）第一页都没有 `ANZ Plus`
- 上传对账单时先按这两条判断用不用 R1D。三种对账单怎么选见 R1E 的"认格式"

**账期**：

- 有一行以 `D Month YYYY - D Month YYYY` 开头（日不补 0，月份是英文全称），如 `1 September 2026 - 30 September 2026`，后面同一行还有户名（不用）【4 份都是第 2 行】→ `periodFrom`、`periodTo`。找不到 → 整份失败"找不到账期"
- **账期是闭区间 `[periodFrom, periodTo]`，和 R1C 不一样**（2026-10-30 定）：看到的都是 `1 July - 31 July`、`1 August - 31 August`、`1 September - 30 September`，上一份的期末 = 下一份的期初，中间不空一天【Growth Saver 07→08→09】。所以 `Opening Balance` 是 `periodFrom` 当天开始前的余额，1 号的交易算这一份。4 份里没有 1 号的交易（最早是 02 号），这条是从首尾相接推出来的
- `periodFrom` 和 `periodTo` 年份不一样 → 整份失败"账期跨年了，还没见过跨年的 ANZ Plus 对账单"【没见过】。`periodFrom` 晚于 `periodTo` → 整份失败"账期不对"

**汇总**【4 份都一样】：

- 有一行以 `Account Number  Opening Balance  Closing Balance` 结尾（前面是 BSB 的标签），**下一行**是 4 段（两个以上空格隔开）：BSB（`ddd ddd`）、账号（数字和单个空格，见过的是 `ddd ddd ddd`）、期初、期末。不是这个样子 → 整份失败"找不到期初期末"
- 金额都是 `$1,234.56` 这样：去掉 `$` 和千分位逗号，按 R1.0-4 转成分（余额可以是 0）。带负号或括号的【没见过】→ 整份失败
- `Interest Earned`：有一行以 `Interest Earned` 开头（后面同一行是 `Account Name`），下一行第一段是 `+ $25.00` 这样 → `interestEarnedCents`【Growth Saver 3 份都有】。**没有这一行就当 0**【Everyday 那份没有】
- 没有 Total Deposits、Total Withdrawals（和 R1C 不一样）

**账号核对、自动认账户**：照 R1C，只是范围换成 ANZ Plus：

- 账号去掉空格后要以账户的 `number_suffix` 结尾，不然整份失败"这份对账单不是这个账户的"。账户没填尾号也失败。**BSB、账号不存、不进日志，错误信息里最多带后 4 位**
- 不选账户时，只在本家庭**没归档的 `anz_plus` 账户**里按尾号找，**不和 ANZ 账户混着找**：
  - 正好一个 → 导入这个账户
  - 一个都没有 → 整份失败"找不到尾号是 dddd 的 ANZ Plus 账户，先去账户设置填上尾号"（ANZ、CBA 账户尾号对得上也不算）
  - 两个以上 → 整份失败"有 n 个 ANZ Plus 账户的尾号都对得上，去账户设置把尾号填长一点"

**交易表**：

- 表头：整行是 `Date  Description  Credit  Debit  Balance`【4 份都一样，上一行是 `Transactions`】。**存入在前、支出在后**，和 R1C 相反，但下面不按栏位认，不影响。找不到 → 整份失败"找不到交易表"
- 表底：表头之后第一行以 `Opening Balance` 开头、没有日期的，最后一段是期初，要等于汇总的期初【4 份都是】。找不到 → 整份失败"找不到交易表的 Opening Balance"
- 表头和表底中间是交易行和 `Effective Date` 行，表底之后是说明文字和页码（`Page 1 of 1`），都不看
- **表头到表底必须在同一页**。跨页 → 整份失败"交易表跨页了，还没见过跨页的 ANZ Plus 对账单"【没见过】。表在第 1 页、后面还有只放说明的页，不影响
- 顺序：**新的在前**，表底的 `Opening Balance` 是最旧的【4 份都是，从下往上逐行余额都接得上，反过来接不上】

**交易行**【4 份，共 12 笔】：

- 以 `DD Mon`（日补 0，月份三个字母首字母大写，如 `02 Sep`、`31 Jul`）开头，**最后两段**是金额、余额。没有用的那一栏是真的空，不印 `blank`（和 R1C 不一样），所以每行正好两个金额
- 最后两段不都是金额 → 整份失败"第 n 笔认不出金额和余额"
- **方向用余额判断**（从表底往上，第一笔用期初）：上一笔余额 + 金额 = 这一行余额 → 存入（正数）；上一笔余额 − 金额 = 这一行余额 → 支出（负数）；都不是 → 整份失败"第 n 笔余额接不上"（这就是 R1C 的"期初 + 逐笔 = 每行余额"检查）。金额是 0 时两个方向分不开，R1.0-4 本来就报错
- 描述：日期之后、金额之前的部分，去首尾空白，中间原样（R1.0-5）。末尾可能有 `\` 这样的字符，原样保留【Everyday 那份的刷卡消费】。描述里的 `TRANSFER FROM 012345-400000002 #100001` 由 R2.3 脱敏成 `012345-****0002`【4 份 5 行，脱敏后没有 8 位以上数字】
- `Effective Date dd/mm/yyyy`：跟在交易行下面，跳过，不拼进描述【Everyday 的刷卡、Growth Saver 09 的一笔转入】
- **续行**：表里其他认不出来的行（不是交易行、不是 `Effective Date`）→ 整份失败"交易表里第 n 笔下面有一行认不出来"（n 是它上面那笔；紧挨着表头时写"表头下面"）【没见过描述换行。Everyday 的长描述是在末尾截断的，不像会换行】
- 利息：描述含 `CREDIT INTEREST` 的行，见过 `BONUS CREDIT INTEREST PAID`、`CREDIT INTEREST PAID` 两笔，同一天（月底）【Growth Saver 3 份】
- `balanceCents`：要写进 R4.1 的 key（ANZ Plus 没有 CSV 要对齐，和 R1C 不一样）

**年份**：交易行只有日和月，年份 = 账期的年份（账期跨年已经在上面拦了）。算出来的日期不在 `[periodFrom, periodTo]` 里 → 整份失败"第 n 笔的日期不在账期里"

**检查**（任何一条不过 → 整份失败，什么都不导，错误带第几笔和页码；第几笔是**这一页从上往下数**，和 PDF 上看到的一致）：

- 期初 + 逐笔 = 每一行的余额（上面判断方向时已经做了）
- 表底的 `Opening Balance` = 汇总的期初
- 表里第一行（最新的）的余额 = 汇总的期末；一笔都没有时，期初 = 期末
- 利息行的金额合计 = `Interest Earned`（没有这一项时合计要是 0）【Growth Saver 3 份都对得上】

**输出顺序**：**旧的在前**（把表里的顺序反过来），和 R1C 一样，和 R1.0-7 不一样。`occurrence` 按输出顺序数。

**一笔都没有**【没见过】：表头和表底都在、中间没有交易行 → 照 R1C 能导入，只建 `import_batch` 做对账和首尾衔接（R12.2）。要是空的对账单根本没有表头（比如印一句 "No transactions"），会失败"找不到交易表"，碰到再改。

**R9 的日期范围**：`import_batch.date_from` 存 `periodFrom`（**不加一天**，和 R1C 不一样），`date_to` 存 `periodTo`。R12.2 的首尾衔接照旧只比余额。

## R1D.1 例子

`fixtures/anz-plus-statement/growth-2026-09.txt`（编的，导入到测试家庭的 `ANZ Plus Male`，尾号 `0004`；这里省略了地址和页脚，完整的见 fixtures 用例）：

```
Account Statement
1 September 2026 - 30 September 2026  Male Test
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
```

解析出 4 行，旧的在前：

| date | amountCents | description | balanceCents |
| --- | --- | --- | --- |
| 2026-09-02 | 100000 | `TRANSFER FROM 012345-400000002 #100001` | 1100000 |
| 2026-09-15 | -30000 | `TRANSFER TO 012345-400000002 #100002` | 1070000 |
| 2026-09-30 | 500 | `CREDIT INTEREST PAID` | 1070500 |
| 2026-09-30 | 2000 | `BONUS CREDIT INTEREST PAID` | 1072500 |

账期 `2026-09-01` 到 `2026-09-30`，期初 1000000，期末 1072500，利息 2500，账号尾号 `0004`。更多用例见 fixtures/README 的"ANZ Plus 对账单用例"。

## R1E CBA PDF 对账单（2026-11-02 新增，M8.5）

CBA 以后主要导 PDF 对账单，CSV 照旧能导，但不是主路（2026-11-02 定）。对账单每行都有余额，期初期末自动进 R9，上一份和下一份首尾衔接（R12.2）。CBA CSV 是从 2026-01-01 开始导的，2025-09 到 2025-12 靠对账单补；2026-01 以后和 CSV 重叠，混导见下面"和 CSV 混导"。

2026-11-02 用 `tests/local/` 里同一个 Everyday 账户连续 3 份季度对账单看过（`unpdf` 读出来遮掉数字字母看行结构，脚本 `tests/local/cba-shape.test.ts`）：Statement 22（2025-11-02 到 2026-02-01，4 页，48 笔，跨年）、23（2026-02-02 到 05-01，5 页，72 笔）、24（2026-05-02 到 08-01，5 页，76 笔），记作【22】【23】【24】。下面每条后面的【】写的是从哪几份看到的，【没见过】的情况碰到就整份失败，回来改规则。3 份都是季度的；以后改成每月一份，第一份月度出来后再确认一次格式（M8.5-0），R1E 不假设账期多长。

**两层**：和 R1D 一样。第一层复用 `src/server/pdf/text.ts`，**不改**；第二层是 `src/lib/import/cba-statement.ts`（纯函数），不改 R1B 的 `cba.ts`、R1C、R1D 的解析器。测试只用 `fixtures/cba-statement/` 里编的文字

**左边距的乱码**（2026-11-02 定：在第二层去掉，不改第一层）：

页面最左边（`x ≤ 20`，正文的日期栏从 `x = 57` 开始）印着三种不是文字的东西，`unpdf` 拼行时会粘到同一高度那一行的**行首**（紧挨着时连空格都没有）【22】【23】【24】：

| 乱码 | 形状 | 在哪 |
| --- | --- | --- |
| 条码 | 5 段，空格隔开：`dddd.ddddd.d.d`（也见过 `ddd.dddd.d.d`）、`aadddad`、`dddd`、`aa.ad.addd.addd.a`、`add.dd.dd`（`d` 是数字，`a` 是字母）。最后一段后面可能直接粘着下一笔的日期，如 `…a12.34.5616 Sep` | 每页一个 |
| `=` 块 | 7 个字符：`=`、5 个字符（有非 ASCII 字母，每份不一样）、`)`。后面可能直接粘着数字 | 单数页一个 |
| `* *` | 就这 3 个字符 | 第 1 页一个 |

- **每一行**（不只是交易表）先去掉行首的这三种（可能叠在一起，按条码、`=` 块、`* *` 的顺序各去一次），再去首尾空白。去完是空行就跳过
- 有的单独一行，有的粘在交易行前面（不去掉的话这一笔认不出来）、续行前面（不去掉的话进描述）、汇总标签行前面【23】
- 去完以后，任何一行里还有像乱码的（`数字.数字.数字.数字`，或 `=` 后面 5 个字符以内有非 ASCII 字符）→ 整份失败"第 n 笔里有一行像乱码，认不出来"（在表外写"对账单里有一行像乱码"）。形状变了的乱码不会悄悄混进描述【没见过】

**读不出来的字符**：`(` 和汇总那行的 `+` 在 PDF 的文字层里就没有（PDF.js 直接读也没有，不是拼行的问题）。页眉读出来是 `Statement 22  Page 1 of 4)`（没有左括号）；描述里的 `(` 也会丢【重叠段 2 笔】。BPAY 的账单码只读得出第一位，见"和 CSV 混导"【重叠段 8 笔都是】

**认格式**（三条缺一条 → 整份失败"这不像 CBA 对账单"）：

- 有一行**整行**是 `Your Statement`【3 份都是第 1 页第 1 行，后面几页没有】
- 有交易表表头（见下），而且表头之前有一行以 `Account Number ` 开头【3 份】
- 有 `OPENING BALANCE` 那行（见下）【3 份】
- 和 R1C、R1D 不会互相认错：R1C 的标题要整行大写、以 ` STATEMENT` 结尾；R1D 要整行 `Account Statement` 加 `ANZ Plus ` 开头的产品行。3 份 CBA 喂给 R1C 失败"找不到对账单标题"、喂给 R1D 失败"这不像 ANZ Plus 对账单"；`tests/local/` 里另外 11 份 PDF（ANZ、ANZ Plus 对账单和别的）这三条一条都不满足
- **上传对账单时三选一**（取代原来的"不是 ANZ Plus 就是 ANZ"）：满足 R1D 的两条 → R1D；满足上面三条 → R1E；满足 R1C 的标题两条 → R1C；都不满足 → 整份失败"认不出这份对账单，只支持 ANZ、ANZ Plus、CBA 的 PDF 对账单"

**页眉**（每页都有，跳过）【3 份每一页】：

- `Statement NN  Page X of Y)`：`NN` 是对账单编号（3 份是 22、23、24，连着），**不用**（2026-11-02 定：R12.2 只比余额，不用编号判断少没少一份）
- `Account Number  dd dddd dddddddd`：BSB（2 位 + 4 位）和账号（8 位），每页都一样
- 有交易的页还有交易表表头。`Important Information` 说明在汇总之后，可能另起一页【22、23】，也可能和表尾在同一页【24】，不看

**账期**：

- 第 1 页有一行以 `D Mon YYYY - D Mon YYYY` **结尾**（日不补 0，月份三个字母首字母大写），如 `2 Nov 2025 - 1 Feb 2026`，前面是户名等（不用）【3 份都是第 1 页第 6 行】→ `periodFrom`、`periodTo`。找不到 → 整份失败"找不到账期"
- **闭区间 `[periodFrom, periodTo]`，和 R1D 一样**：上一份止于 1 号，下一份从 2 号开始，中间不空一天【22→23→24】。`OPENING BALANCE` 是 `periodFrom` 当天开始前的余额。3 份里没有账期第一天的交易，这条是从首尾相接推出来的
- `OPENING BALANCE` 那行的日期要等于 `periodFrom`，`CLOSING BALANCE` 那行的日期要等于 `periodTo`【3 份都相等】，不然整份失败"账期和 OPENING / CLOSING BALANCE 的日期对不上"
- **会跨年**【22 是 Nov → Feb】，一开始就支持。`periodFrom` 晚于 `periodTo` → 整份失败"账期不对"；`periodTo` 不早于 `periodFrom` 加 12 个月 → 整份失败"账期超过 12 个月，还没见过这么长的 CBA 对账单"【没见过】
- 季度和月度混着导：账期长短不比，R12.2 只比余额。改月度时最后一份季度和第一份月度之间有空档或重叠，R12.2 的提示就够，不拦

**账号核对、自动认账户**：照 R1D，只是范围换成 CBA：

- 用表头之前第一个 `Account Number` 行，去掉空格后是 14 位数字（BSB 6 位 + 账号 8 位）【3 份】。要以账户的 `number_suffix` 结尾，不然整份失败"这份对账单不是这个账户的"。账户没填尾号也失败。找不到 → 整份失败"找不到账号"。**BSB、账号不存、不进日志，错误信息里最多带后 4 位**
- 不选账户时，只在本家庭**没归档的 `cba` 账户**里按尾号找，不和 ANZ、ANZ Plus 账户混着找：
  - 正好一个 → 导入这个账户
  - 一个都没有 → 整份失败"找不到尾号是 dddd 的 CBA 账户，先去账户设置填上尾号"（ANZ、ANZ Plus 账户尾号对得上也不算）
  - 两个以上 → 整份失败"有 n 个 CBA 账户的尾号都对得上，去账户设置把尾号填长一点"

**交易表**：

- 表头：整行是 `Date  Transaction  Debit  Credit  Balance`【3 份每一页有交易的页】。**借在前、贷在后**，但下面不按栏位认。一个都没有 → 整份失败"找不到交易表"
- 表的开头：第 1 页表头下面紧挨着 `DD Mon YYYY OPENING BALANCE  余额 CR`（**带年份**），最后一段是期初【3 份】。找不到 → 整份失败"找不到 OPENING BALANCE"
- 表的结尾：`DD Mon YYYY CLOSING BALANCE  余额 CR`（带年份），最后一段是期末【3 份，在最后一页交易表的末尾】。找不到 → 整份失败"找不到 CLOSING BALANCE"
- 中间是交易、续行、换页的页眉（跳过）和乱码（先去掉）。**换页**：表跨好几页，每页顶上重复页眉和表头，接着就是下一笔【22 跨 3 页，23 跨 4 页，24 跨 5 页】
- 顺序：**旧的在前**，和 CBA CSV 相反【3 份，从 `OPENING BALANCE` 往下逐笔余额都接得上】

**交易**【3 份，共 196 笔】：

- 第一行以 `DD Mon`（日补 0，月份三个字母首字母大写，如 `04 Nov`）开头，后面是描述的第一段。**例外**：后面紧跟 `YYYY OPENING BALANCE` / `YYYY CLOSING BALANCE` 的是表头表尾，不是交易。描述本身可以以 4 位数字开头（如 `1000 …`），**不是年份**【23 有一笔】
- 描述有 **1 到 3 行**【1 行 39 笔、2 行 62 笔、3 行 95 笔】，**金额和余额在最后一行的末尾**：`…  金额  余额 CR`。金额和余额都是 `1,234.56` 这样，没有 `$`，余额后面是一个空格加 `CR`。去掉千分位逗号，按 R1.0-4 转成分（余额可以是 0）
- 一行末尾是 `金额  余额 CR` 时这一笔结束。还没结束时下一行是续行；**已经结束、下一行又不是新的一笔**（不以 `DD Mon` 开头、不是页眉、不是 `CLOSING BALANCE`）→ 整份失败"交易表里第 n 笔下面有一行认不出来"（n 是它上面那笔；紧挨着 `OPENING BALANCE` 时写"OPENING BALANCE 下面"）。还没结束就来了新的一笔或 `CLOSING BALANCE` → 整份失败"第 n 笔找不到金额和余额"
- 一笔跨页（第一行在这一页，金额在下一页）→ 整份失败"第 n 笔跨页了，还没见过跨页的交易"【没见过，196 笔都在同一页】
- 见过的续行：`Card xxdddd`（刷卡）、`Value Date dd/mm/yyyy`（刷卡、部分扣款，金额在这行）、`PayID Phone from CommBank App`、`to PayID Phone`、转账备注（中文变成下划线）、`Wages dddddddd`、长参考号、BPAY 的参考号和备注、`CREDIT TO ACCOUNT`【3 份】
- **方向用余额判断**（照 R1D）：上一笔余额（第一笔用期初）− 金额 = 这一笔余额 → 借（负数）；+ 金额 = 这一笔余额 → 贷（正数）；都不是 → 整份失败"第 n 笔余额接不上"。`unpdf` 可能吃掉栏位之间的空白，所以不靠栏位位置【196 笔都能这样判断，没有对不上的】
- **余额只认 ` CR`**。表里或汇总里出现 ` DR`（透支）→ 整份失败"没见过透支的对账单"【没见过，3 份都没有 `DR`】
- 描述：第一行日期之后的部分和各续行（都去掉末尾的金额余额、去首尾空白）用**一个空格**拼起来。和 R1.0-5 不一样的地方只有一处：
  - **整行正好是 `Value Date dd/mm/yyyy` 的续行改成 `Value Date: dd/mm/yyyy`**（2026-11-02 定）。CSV 里是带冒号的，R3 只去掉带冒号的，不补的话 merchant 会多一截日期、R4.1 的 key 对不上【3 份 68 笔】
- 描述里的长参考号由 R2.3 脱敏【3 份 38 笔被改，脱敏后没有 8 位以上数字】
- 没有利息、手续费行（Everyday 账户）【3 份】。以后有了也是普通交易，不特殊处理
- `balanceCents`：每笔的余额，写进 R4.1 的 key（和 CBA CSV 一样）

**年份**：交易只有日和月，**年份只从 `OPENING BALANCE` / `CLOSING BALANCE` 两行读**（描述可能以 4 位数字开头）。

- 按表里的顺序（旧的在前），从 `periodFrom` 的年份开始，月份比上一笔小（如 Dec → Jan）就加一年；第一笔和 `OPENING BALANCE` 的月份比【22 跨年】
- 日期比上一笔早 → 整份失败"第 n 笔的日期比上一笔早"【没见过】
- 算出来的日期不在 `[periodFrom, periodTo]` 里 → 整份失败"第 n 笔的日期不在账期里"

**汇总**【3 份都在最后一页交易表下面】：

- `CLOSING BALANCE` 之后有一行以 `Opening balance` 开头、含 `Total debits`、`Total credits`、`Closing balance`（读出来是 `Opening balance  -  Total debits  Total credits  =  Closing balance`，`+` 读不出来；前面可能粘着条码，先去掉），**下一行**是 4 个数：`期初 CR  借合计  贷合计  期末 CR`。不是这个样子 → 整份失败"找不到汇总"
- 第 1 页上面还有一行 `Closing Balance  余额 CR`【3 份都等于 `CLOSING BALANCE`】，不用

**检查**（任何一条不过 → 整份失败，什么都不导，错误带第几笔和页码；第几笔是**这一页从上往下数**，和 PDF 上看到的一致。和 R1C、R1D 一样，不像 R1B.1 的 CSV 只警告）【3 份每一条都通过】：

- 期初 + 逐笔 = 每一笔的余额（上面判断方向时已经做了）
- 最后一笔的余额 = `CLOSING BALANCE`；一笔都没有时，`OPENING BALANCE` = `CLOSING BALANCE`
- 汇总的期初 = `OPENING BALANCE`，汇总的期末 = `CLOSING BALANCE`
- 汇总的借合计、贷合计 = 逐笔借、贷合计（都按正数比）

**输出顺序**：**新的在前**（把表里的顺序反过来），和 CBA CSV（R1B、R1.0-7）一样，和 R1C、R1D 不一样（2026-11-02 定）。R4.1 的 `occurrence` 按输出顺序数，这样同一天同额同描述的几笔，PDF 和 CSV 数出来的序号一样，key 才对得上（CBA 的 key 带余额，序号数反了 key 就不同）。3 份里没有这种组【重叠段 0 组】，fixtures 里有（`ZLR*Tower Sushi` 两笔）。

**一笔都没有**【没见过】：`OPENING BALANCE` 下面直接是 `CLOSING BALANCE` → 照 R1D 能导入，只建 `import_batch` 做对账和首尾衔接（R12.2）。汇总的借贷合计要是 0。要是空的对账单长得不一样（比如没有表头），会失败，碰到再改。

**R9 的日期范围**：照 R1D，`import_batch.date_from` 存 `periodFrom`（不加一天），`date_to` 存 `periodTo`，`source = pdf`。R12.2 的首尾衔接只找 `source = pdf` 的批次，CBA 以前的 CSV 批次不算。

**和 CSV 混导**（2026-11-02 用重叠段 2026-01-03 到 2026-08-01 对过：PDF 167 笔、`tests/local/` 的 CSV 167 笔）：

- **按"日期 + 金额 + 余额"167 笔全部一一对上**，两边都没有重复的组合，日期没有差一两天的
- 描述（R2.3 脱敏、R4.1 的 `normalizedDescription` 以后）：157 笔完全一样（其中 56 笔靠上面补的冒号）；10 笔不一样：
  - 8 笔 BPAY：CSV 是 `… CommBank app BPAY 75556 <参考号> …`，PDF 第一行以 `BPAY 7` 结尾，账单码后面几位**读不出来**，下一行直接是参考号。参考号和后面的备注两边一样。R3 把 `COMMBANK APP BPAY` 后面整段去掉，merchant 两边一样，不影响分类
  - 2 笔 PDF 少了 `(`（读不出来），R3 清洗后 merchant 也少一个 `(`
- **所以 R4.1 的 key 有 10 / 167 笔对不上**：先导 CSV 再导同期的 PDF（或反过来），这 10 笔会重复，R9 对不上。R1E 不改 key，交给 M8.5-4a（过渡期去重）
- 转账（R6.1）：重叠段两边都没有 `Transfer from/to xxdddd`（本家庭账户之间的转账）；PayID 转账两边写法一样。CSV 里唯一一笔带 `xx` 的在 2026-10-21，还没有对应的对账单，**PDF 里怎么写没见过** → M8.5-4b 等下一份对账单
- R12.1 撤销导入：PDF 里被 R4 跳过的那些属于 CSV 批次，撤销 PDF 批次不动它们

## R1E.1 例子

`fixtures/cba-statement/female-2026-09.txt`（编的，和 `cba/female-2026-09.csv` 同样的 20 笔，导入到测试家庭的 `CBA Female`，尾号 `0003`）第 1 页，省略了说明文字：

```
Your Statement
Statement 31  Page 1 of 3)
Account Number  06 9999 10000003
Female A Test  Period  1 Sep 2026 - 30 Sep 2026
Closing Balance  11,561.59 CR
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
```

这几行解析出（输出是新的在前，这里只列这 4 笔）：

| date | amountCents | description | balanceCents |
| --- | --- | --- | --- |
| 2026-09-05 | -680 | `SQ *OVERLAY COFFEE Melbourne VI AUS Card xx5555 Value Date: 03/09/2026` | 885185 |
| 2026-09-03 | -7135 | `seene CommBank app BPAY 9 1000999999` | 885865 |
| 2026-09-02 | -148000 | `Loan Repayment LN REPAY 123456789` | 893000 |
| 2026-09-01 | 41000 | `Salary EXAMPLE SCHOOL Wages 01092026` | 1041000 |

- `* *`、`=XÀâà9)`、条码去掉了，没进描述；`Value Date` 补了冒号
- 9/1 是账期第一天，算这一份（闭区间）
- 整份 20 笔和 R1B 解析 `cba/female-2026-09.csv` 的结果一样（顺序也一样），**只有 3 笔 BPAY 的描述不一样**（账单码只剩第一位），R2.3 脱敏后是 `seene CommBank app BPAY 9 ****9999`，CSV 是 `seene CommBank app BPAY 959502 ****9999`
- 账期 `2026-09-01` 到 `2026-09-30`，期初 1000000，期末 1156159，借合计 342585，贷合计 498744，账号尾号 `0003`

更多用例见 fixtures/README 的"CBA 对账单用例"。

## R1B CBA（2026-10 用真实导出确认）

- 没有表头，4 列：日期、金额、描述、余额，**全部带引号**
- 金额和余额都带正负号：`"+500.00"`、`"-20.00"`、`"+12345.67"`
- 同一天里也是新的在前

| 输入行                                                                      | 输出                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `21/10/2026,"+500.00","Transfer from xx5678 CommBank app Home","+12345.67"` | `{ date: '2026-10-21', amountCents: 50000, description: 'Transfer from xx5678 CommBank app Home', balanceCents: 1234567 }` |

## R1B.1 余额连续性检查

对相邻两行（文件顺序，第 i 行比第 i+1 行新）：

```
balance[i] − amount[i] == balance[i+1]
```

- 不成立 → **不报错**，导入照常进行，导入结果里显示警告"第 i 行和第 i+1 行之间余额不连续"
- 这能发现文件被手动改过、或银行导出不完整

## R1B.2 自动得出期初期末余额

- 期末 = 第一行（最新）的余额
- 期初 = 最后一行（最旧）的余额 − 最后一行的金额
- 自动填进 `import_batch` 的 `opening_balance_cents`、`closing_balance_cents`，然后跑 R9，不用手动填
