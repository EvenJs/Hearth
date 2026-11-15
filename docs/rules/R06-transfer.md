# R6. 内部转账识别

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

## R6.1 自动识别（导入时）

两种认法，按顺序：先按账号；R2.2 没取到账号时，才按对账单上的账户名（同一家银行内部，见下面"按账户名认"）。

**按账号**，条件全部满足：

- 描述含 `FUNDS TFER` 或 `TRANSFER`
- R2.2 提取出了对方账号数字
- 这个数字和本家庭某个 `financial_account.number_suffix` **尾部对得上**，且不是当前账户自己
  - 提取的数字以尾号结尾（ANZ 完整账号的情况），或
  - 尾号以提取的数字结尾（CBA 只给 4 位的情况）

结果：`transfer_status = auto`，分类设为系统分类"内部转账"，`category_source = system`

- 对上**多个**家庭账户（如提取到 `5678`，家里有 `115678` 和 `225678`）→ 不认成转账，走 R7，留给 R6.3 兜底
- 没有尾号的账户（现金）不参与匹配

| 对方账号          | 家庭账户尾号    | 结果                       |
| ----------------- | --------------- | -------------------------- |
| `012345400006691` | 某账户 `6691`   | auto                       |
| `400006691`       | 某账户 `6691`   | auto                       |
| `400006691`       | 某账户 `006691` | auto（尾号 4 到 6 位都行） |
| `400006747`       | 没有匹配        | 不是内部转账，走 R7        |
| `5678`（CBA）     | 某账户 `5678`   | auto                       |
| `5678`（CBA）     | 某账户 `115678` | auto                       |
| `5678`（CBA）     | 某账户 `0567`   | 不匹配                     |

**PayID 转账没有账号**（如 `Fast Transfer From <人名>`），R6.1 认不出来，靠 R6.2 配对或 R6.3 兜底。

### 按账户名认（同一家银行内部，2026-11-15 定，M9.5）

BOQ、Westpac 本行账户之间的转账，描述里只有对方的**银行产品名**（会截断），没有账号（R1F、R1G）。拿它去对账户上的 `statement_name`（"对账单上的账户名"，账户设置里手动填，见 `schema.md` financial_account），不用 `name`（app 里自己起的名字）。

**什么时候走这条**：R2.2 没取到账号（取到了就只按账号认，对不上照旧走 R7，不再按名字试），且当前账户的 `bank` 在下表里，且描述是表里的开头。

**取对方账户名**：去掉开头，剩下的全部（去首尾空白）。剩下是空的（如 `To: `）→ 不按名字认，走 R7（2026-11-15 补，M9.5-6）。

| bank | 描述开头 | 例子 | 取出来 |
| --- | --- | --- | --- |
| westpac | `Withdrawal Mobile ddddddd Tfr `（转出） | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | `Westpac Lif` |
| westpac | `Deposit Online ddddddd Tfr `（转入） | `Deposit Online 2000001 Tfr Westpac Cho` | `Westpac Cho` |
| boq | `To: `（转出） | `To: Future Saver NOTPROVIDED` | `Future Saver NOTPROVIDED` |
| boq | `From: `（转入） | `From: Everyday Account NOTPROVIDED` | `Everyday Account NOTPROVIDED` |

- `ddddddd` 是 7 位数字（R1G 的流水号）。开头大小写照真实的写法，不放宽
- 不在表里的银行、不是表里开头的描述 → 不按名字认，走 R7（外行的 `Deposit-Osko Payment …` 也不在表里）
- ING（M9.6）到时候在表里加行

**比较**：两边都不分大小写、连续空白压成一个空格。满足一条就算对上：

- **截断**：取出来的是 `statement_name` 的前缀（`Westpac Lif` 对 `Westpac Life`；一字不差也算）
- **后面带了东西**：`statement_name` 是取出来的前缀，而且后面紧跟空格（`Everyday Account` 对 `Everyday Account NOTPROVIDED`）。BOQ 的 `NA`、`NOTPROVIDED`、转账备注都接在名字后面（R1F 不去掉），所以要这一条；后面紧跟的不是空格不算（`Future Saver` 对 `Future Savers …` 不算）

**在哪些账户里找**：本家庭、`bank` 和当前账户相同、没归档、不是当前账户自己、`statement_name` 不为空。

