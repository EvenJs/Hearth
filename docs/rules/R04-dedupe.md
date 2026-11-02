# R4. 去重

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

## R4.1 生成 key

```
dedupe_key = sha256( account_id | date | amount_cents | normalizedDescription | occurrence | balance_cents )
```

- `balance_cents`：CBA 有余额，写进 key；ANZ 没有，写空字符串。ANZ 的 PDF 对账单虽然有余额，也写空字符串（R1C），不然和 CSV 的 key 对不上
- ANZ Plus 的 PDF 对账单（R1D）**写余额**：ANZ Plus 没有 CSV 要对齐，和 R1C 不一样。同一天同额同描述的两笔余额不同，key 本来就不同，`occurrence` 照旧数
- CBA 的 PDF 对账单（R1E）**写余额**，算法和 CBA CSV 一样。R1E 按新的在前输出，`occurrence` 和 CSV 数法一致。2026-11-02 对过真实文件：同期的 CSV 和 PDF 有 10 / 167 笔描述对不上（BPAY 账单码、`(` 读不出来，见 R1E "和 CSV 混导"），key 不改，混导靠 R4.3
- `normalizedDescription`：**脱敏后**的原始描述，转大写，连续空白合并为一个空格，去首尾空白（不是 merchant，清洗规则以后会改，key 不能跟着变）
- `occurrence`：同一个文件内，`(date, amount_cents, normalizedDescription)` 完全相同的第几笔，从 1 开始，按文件里的出现顺序计数

## R4.2 导入时

- 数据库里已有相同 `(account_id, dedupe_key)` → 跳过，计入 `duplicate_count`
- 没有 → 继续走 R8（pending 匹配）和插入

| 场景                                                   | 结果                              |
| ------------------------------------------------------ | --------------------------------- |
| 文件里同一天同店两笔 `-4.50`                           | occurrence 1 和 2，两笔都插入     |
| 同一个文件导入两次                                     | 第二次全部跳过                    |
| 9 月 1 到 30 日已导入，再导 9 月 15 日到 10 月 15 日   | 9 月 15 到 30 日跳过，10 月的插入 |
| 先导的文件里某天有 2 笔相同，后导的文件里同一天有 3 笔 | 前 2 笔跳过，第 3 笔插入          |

**已知风险**：如果银行在两次导出之间改了某笔的描述，会被当成新交易。用 R9 对账发现。

## R4.3 CBA 对账单的补充去重（2026-11-03 新增，M8.5-4a）

CBA 的 CSV 和 PDF 对账单同期的交易，有几笔描述对不上（PDF 读不出 BPAY 账单码后面几位、读不出 `(`，见 R1E "和 CSV 混导"），R4.1 的 key 不同。描述补不回来，所以**不改 key**，导入 CBA 对账单时多查一次：

- **只在导入 R1E（CBA PDF 对账单）时做**。CBA CSV、ANZ、ANZ Plus 都不做
- 对象：R4.2 按 key 没跳过的那些行
- 候选：同账户已有的交易里 `balance_cents` 不为空、`dedupe_key` 不为空（导入进来的；手动录入和 pending 没有余额，不算），**去掉**这次在 R4.2 里已经被 key 命中的
- `(date, amount_cents, balance_cents)` 和某个候选一样 → 跳过，计入 `duplicate_count`，不插入，不改那个候选
- **一对一**：一个候选最多抵掉一行。同一组 `(date, amount_cents, balance_cents)` 文件里有 n 行、候选有 m 个 → 跳过 min(n, m) 行，按输出顺序（新的在前）先跳过前面的，剩下的继续走 R8 和插入
- 一直开着，不限日期：PDF 和 PDF 之间 key 本来就一样，这一步不会多跳过东西
- 已入库的交易一律不动（key、描述、分类、归属人都不改）。被跳过的行属于原来的批次，撤销这次 PDF 批次不动它们（R12.1）

**不管的方向**：先导 PDF、再导同期的 CBA CSV，CSV 那边不做 R4.3，那几笔照旧会重复（以后不导 CBA CSV，2026-11-02 定）。用 R9 发现，手动删掉。

| 场景（同一个 CBA 账户） | 结果 |
| --- | --- |
| 已有 CSV 导的一笔 BPAY，PDF 里同一天同额同余额、描述只剩账单码第一位 | key 不同，R4.3 命中，跳过 |
| 同一份 PDF 导两次 | 第二次全部被 R4.2 跳过，R4.3 没有要查的 |
| PDF 里一行和已有交易日期、金额一样，余额不一样 | 不跳过 |
| 文件里同一天同额同余额 2 行（扣 10、退 10、又扣 10），已有交易里这一组只有 1 个 | 跳过前 1 行，第 2 行插入 |
