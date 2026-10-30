# R1. 解析（CSV 和 PDF 对账单）

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

**输入**：CSV 文件文本（R1A、R1B），或 ANZ / ANZ Plus 对账单读出来的文字行（R1C、R1D）+ 账户的银行
**输出**：`ParsedRow[]`，每行 `{ date: 'YYYY-MM-DD', amountCents: number, description: string, balanceCents: number | null, rowIndex: number }`

按 `financial_account.bank` 选解析器：

| bank                  | 解析器 | 说明                               |
| --------------------- | ------ | ---------------------------------- |
| anz                   | R1A    | CSV。PDF 对账单用 R1C（2026-10-28） |
| cba                   | R1B    |                                    |
| anz_plus              | R1D    | 不能导入 CSV，只能导 PDF 对账单（R1D，2026-10-30） |
| cash、other           | 无     | 不能导入，只能手动录入（R8.1）     |

## R1.0 两个解析器共用的规则

> R1A、R1B 两个 CSV 解析器都用。R1C 对账单只用第 4（金额）、6（出错整份失败）、7（按文件顺序输出）条。R1D 只用第 4、5、6 条，输出顺序见 R1D。

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
- 上传对账单时先按这两条判断：都满足用 R1D，否则交给 R1C

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
