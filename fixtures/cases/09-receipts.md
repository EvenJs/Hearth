# 小票用例（R20，M6.7）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。

`receipts/` 里的 `.json` 是**假的** reader 原始结果（R20.1 的格式，金额、日期都是原样字符串），测试里用假 reader 直接返回它们；不是真小票，也没有图片。照着真小票的几种格式编的：称重行（已经去掉）、单件折扣、整单折扣。真实小票只在 `tests/local/` 里试，不提交。

| 文件 | 内容 | 用在 |
| --- | --- | --- |
| `coles-a.json` | COLES，`31/08/2026`，card `1111`，总额 `$58.40`，9 件，含单件折扣 `-$0.80` | R-A、R-C |
| `grocer-b.json` | SUNNY GROCER，`25/09/2026`，card `null`，3 件 + 整单折扣 `-$1.00`，总额 `$32.33` | R-B |
| `bad-total.json` | 商品合计 `30.00`，总额 `31.00` | R-D |
| `coles-e.json` | COLES，`28/09/2026`，card `2222`，总额 `$23.45`，商品分类都是 `null` | R-E |
| `coles-a.txt`、`grocer-b.txt` | 假的"手机识别文字"，内容和对应的 `.json` 一样（M6.7-5b，`text` reader 做了才加） | R20.1b |
| `noisy.json` | 多返回了 `customer: "TEST CUSTOMER"`、`cashier`、商品名里有 `12345678` | R20.1、R20.2：多的字段被 Zod 丢掉；8 位数字脱敏成 `****5678` |

期望值见 `business-rules.md` R20.8，汇总：

| 用例 | 前置 | 期望 |
| --- | --- | --- |
| R-A | 导入 `joint-2026-09.csv` | 候选只有 #19，默认选中。#19 拆成：主 -31.40 Groceries / Supermarket，Home（category），`category_source` 还是 `rule`；-15.00 Household supplies，Home（category），manual；-12.00 Cosmetics & toiletries，Male（card 1111），manual |
| R-A' | R-A 做完，再导入 `coles-a.json` 一次 | 提示"可能已经上传过"；候选 0 笔（#19 已经挂了小票） |
| R-B | 纯函数，交易 -32.33，主分类 Groceries / Supermarket | 主 -19.39、Household supplies -9.70、Cosmetics & toiletries -3.24 |
| R-C | 纯函数，`coles-a.json` 挂到 -59.28 | 多一组 -0.88 未分类（`system`）；挂到 -50.00 报错"小票合计比这笔交易多 $8.40" |
| R-D | 纯函数 | `checkReceipt` 失败，差 $1.00 |
| R-E | 空数据库 | 新建 ANZ Joint pending，`source = receipt`，2026-09-28，-23.45，Groceries / Supermarket（rule），Home（category），`card_last4` 空；再导入一行 `2026-09-29 -23.45 ... CARD 2222 COLES 0559 MELBOURNE` → 这笔 pending 被确认，`source` 还是 `receipt`，小票还挂着 |
| R-U | R-A 做完 | 撤销 joint 导入：弹窗写"挂了小票 1 笔"；确认后小票 `transaction_id` 变空；再导入 joint，小票能重新挂到新的 #19 |

所有用例做完，检查 `receipt.parsed_json` 里没有 `1111`、`2222` 这些卡号，没有人名字段。
