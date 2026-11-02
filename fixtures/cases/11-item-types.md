# 小票商品类型用例（R21，M7.6）

> 测试数据的一部分。格式、家庭配置（账户、卡、成员）、文件清单见 [`fixtures/README.md`](../README.md)，写测试前先看那里。
> 前提：看各用例自己的前提。规则见 `docs/rules/R21-item-type.md`。

用 `fixtures/receipts/` 已有的假小票（R20 用例的那几张），加上几张直接写在这里的编的小票（测试里现拼，不新加 fixture 文件）。商品名都是编的通用词，不是真小票上的。

金额写成元方便看，测试里都是整数分。"学习表"写成 `name_key → type`，空表就是没学过。来源：`learned` / `preset` / `default` / `follow`（R21.3、R21.4）。

---

## 匹配（M7.6-2，纯函数）

### T-1 单个商品名（`matchItemType`）

| # | 商品名 | 学习表 | 类型 | 来源 |
| --- | --- | --- | --- | --- |
| 1 | `BANANAS PERKG` | 空 | `fruit` | preset |
| 2 | `GIFT CARD ****5678` | 空 | `other` | default |
| 3 | `EGGPLANT` | 空 | `vegetable` | preset（`EGGPLANT` 比 `EGG` 长） |
| 4 | `ICE CREAM VANILLA` | 空 | `snack` | preset（`ICE CREAM` 比 `CREAM` 长） |
| 5 | `PEANUT BUTTER` | 空 | `pantry` | preset（比 `BUTTER` 长） |
| 6 | `APPLE JUICE` | 空 | `drink` | preset（一样长，`JUICE` 在后面） |
| 7 | `CHICKEN STOCK` | 空 | `meat` | preset（`CHICKEN` 比 `STOCK` 长） |
| 8 | `CHICKEN STOCK` | `CHICKEN STOCK → pantry` | `pantry` | learned（学到的优先于预置） |
| 9 | `  chicken   stock ` | `CHICKEN STOCK → pantry` | `pantry` | learned（规范化后相同） |
| 10 | `CHICKEN STOCK 1L` | `CHICKEN STOCK → pantry` | `meat` | preset（不完全相同，学习不命中） |
| 11 | `EGGPLANT` | `EGGPLANT → other` | `other` | learned（学成 other 也压住预置） |

另外检查：预置关键词表里没有一个词出现在两个类型里。

### T-2 `coles-a.json`（`assignItemTypes`，学习表空）

| 商品 | 金额 | 类型 | 来源 |
| --- | --- | --- | --- |
| MILK 3L | 4.50 | `dairy_egg` | preset |
| BANANAS PERKG | 3.20 | `fruit` | preset |
| KIWIFRUIT GOLD | 6.80 | `fruit` | preset |
| KIWIFRUIT 4 FOR $6 | -0.80 | `fruit` | follow（负数跟上一件） |
| PAPER TOWEL 2PK | 6.00 | `household` | preset |
| DISHWASHING LIQUID | 9.00 | `household` | preset |
| SHAMPOO 400ML | 12.00 | `household` | preset（LLM 给的分类是 Cosmetics & toiletries，类型照样是日用） |
| WHITE BREAD | 4.70 | `pantry` | preset |
| TASTY CHEESE | 13.00 | `dairy_egg` | preset |

### T-3 `coles-e.json`、`grocer-b.json`、`noisy.json`（学习表空）

| 小票 | 商品 → 类型 |
| --- | --- |
| `coles-e.json` | CARROTS 1KG → `vegetable`；RICE 2KG → `pantry`；EGGS 12PK → `dairy_egg`；YOGHURT 1KG → `dairy_egg` |
| `grocer-b.json` | RICE 5KG → `pantry`；LAUNDRY POWDER → `household`；TOOTHPASTE → `household` |
| `noisy.json`（R20.2 整理后） | `GIFT CARD ****5678` → `other`（default）；`WHITE BREAD` → `pantry` |

### T-4 负数商品（编的小票，学习表空）

| 商品 | 金额 | 类型 | 来源 |
| --- | --- | --- | --- |
| PROMO | -1.00 | `other` | default（第一行就是负数） |
| BANANA 1KG | 3.00 | `fruit` | preset |
| MEMBER SAVE | -0.50 | `fruit` | follow |
| ONLINE SAVE | -0.20 | `fruit` | follow（连续负数都跟最近的正数商品） |
| LETTUCE | 2.50 | `vegetable` | preset |

总额 3.80，`checkReceipt` 通过。

---

## 统计（M7.6-3，纯函数）

### S-1 不分摊（`coles-a.json`，类型同 T-2）

fruit 9.20、dairy_egg 17.50、household 27.00、pantry 4.70，合计 58.40 = 总额。

### S-2 整单折扣分摊（`grocer-b.json`，类型同 T-3）

- 按类型：pantry 20.00、household 13.33，S = 33.33，D = 1.00
- pantry 扣 `floor(100 × 2000 / 3333)` = 60，household 扣 `floor(100 × 1333 / 3333)` = 39，合计 99，余 1 分从最大的 pantry 扣
- 结果：pantry 19.39、household 12.94，合计 32.33 = 总额

### S-3 分摊一样大（编的小票）

商品 `BANANA 1KG` 5.00（`fruit`）、`BEEF MINCE 500G` 5.00（`meat`）、`GIFT BAG` 2.00（`other`），整单折扣 -1.00，总额 11.00。

- fruit 扣 41、meat 扣 41、other 扣 16，合计 98，余 2 分；fruit 和 meat 一样大，取先出现的 fruit
- 结果：fruit 4.57、meat 4.59、other 1.84，合计 11.00

