# R11. 预算

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

- 预算挂在一级分类上 → 统计该一级下所有二级的支出
- 进度 = 本月该分类支出 ÷ 月度上限
- ≥ `warn_at_percent` → 黄色提醒；≥ 100% → 红色
- 只按自然月计算