- 对上恰好 1 个 → 结果和按账号认一样：`transfer_status = auto`，分类内部转账，`category_source = system`；R6.2 的"对方账户"就是它
- 对上多个 → **也认成转账**：`transfer_status = auto`，分类内部转账，`category_source = system`，但**对方账户未知**。R6.2 不从这一边找另一半（对方那边认出唯一一个的，照旧从那边找）；R24.3 当未知。钱是在本家庭同一家银行里转，转进哪一个都不影响收支（2026-11-15 改，M9.5-8：BOQ 有 9 个 Future Saver，`statement_name` 都是 `Future Saver`，描述里看不出是哪一个；原来的"不认"会把 Everyday 的每笔转出都算成支出）
  - 只管按账户名认。按账号对上多个的照旧不认（见上面）
- 对上 0 个 → 走 R7。外行转入 `From: <户名>` 一般对不上，照旧靠 R6.3
- 别的银行里同名的账户不算（只在同一个 `bank` 里找）

| 当前账户 | 描述 | 本家庭账户（`bank`、`statement_name`） | 结果 |
| --- | --- | --- | --- |
| Westpac Choice | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | westpac `Westpac Life` | auto，对方 Westpac Life |
| Westpac Life | `Deposit Online 2000001 Tfr Westpac Cho` | westpac `Westpac Choice` | auto，对方 Westpac Choice |
| BOQ Everyday | `To: Future Saver NOTPROVIDED` | boq `Future Saver` | auto，对方 Future Saver |
| BOQ Future Saver | `From: Everyday Account NOTPROVIDED` | boq `Everyday Account` | auto，对方 Everyday |
| Westpac Choice | `Withdrawal Mobile 1000002 Tfr Westpac Lif` | westpac `Westpac Life`、westpac `Westpac Life Bonus` | 多个，auto，对方未知 |
| BOQ Everyday | `To: Future Saver NOTPROVIDED` | boq 9 个 `Future Saver` | 多个，auto，对方未知 |
| BOQ Everyday | `To: Future Saver NOTPROVIDED` | 只有 westpac `Future Saver` | 别家银行，不认 |
| BOQ Everyday | `To: Everyday Account NOTPROVIDED` | 只有自己是 `Everyday Account` | 是自己，不认 |
| BOQ Future Saver | `From: TEST FRIEND NA` | boq `Everyday Account` | 不认，走 R7 / R6.3 |
| BOQ Everyday | `To: Future Saver NOTPROVIDED` | boq Future Saver 的 `statement_name` 为空 | 不认 |

**同金额多笔**：两边都各自按名字认成 auto（不计收支），不靠 R6.2 把另一半改过来。R6.2 找到多笔时照旧不配对，`transfer_pair_id` 留空（一天 5 笔 `To: Future Saver` 就是这样，2026-11-15 定不改 R6.2）。R24.3 没配对时从描述重跑 R6.1，按名字认也要能用。

**几个同名账户**（如 9 个 `Future Saver`）：Everyday 的 `To: Future Saver` 是 auto、对方未知，不从它出发配对；每个 Saver 的 `From: Everyday Account` 只对上一个 Everyday，从 Saver 那边照常走 R6.2，对方那笔是这条 auto，恰好 1 笔就配上，多笔就不配。两边都不计收支。

## R6.2 配对

每次导入完成后，对**整个家庭**里还没配对的 `auto` 转账（包括以前导入的），在对方账户里找另一半：

- 对方账户 = R6.1 匹配到的那个账户
- 金额相反（`a = -b`）
- 日期相差 ≤ 2 天
- 对方那笔还没配对

找到恰好 1 笔 → 两边互相写 `transfer_pair_id`。另一半如果还不是转账（比如 CBA 那边只显示人名，被分成了 Uncategorised）：

- `transfer_status` 改成 `auto`，分类改成内部转账，`category_source = system`
- 如果另一半的分类是 `manual`，不改它，只配对，并在 F8 提示（R16.7）。`transfer_status` 也不改（保持 `none`），因为 auto 不计收支，改了等于把手动分类从统计里抹掉

找到 0 笔（对方账户还没导入）或多笔 → 不配对，不影响它被标成转账。

为什么要对整个家庭重跑：先导 ANZ joint、后导 CBA 时，转账的识别发生在 ANZ 那边，要等 CBA 导进来才找得到另一半。

## R6.3 兜底建议

导入完成后，对**本次导入新插入的**交易里，**不是**转账、且属于"未分类"的：

- 在本家庭其他账户里找：金额相反、日期相差 ≤ 2 天、也是未分类、还没配对（候选可以是以前导入的）
- 恰好 1 个候选 → 两边都标 `transfer_status = suggested`，配对
  - "恰好 1 个"要求**两边互相**都只有对方这一个候选。A 只有 B，但 B 有 A 和 C 两个候选 → 不建议