### S-4 负数类型不报错（T-4 的小票）

other -1.00、fruit 2.30、vegetable 2.50，合计 3.80。other 是负数照样输出。

### S-5 旧小票没类型

| 小票（`parsed_json` 里 items 都没有 `type`） | 结果 |
| --- | --- |
| `coles-a.json` | untyped 58.40 |
| `grocer-b.json` | untyped 32.33 |
| `coles-a.json`，只有 TASTY CHEESE 有 `dairy_egg` | dairy_egg 13.00、untyped 45.40 |
| `coles-a.json`，只有 KIWIFRUIT GOLD 和后面的 -0.80 有 `fruit` | fruit 6.00、untyped 52.40 |
| `grocer-b.json`，只有 RICE 5KG 有 `pantry` | pantry 19.39、untyped 12.94（`untyped` 当一组参加分摊） |

untyped 和 other 是两行，不合并。

### S-6 按月、只算挂上的

小票（类型同 T-2、T-3）：

| 小票 | receipt_date | 挂的交易 |
| --- | --- | --- |
| `coles-a.json` | 2026-08-31 | joint #19（交易日期 2026-09-01） |
| `grocer-b.json` | 2026-09-25 | 一笔 -32.33 |
| `coles-e.json` | 2026-09-28 | 没挂上（`transaction_id` 空） |

期望：

| 月份 | 类型 → 金额 |
| --- | --- |
| 2026-08 | fruit 9.20、dairy_egg 17.50、pantry 4.70、household 27.00（按 `receipt_date`，不按交易的 09-01） |
| 2026-09 | pantry 19.39、household 12.94（`coles-e` 没挂上，不算） |

再把 `coles-e.json` 挂上：2026-09 变成 vegetable 2.50、dairy_egg 14.95、pantry 25.39、household 12.94。

`coles-a.json` 挂到一笔 -59.28 的交易（R-C）：2026-08 还是合计 58.40，差额 0.88 不进任何类型。

---

## 学习（M7.6-4、M7.6-5，要数据库）

前提：空数据库按 `fixtures/README.md` 建好家庭。小票 X：`CHICKEN STOCK` 4.00、`BANANA 1KG` 3.00，总额 7.00，现金。

| # | 操作 | 期望 |
| --- | --- | --- |
| L-1 | 扫 X：默认 CHICKEN STOCK `meat`、BANANA 1KG `fruit`。把 CHICKEN STOCK 改成 `pantry`，保存 | 学习表一行 `CHICKEN STOCK → pantry`；BANANA 1KG 没写 |
| L-2 | 接 L-1，再扫一张有 `chicken  stock` 的小票 | 默认 `pantry`（learned） |
| L-3 | 接 L-1，再扫 X，什么都不改，保存 | 学习表没变（还是一行） |
| L-4 | 接 L-1，再扫 X，把 CHICKEN STOCK 改成 `other`，保存 | 还是一行，变成 `CHICKEN STOCK → other` |
| L-5 | 空学习表，一张小票里 CHICKEN STOCK 出现两次，第一件改 `pantry`、第二件改 `snack`，保存 | 一行 `CHICKEN STOCK → snack`（后面的为准） |
| L-6 | 空学习表，扫 `coles-a.json`，把 KIWIFRUIT GOLD 改成 `snack`，保存 | `parsed_json` 里 KIWIFRUIT GOLD 和 -0.80 都是 `snack`；学习表只有 `KIWIFRUIT GOLD → snack`，没有 `KIWIFRUIT 4 FOR $6` |
| L-7 | 客户端提交时 -0.80 那行传 `meat`，KIWIFRUIT GOLD 传 `fruit` | 存的 -0.80 是 `fruit`（服务器重算负数行） |
| L-8 | L-1 的保存中途抛错 | 小票没存，学习表也没写 |
| L-9 | L-1 以后，另一个家庭扫 X | 默认 CHICKEN STOCK 还是 `meat` |

## 详情页改类型（M7.6-6）

| # | 前提 | 操作 | 期望 |
| --- | --- | --- | --- |
| D-1 | R-A 做完，小票是旧的（`parsed_json` 没 `type`） | 详情页显示每件"未分"；把 TASTY CHEESE 改成 `dairy_egg` | 只有 TASTY CHEESE 多了 `type`；拆分、交易和 R-A 一样；学习表 `TASTY CHEESE → dairy_egg`（原来没类型也算改了）；统计同 S-5 第 3 行 |
| D-2 | 同 D-1 | 把 KIWIFRUIT GOLD 改成 `fruit` | KIWIFRUIT GOLD 和 -0.80 都有 `fruit`，别的件没有；统计同 S-5 第 4 行 |
| D-3 | R-A 做完，小票有类型（同 T-2） | 把 SHAMPOO 400ML 改成 `other` | 学习表 `SHAMPOO 400ML → other`；统计 household 15.00、other 12.00；拆分还是 -12.00 Cosmetics & toiletries Male |
| D-4 | 同 D-3 | 把 MILK 3L 选成 `dairy_egg`（和原来一样） | 学习表不写 |

## 拆分不变（M7.6-5）

| # | 期望 |
| --- | --- |
| P-1 | R-A、R-B、R-E（`09-receipts.md`）带上类型保存：拆分、交易和原来的期望完全一样 |
| P-2 | `coles-a.json` 每件类型都改成 `other` 再算 `planReceiptSplits`：结果和 R-A 一样 |

所有用例做完，检查学习表的 `name_key` 里没有 8 位以上连续数字（R20.2 已经脱敏）。
