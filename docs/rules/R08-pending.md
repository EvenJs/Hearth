# R8. pending 交易匹配

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

## R8.1 手动录入时

| 账户                                            | status    | 原因                  |
| ----------------------------------------------- | --------- | --------------------- |
| bank = cash、anz_plus、other（没有 CSV 解析器） | confirmed | 不会有银行流水来确认  |
| bank = anz、cba                                 | pending   | 等导入 CSV 时匹配确认 |

ANZ Plus 只能看 PDF 对账单，利息每月手动记一笔（Income / Interest，税前），录入后直接 confirmed。

日期默认今天（`Australia/Melbourne`）。手动录入的交易没有 `dedupe_key`。

## R8.2 导入时匹配

对每笔通过去重检查（R4）的 CSV 行，在同账户的 `pending` 交易里找候选：

- `amount_cents` 完全相等
- CSV 日期 − pending 日期 ∈ [0, 3] 天（银行入账不会早于消费）
- 还没被本次导入的其他行匹配走

| 候选数 | 处理                                                 |
| ------ | ---------------------------------------------------- |
| 0      | 正常插入新交易                                       |
| 1      | **确认这笔 pending，不插入新交易**（见 R8.3）        |
| ≥ 2    | 正常插入新交易，两边都提示"可能重复"，让用户手动处理 |

## R8.3 确认时更新的字段

| 字段                                     | 处理                             |
| ---------------------------------------- | -------------------------------- |
| status                                   | → confirmed                      |
| date                                     | → 银行日期                       |
| raw_description、merchant、card_last4    | → 银行的                         |
| dedupe_key、import_batch_id              | → 填上                           |
| confirmed_at                             | → now()                          |
| 拆分（分类、归属人、note，包括多个拆分） | **保留用户录入的**，不用规则覆盖 |
| source                                   | 保留原来的（`manual`，或小票建的 `receipt`，R20.7） |

**例外：银行那行是内部转账。** 确认时对银行那行跑 R6.1，认出是内部转账时 R6.1 优先：

- `transfer_status = auto`，主拆分分类改成内部转账，`category_source = system`
- 归属人按 R5.1（手动录入的是 `manual`，不动），备注保留
- pending 有多个拆分时不改，保留用户的拆分，在 F8 提示
- 之后照常参加 R6.2 配对

理由：手动录入时多半没想到这是转给自己的账户，按银行信息纠正更合理。转给朋友的钱 R6.1 认不出，不受影响。

## R8.4 导入后提示

导入完成后，该账户里日期 ≤ 本次 `date_to` − 3 天、仍是 pending 的交易 → 在导入结果页列出，提示检查。