- 只从本次新插入的交易出发，是为了每一对只在后导入的那一边进来时检查一次。拒绝过的两笔都是旧交易，以后的导入不会再建议（撤销后重新导入会再建议一次，可以接受）
- 为什么只建议不自动生效：朋友 AA 的转账（PayID，R6.1 认不出）可能刚好和另一笔金额相反、日期接近，要人来判断

确认前**按普通交易统计**（还是未分类）。在 F8 里确认或拒绝，两边一起改：

| 字段             | 确认                                  | 拒绝       |
| ---------------- | ------------------------------------- | ---------- |
| transfer_status  | `confirmed`                           | `none`     |
| 分类             | 内部转账                              | 保持未分类 |
| category_source  | `manual`（人决定的，R7.2 不会覆盖）   | 不变       |
| transfer_pair_id | 保留                                  | 清空       |
| 归属人           | 不变（未分类和内部转账都没有分类默认，R5.1 重算结果一样） | 不变       |

- 从任意一边发起都行，两边一起改，一个事务。不是 `suggested`、两笔没有互相配对时报错，什么都不改
- 有多个拆分的交易不能确认（内部转账不该有别的分类的拆分），提示先删掉拆分；拒绝不受影响（2026-10-24 补）

---

## R6.4 账户尾号改变后重新识别（2026-10-25）

R6.1 只在导入时跑。账户是后来才建的、尾号是后来才填的、或者规则后来才补上的（比如 ANZ Plus 带 BSB 的格式），以前导入的转账就一直是普通交易。所以**保存带尾号的账户时**（新建或编辑，尾号变没变都算），对本家庭的旧交易重跑一次：

1. 候选：本家庭其他账户里 `transfer_status = none`、没有 `transfer_pair_id` 的交易
2. 对候选的**脱敏后**描述跑 R2.2 和 R6.1，只看能不能对上**这个账户**。脱敏后完整账号只剩 `****1234`，按 R12.1 的方式当 4 位尾号匹配（这个账户的尾号以这 4 位结尾）；同时对上家里多个账户的照 R6.1 不算
3. 对上的按主拆分来源处理：

| 交易 | 处理 |
| --- | --- |
| 只有主拆分，`category_source = rule`，或未分类 | `transfer_status = auto`，分类改成内部转账，`category_source = system`，归属人按 R5.1 |
| 分类是 `manual` | 不改，计数 |
| 有多个拆分 | 不改，计数 |
| `suggested`（R6.3） | 不在候选里（第 1 步已排除），留给用户在 F8 确认或拒绝 |

4. 改完对整个家庭跑一次 R6.2 配对（这个账户能导入时，另一半可能已经在了）

保存前弹窗："有 N 笔旧交易会认成内部转账（另有 M 笔分类是手动的或拆分过，不改）。要改吗？"。N 是 0 就不弹，直接保存。选"不改"也照样保存账户，只是不动交易。一个事务。

- 改尾号时，以前按**旧尾号**认成转账的交易不退回去。很少见，真遇到了在 F8 手动处理
- 尾号是空的不触发
- **`statement_name`（2026-11-15，M9.5）**：保存 `statement_name` 不为空的账户时同样触发，第 2 步换成对候选的描述跑 R6.1 的"按账户名认"，只看能不能对上这个账户（对上多个、其中有这个账户的也算，结果是 auto、对方未知，同 R6.1）。尾号和 `statement_name` 都填了就两种都跑，一次弹窗，N 合在一起算。为的是先导了 Everyday、后来才给 Future Saver 填名字的情况
- 已经认过的交易 `transfer_status` 不是 `none` 了，不在候选里，所以重复保存不会重复改，N 一般是 0、不弹

例子 2（带 BSB）：ANZ Male 里有一笔 `TRANSFER TO 012345-****0004 #123456`（规则补上以前导入的，是 Uncategorised）。编辑 ANZ Plus Male（尾号 `0004`）直接保存 → 弹窗 N = 1 → 变成 auto、Internal transfer。

例子 1：建 fixtures 家庭时 CBA Female 先不填尾号，导入 `joint-2026-09.csv`：#11 `TRANSFER TO ****0003` 认不出，是 Uncategorised、Home（account），和 #18 一样。给 CBA Female 填上 `0003` 保存 → 弹窗 N = 1 → #11 变成 auto、Internal transfer、Home（account）。再导入 `cba/female-2026-09.csv`，#11 和 CBA #10 照常配对。
