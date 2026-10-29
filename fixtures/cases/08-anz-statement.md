# ANZ 对账单用例（R1C、R12.2，M6.6）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

`anz-statement/` 里是**编的**对账单文字，模拟 `unpdf` 读出来再拼成行的样子（R1C 第一层的输出），不是 PDF，也不是真对账单。格式照真实对账单的结构：表头、汇总、交易行最后三段是"支出 / 存入 / 余额"（空的写 `blank`）、多行描述、`EFFECTIVE DATE` 行、每页的 `TOTALS AT END OF PAGE`、页眉。分页用单独一行 `<<<PAGE>>>`。

标题都是 `ANZ ACCESS ADVANTAGE STATEMENT`。Progress Saver 的标题 `PROGRESS SAVER ACCOUNT STATEMENT`（没有 `ANZ`，R1C 2026-10-29 改）不单独编文件，测试里把 `joint-2026-09.txt` 的标题换掉再解析。

2026-10-29 照 `unpdf` 读真实对账单的样子改过（R1C）：汇总页左右两栏拼在一起，标签带冒号、`$` 和金额在后面几行；`Account Number` 的号码在下面两行；`OPENING BALANCE` 那行只有余额，`blank  blank` 在上面年份那行；合计行前面多一个 `blank`，`TOTALS AT END OF PERIOD` 最后还有期末余额。账号用测试家庭的假尾号，金额、期初是编的。

账期照真实对账单的样子，同一天首尾相接：`31 AUGUST 2026 TO 30 SEPTEMBER 2026` 包含的是 9/1 到 9/30（R1C：`(periodFrom, periodTo]`）。

| 文件 | 内容 |
| --- | --- |
| `joint-2026-09.txt` | `31 AUGUST 2026 TO 30 SEPTEMBER 2026`，账号以 `0001` 结尾，期初 5,000.00，和 `anz/joint-2026-09.csv` 同样的 19 笔，分两页 |
| `joint-2026-10.txt` | `30 SEPTEMBER 2026 TO 31 OCTOBER 2026`，期初 = 上一份的期末，**一笔交易都没有** |
| `joint-2026-11-gap.txt` | `31 OCTOBER 2026 TO 30 NOVEMBER 2026`，期初比上一份的期末多 100.00，2 笔交易 |
| `broken-balance.txt` | 和 `joint-2026-09.txt` 一样，第 2 页第 3 笔的余额改错 |
| `wrong-account.txt` | 和 `joint-2026-09.txt` 一样，账号以 `0002` 结尾 |
| `year-rollover.txt` | `15 DECEMBER 2026 TO 15 JANUARY 2027`，DEC 和 JAN 各有交易。JAN 前面有 `2027  blank` 那行，JAN 第一笔（存入）只剩金额、余额两段（R1C 换年的例外） |
| `first-day.txt` | 和 `joint-2026-09.txt` 一样，多一笔 `31 AUG` 的交易 |

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| S1 | 空数据库 | 导入 `joint-2026-09.txt` 到 ANZ Joint | 19 笔，结果和只导入 `joint-2026-09.csv` 一样（上面 19 行的表）。`source = pdf`，`date_from = 2026-09-01`，`date_to = 2026-09-30`，期初期末从汇总页来，`reconciled = true`。卡号消费的 `EFFECTIVE DATE` 没有进描述 |
| S2 | 导入 `joint-2026-09.csv` | 再导入 `joint-2026-09.txt` | 新增 0，跳过 19，`reconciled = true` |
| S3 | 导入去掉 #12 的 joint CSV（测试里现拼） | 导入 `joint-2026-09.txt` | 新增 1（#12），跳过 18，`reconciled = true` |
| S4 | S1 | 导入 `joint-2026-10.txt` | 新增 0，建了批次，`reconciled = true`；R12.2 提示"和上一份对账单接上了" |
| S5 | S4 | 导入 `joint-2026-11-gap.txt` | 2 笔照常导入；R12.2 警告和上一份差 $100.00 |
| S6 | 空数据库 | 导入 `broken-balance.txt` | 整份失败，错误写第 2 页第 3 笔，什么都没写 |
| S7 | 空数据库 | 把 `wrong-account.txt` 导入到 ANZ Joint | 整份失败"这份对账单不是这个账户的"；错误信息里没有完整账号 |
| S8 | 纯函数 | 解析 `year-rollover.txt` | DEC 的是 2026 年，JAN 的是 2027 年 |
| S8b | 纯函数 | 解析 `first-day.txt` | 失败，信息写"账期第一天有交易，R1C 对账期的假设不对" |
| S9 | 导入 `joint-2026-09.csv` | 导入页选 ANZ Joint | 显示"上次导入到 2026-09-30"（CSV 最晚一笔），建议导出 2026-09-23 到今天 |
| S10 | S9 | 再导入一份最早是 2026-10-05 的 CSV（测试里现拼） | 结果页警告和上次之间可能漏了 |
| S11 | 空数据库 | 不选账户，导入 `joint-2026-09.txt` | 认出 ANZ Joint（尾号 `0001`），结果和 S1 一样 |
| S12 | 空数据库 | 不选账户，导入 `wrong-account.txt` | 认出 ANZ Male（尾号 `0002`），导入到 ANZ Male，ANZ Joint 没有交易 |
| S13 | 把 ANZ Joint 的尾号改成 `9999` | 不选账户，导入 `joint-2026-09.txt` | 整份失败"找不到尾号是 0001 的 ANZ 账户"；CBA 账户就算尾号对得上也不算；什么都没写 |
| S14 | 把 ANZ Male 的尾号改成 `50001` | 不选账户，导入 `joint-2026-09.txt` | 整份失败"有 2 个 ANZ 账户的尾号都对得上"；什么都没写 |

另外：解析结果里没有完整账号；测试检查 `import_batch`、`transaction` 里没有 8 位以上连续数字（R2.3 照旧）。
