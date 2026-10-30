# R5. 归属人

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

归属人的含义是**钱用在谁身上**，不是谁付的钱。卡号只能说明谁付的，所以优先级排在分类后面。

**R5 在 R7 分类之后执行**，因为要用到分类。

每笔新交易的拆分 `member_id`，按优先级，`member_source` 记录用的是哪一条：

| 优先级 | 来源                                                                | member_source |
| ------ | ------------------------------------------------------------------- | ------------- |
| 1      | 手动指定（手动录入时自己选的，或用户在 F8 改过；R17.3）             | manual        |
| 2      | 分类默认：二级分类的 `default_member_id`，为空时用一级的            | category      |
| 3      | 卡号映射：`card` 表里 `(account_id, card_last4)` 对应的 `member_id` | card          |
| 4      | 账户的 `default_member_id`                                          | account       |

系统分类和 Uncategorised 没有分类默认，直接走 3、4。

| 账户                       | 卡              | 分类                     | 结果                 |
| -------------------------- | --------------- | ------------------------ | -------------------- |
| Joint（默认 Home）         | `1111 → Male`   | Coffee & tea             | Male（card）         |
| Joint（默认 Home）         | `1111 → Male`   | Groceries / Supermarket  | **Home**（category） |
| Joint（默认 Home）         | `2222 → Female` | Uncategorised            | Female（card）       |
| Joint（默认 Home）         | 没有卡号        | Restaurants              | Home（account）      |
| Joint（默认 Home）         | `9999` 未登记   | Uncategorised            | Home（account）      |
| Male 个人账户（默认 Male） | 没有卡号        | Home & utilities / Water | **Home**（category） |
| Male 个人账户（默认 Male） | 没有卡号        | Public transport         | Male（account）      |

## R5.1 分类改变时重新计算

分类因为任何原因改变（手动改、规则重新应用、pending 确认除外），如果 `member_source != manual`，按上表重新计算归属人。`manual` 的永远不动。
