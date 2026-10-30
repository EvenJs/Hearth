# pending 匹配用例（R8）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

在导入 `joint-2026-09.csv` **之前**，先在 ANZ Joint 手动录入这些 pending：

| pending | 金额   | 日期       | 期望                                                                                           |
| ------- | ------ | ---------- | ---------------------------------------------------------------------------------------------- |
| P1      | -61.20 | 2026-09-20 | 匹配 #8（相差 2 天）→ 确认，不新增；日期变 09-22，保留 P1 的分类和归属人                       |
| P2      | -38.75 | 2026-09-20 | 匹配 #9（相差 0 天）→ 确认                                                                     |
| P3      | -25.00 | 2026-09-11 | 和 P4 一起，#12 有 2 个候选 → #12 正常新增，提示可能重复                                       |
| P4      | -25.00 | 2026-09-12 | 同上                                                                                           |
| P5      | -10.00 | 2026-09-05 | 没有匹配 → 保持 pending，导入结果里提示检查                                                    |
| P6      | -58.40 | 2026-09-02 | #19 日期 09-01 **早于** pending → 不匹配（R8.2 银行日期不早于消费日期）；#19 新增；P6 提示检查 |

计数：`inserted_count = 17`、`matched_pending_count = 2`。

## 手动录入的初始状态（R8.1）

| 用例 | 操作                                                               | 期望                                                           |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| P7   | 在 ANZ Plus Male 手动录入 2026-09-30 +8.50，分类 Income / Interest | pending（2026-10-30 改：anz_plus 能导 PDF 对账单，R8.1），is_pre_tax = true，Male |
| P8   | 在 CBA Female 手动录入 -15.00                                      | pending（cba 有解析器）                                        |
| P9   | 尝试给 ANZ Plus Male 导入 CSV                                      | 拒绝：这个账户不能导入                                         |

## pending 被转账行确认（R8.3 例外，单独测，空数据库）

| 用例 | 操作 | 期望 |
| --- | --- | --- |
| P10 | 在 ANZ Joint 手动录入 2026-09-14 -500.00，分类 Entertainment & eat-out / Restaurants，归属人 Female，备注"给老婆"；然后导入 `joint-2026-09.csv` | 匹配 #11（相差 1 天）→ confirmed，日期变 09-15；R6.1 认出转给 CBA Female → `transfer_status = auto`，分类改成 Internal transfer，`category_source = system`；归属人保持 Female（manual），备注保留 |

计数：`inserted_count = 18`、`matched_pending_count = 1`。之后导入 `cba/female-2026-09.csv`，P10 和 CBA #10 照常配对。

## ANZ Plus 的旧手动交易（R8.2 候选，2026-10-30 加）

R8.1 改之前在 ANZ Plus 手动记的 confirmed 交易，导入对账单时当候选。P11–P14 的交易直接写进数据库（模拟旧数据），不经过录入流程。

| 用例 | 旧交易 | 期望 |
| --- | --- | --- |
| P11 | ANZ Plus Male，2026-09-30 +20.00，`confirmed`、`source = manual`、`import_batch_id` 空，分类 Income / Interest | 是候选。导入 `anz-plus-statement/growth-2026-09.txt`：匹配 `BONUS CREDIT INTEREST PAID $20.00`（相差 0 天）→ 按 R8.3 更新，不新增；分类保留。撤销这次导入（R12.1）→ 变成 **pending**，再导一次又匹配上 |
| P12 | ANZ Plus Male，同 P11，但 `import_batch_id` 有值 | 不是候选（已经被导入确认过） |
| P13 | ANZ Joint，2026-09-30 +20.00，`confirmed`、`source = manual`、`import_batch_id` 空 | 不是候选（不是 anz_plus）。CBA Female 一样 |
| P14 | ANZ Plus Male，2026-09-30 +20.00，`confirmed`、`source = receipt`、`import_batch_id` 空 | 不是候选（R8.2 只写了 `source = manual`） |

纯函数层（M7.5-4）只测"是不是候选"和匹配结果；更新字段、撤销恢复成 pending 在 M7.5-5 的 `pnpm test:db` 里测。
