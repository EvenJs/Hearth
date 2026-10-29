# R1. 解析（CSV 和 ANZ 对账单）

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

**输入**：CSV 文件文本（R1A、R1B），或 ANZ 对账单读出来的文字行（R1C）+ 账户的银行
**输出**：`ParsedRow[]`，每行 `{ date: 'YYYY-MM-DD', amountCents: number, description: string, balanceCents: number | null, rowIndex: number }`

按 `financial_account.bank` 选解析器：

| bank                  | 解析器 | 说明                               |
| --------------------- | ------ | ---------------------------------- |
| anz                   | R1A    | CSV。PDF 对账单用 R1C（2026-10-28） |
| cba                   | R1B    |                                    |
| anz_plus、cash、other | 无     | 不能导入 CSV，只能手动录入（R8.1） |

## R1.0 两个解析器共用的规则

> R1A、R1B 两个 CSV 解析器都用。R1C 对账单只用第 4（金额）、6（出错整份失败）、7（按文件顺序输出）条。

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
