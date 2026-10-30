# 撤销导入用例（R12.1）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

| 用例 | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| U1 | 导入 joint → overlap | 撤销 joint 主文件那次 | 拒绝：ANZ Joint 最近一次导入是 overlap |
|    |  | 撤销 overlap | 删除 3 笔（10/08 WOOLWORTHS、10/03 FROM \*\*\*\*0002、GONG CHA 第 3 笔）；joint 的 19 笔不变 |
| U2 | 导入 joint → overlap → me | 撤销 me | 不弹窗（没有手动改过的）。删除 me 的 4 笔。Joint #7：`suggested` → `none`，Uncategorised，`category_source = system`，Home（account），配对清空。Joint #17：重跑 R6.1，`****0002` 对上 ANZ Male → 保持 auto 和 Internal transfer，只清空配对 |
|    |  | 再导入 me | 和第一次一样：#7 和 PAYID PAYMENT 重新被建议，#17 重新配对 |
| U3 | 按 joint → overlap → me → cba 导入，做完 CBA 的两步手动操作 | 撤销 cba | 弹窗：手动改过 2 笔（#3、#15）。确认后删除 CBA 的 20 笔。Joint #11：`****0003` 对上 CBA Female → 保持 auto，只清空配对 |
| U4 | 空数据库，只导入 joint → cba | 撤销 joint | CBA #10：重跑 R6.1 认不出（PayID，没有账号）→ `none`，Uncategorised，`category_source = system`，Female（account），配对清空 |
|    |  | 再导入 joint | #11 和 CBA #10 重新配对，CBA #10 变回 auto + Internal transfer |
| U5 | 导入 joint → overlap → me，确认 #7 和 PAYID PAYMENT 的建议 | 撤销 me | 弹窗：手动改过 1 笔（PAYID PAYMENT，确认后是 manual）。Joint #7：`confirmed` → `none`，Uncategorised，`category_source = system`，配对清空 |
| U6 | 做完 P1 到 P6 那组导入 | 撤销 joint | 弹窗：确认的 pending 2 笔。P1、P2 恢复成 pending，日期保留银行的（09-22、09-20），`dedupe_key`、`import_batch_id`、`confirmed_at` 清空；17 笔新增的删除 |

每个用例做完，检查没有任何交易的 `transfer_pair_id` 指向已经删除的交易。
