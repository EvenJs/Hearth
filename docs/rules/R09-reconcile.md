# R9. 对账校验

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

有期初和期末余额时（ANZ 的 CSV 由用户手动填，ANZ 的 PDF 对账单从汇总页读（R1C），CBA 按 R1B.2 自动得出）：

```
opening_balance + Σ(该账户所有 confirmed 交易，date ∈ [date_from, date_to]) == closing_balance
```

- 用**数据库里**的交易合计，不只是本次文件（能发现之前漏导的）
- pending 不算
- 相等 → `reconciled = true`；不等 → `false`，显示差额
