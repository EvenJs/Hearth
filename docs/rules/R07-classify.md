# R7. 分类

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

对每笔新交易，按顺序，**第一个命中的生效**：

1. 已经被 R6.1 标为内部转账 → 内部转账
2. 系统规则（硬编码，不在 `category_rule` 表）：

   | 条件（merchant）                                 | 分类                                |
   | ------------------------------------------------ | ----------------------------------- |
   | 以 `ATM` 开头                                    | 现金支出（system: cash_withdrawal） |
   | 含 `ACCOUNT SERVICING FEE`（包括 `REVERSAL OF`） | 银行费用（system: bank_fee）        |

   其他银行费用（如信用卡利息）等拿到对应 CSV 后再加，不提前猜。

3. 用户规则（`category_rule` 表）：
   - 对 merchant 做匹配：`contains` 是包含，`starts_with` 是开头匹配，都不区分大小写
   - 多条命中时：`priority` 大的优先；相同时**关键词长的优先**（`DOWNTOWN GROCER` 优先于 `GROCER`）；再相同按创建时间早的
4. 都没命中 → 未分类（system: uncategorized）

`category_source`：1、2 写 `system`，3 写 `rule`，用户手动改的写 `manual`。

`is_pre_tax`：分类确定后，等于该分类的 `is_pre_tax_default`。用户可以单独改；之后分类再变时重新按分类设置。

## R7.1 正数金额（退款、报销）

- 正数交易同样走上面的规则
- 命中支出类规则（如 `MELB ASIAN MARKET` +0.72）→ 归到那个支出分类，在统计里**冲减**该分类支出（见 R10）
- 没命中 → 未分类，由用户决定是收入还是退款

## R7.2 重新应用规则

用户新建或修改规则后，可以选择对已有交易重新分类：

- **只改 `category_source = rule` 或未分类的交易**
- `manual` 和 `system` 的不动
- 分类变了的，按 R5.1 重新计算归属人
- **有多个拆分的交易跳过**，只处理只有一个拆分的交易
- 提示的"跳过几笔"只算本来会被考虑（有 `rule` 来源或未分类的拆分）、因为多个拆分被跳过的交易；全是 `manual` 的多拆分交易本来就不会动，不算（2026-10-24 补）
