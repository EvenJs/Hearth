# R4. 去重

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

## R4.1 生成 key

```
dedupe_key = sha256( account_id | date | amount_cents | normalizedDescription | occurrence | balance_cents )
```

- `balance_cents`：CBA 有余额，写进 key；ANZ 没有，写空字符串。ANZ 的 PDF 对账单虽然有余额，也写空字符串（R1C），不然和 CSV 的 key 对不上
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
