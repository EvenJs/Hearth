# 期望结果：再导入 `joint-2026-09-overlap.csv`

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：第 2 步，接 01。

| 行                                    | 结果                                            |
| ------------------------------------- | ----------------------------------------------- |
| 08/10 WOOLWORTHS（卡 2222）           | 新增，Groceries / Supermarket，Home（category） |
| 03/10 FROM \*\*\*\*0002               | 新增，Internal transfer，auto                   |
| 30/09 两行费用、29/09 BPAY、25/09 ATM | 跳过（重复）                                    |
| 28/09 GONG CHA 第 1、2 笔             | 跳过（重复）                                    |
| 28/09 GONG CHA 第 3 笔                | **新增**（occurrence=3），Male（card）          |

计数：`row_count = 9`、`inserted_count = 3`、`duplicate_count = 6`。
