# R20. 小票识别（2026-10-27 新增）

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

拍一张小票（或粘贴识别出来的文字），按分类拆到对应的交易上（F10 / R15）。分工：

- **读小票**由一个可以替换的 reader 做（R20.1），有用 AI 的和不用 AI 的，用哪个由配置决定。reader 只负责把小票变成统一格式的原始结果，商品分类也只是建议，用户在核对界面确认或改
- **钱的计算全部是纯函数**：金额转换、合计校验、折扣分摊、拆分、匹配（R20.2 到 R20.5），和用哪个 reader 无关，能写测试，每次结果一样
- reader 失败（LLM 停了、额度用完、格式不对、文字解析不出来）：核对界面显示"暂时识别不了"，商品表是空的，可以手动填，其他功能不受影响

## R20.1 reader 和原始结果

**原始结果**（所有 reader 返回同一个格式，Zod 校验，不通过当作识别失败）：

| 字段 | 内容 |
| --- | --- |
| merchant | 店名，原样 |
| date | 小票日期，原样字符串（如 `24/10/2026`、`24/10/26`），由 R20.2 转换 |
| total | 总额，原样字符串（如 `46.12`、`$46.12`） |
| items | `[{ name, amount, category }]`。`amount` 原样字符串，单件折扣是负数；`category` 是分类列表里的一个字符串，或 `null`（跟主分类，见 R20.3） |
| discounts | 整单折扣 `[{ label, amount }]`，`amount` 是负数字符串。没有就是空数组 |
| payment | `{ method: card / cash / unknown, cardLast4: 4 位数字或 null }` |

不管哪个 reader，原始结果里都**没有人名**（顾客、收银员、店长）、终端号、ABN、电话，多出来的字段 Zod 直接丢掉。`cardLast4` 只在内存里给 R20.4、R20.5 用，**不入库**，不写进 `parsed_json`，也不写进交易的 `card_last4`。**图片不保存**，粘贴的文字也不保存，只存 R20.2 整理后的结果。

**reader**（配置 `RECEIPT_READER` 选一个，tech-stack 11.3）：

| reader | 输入 | 用 AI | 分类建议 |
| --- | --- | --- | --- |
| `llm` | 照片 | 是，OpenAI 兼容接口的看图模型，换服务商只改环境变量 | 有 |
| `text` | 粘贴的文字（手机自带的识别文字功能复制出来的） | 否，确定性解析（R20.1b） | 没有，都是 `null` |
| `none` | 无 | 否 | 没有。直接打开空的商品表手动填 |

以后加别的（比如浏览器里本地 OCR），只要返回同样的原始结果就行，R20.2 以后不用改。

## R20.1a `llm` reader

**发出去**：一张图片（浏览器里先压缩成 JPEG，长边不超过 1600px、不超过 1MB），加上本家庭能选的支出分类列表（R16.3 范围内 kind = expense 的二级，格式 `一级 / 二级`）。不发账户、交易、金额、日期，不发其他任何数据。

提示词要求：

- 称重、数量明细行（`0.581 kg NET @ $4.90/kg`、`4 @ $1.70 EACH`）不算商品
- 称重、数量明细行末尾有价格时（Woolworths 的排法：`Papaya Red` 下一行 `1.367 kg NET @ $5.90/kg  8.07`），这个价格是上一行商品的金额（2026-10-29 补）
- 单件折扣（`GOLD KIWIFRUIT 4 FOR $6 -$0.80`）作为负数商品，紧跟在被折扣的商品后面
- 整单折扣（`DISCOUNT -$2.04`）放 `discounts`，不放 `items`
- GST、付款方式、找零、积分行不算商品
- 不返回人名、终端号、ABN、电话
- 食品类商品 `category` 给 `null`，只有明显不属于这家店主分类的（日用品、化妆品、药、酒等）才给分类

**隐私**（prd 第 4 节"AI 功能"的例外）：小票图片里有金额、日期、店名，可能还有卡号后 4 位和人名，整张图会发给服务商，没法只发一部分。所以只用不拿数据训练的服务商（tech-stack 11.1）。不想发图就用 `none`（`text` 不做了，见 R20.1b）。

## R20.1b `text` reader（不做，2026-10-29 实验结果）

用户在手机上用自带的识别文字功能（iPhone 实况文本、安卓 Google Lens）复制小票文字，粘贴进来。解析器是纯函数，按行处理：

- 行尾是金额（`6.75`、`$7.99`、`-$0.80`）的算一件商品，前面的部分是名字；名字前的 `*`、`(-%)` 这类标记去掉
- 只有数量、重量明细的行（含 `kg NET @`、`@ $x EACH`）跳过
- 负数行是单件折扣
- `DISCOUNT` 开头的行是整单折扣；`TOTAL`、`Total for` 开头的行是总额；`SUB TOTAL`、`GST`、`EFT`、`VISA`、`BALANCE`、`CHANGE` 这些行不算商品
- 日期：第一个 `DD/MM/YYYY` 或 `DD/MM/YY`；店名：第一个不是空行的行
- 付款：有 `EFT`、`VISA`、`MASTERCARD`、`DEBIT`、`CREDIT` → card，`*****` 或 `****` 后面的 4 位数是 `cardLast4`；有 `CASH` → cash；都没有 → unknown
- 解析不出总额或一件商品都没有 → 识别失败

**前提**：复制出来的文字里，商品名和价格在同一行。如果手机把名字和价格分成两列，这个 reader 做不了，先不做。

**2026-10-29 实验结果：前提不成立，M6.7-5b 不做。** 用 iPhone 实况文本复制 Woolworths 小票：

- 左右两列被拆开：先是一串名字（`TOTAL`、`EFT`、`Change`），后面才是一串金额，对不上是哪一行的
- 商品区大部分行直接丢了，只剩一行商品名，没有价格

以下留给以后改用别的 OCR（比如浏览器里本地 OCR）时参考，现在不实现：

- 纸面上称重商品有两种排法：Coles 价格在名字那行，称重行没价格；Woolworths 名字那行没价格，价格在称重行（`1.367 kg NET @ $5.90/kg  8.07`）
- Woolworths 的商品名前有 `#`（含 GST 的商品），小计行是 `6 SUBTOTAL`（前面带件数），卡号是 `CARD:............0866`，付款区还会再出现一次 `TOTAL` 和 `PURCHASE`，底部有 `TOTAL includes GST`

## R20.2 整理和校验

reader 的原始结果（或用户在核对界面改过的）先整理：

- 金额字符串 → 整数分：去掉 `$` 和空格，`-$0.80`、`$-0.80`、`-0.80` 都是 -80。用 `money.ts` 的字符串口径，**不用 `parseFloat`**。格式不对就标在那一行上
- 日期：`DD/MM/YYYY` 和 `DD/MM/YY`（两位年份当 20YY），转成 `YYYY-MM-DD`。不能晚于今天（`Australia/Melbourne`）。读不出来就空着让用户填
- 店名、商品名、折扣名：去首尾空格，最长 100 字符，再按 R2.3 脱敏（8 位以上连续数字）
- `category` 不在分类列表里（LLM 编出来的、分类已归档）→ 当作 `null`，不报错
- 核对界面里手动填的商品走同样的整理和校验

能保存的条件（`checkReceipt`）：

- 总额 > 0（退货小票不做）
- 至少一件商品，每件金额 ≠ 0
- 整单折扣都 < 0
- **商品合计 + 整单折扣 = 总额**，差一分也不行。对不上时核对界面显示"差 $X"，保存按钮不能点，用户改到对上为止
- 日期有值

## R20.3 生成拆分

输入：整理好的小票、要挂上的交易（R20.4 匹配到的，或 R20.5 新建的）。交易的**主分类** = 当前主拆分的分类。

1. **每件商品的分类**：`category` 有值就用；`null` 跟主分类。负数商品（单件折扣）默认跟上一件商品的分类，第一行就是负数时跟主分类。核对界面上每一行都能改
2. **按分类合计**（小票方向，正数）
3. **整单折扣按比例分摊**：总折扣 D（取绝对值），商品合计 S，每组 g：先给每组 `floor(D × g / S)` 分，余下的几分给 g 最大的一组；一样大时主分类那组优先，再按商品顺序第一个出现的
4. **差额**：交易金额的绝对值 − 小票总额
   - = 0：不处理
   - \> 0（刷卡手续费、收银时取现等）：多出来的单独一组，分类未分类（system: uncategorized）。已经有未分类的一组就合进去
   - < 0：报错"小票合计比这笔交易多 $X，不支持"，不保存（可能是一部分用了别的方式付）
5. 分摊以后某组 ≤ 0：报错"X 合计不是正数，检查折扣跟在哪件商品后面"，不保存。= 0 的组不可能出现（每件 ≠ 0，负数组会报错），所以不用特别处理
6. **哪组当主拆分**：和主分类相同的那组；没有就取金额最大的一组（一样大取先出现的）
7. 写拆分（金额按交易符号，支出是负数）：
   - 主拆分：更新原来那行（id 不变）。分类没变 → `category_source` 不变；分类变了 → `manual`，归属人按 R5.1（`manual` 的不动）。备注保留
   - 其他组：新建拆分，`is_primary = false`。`category_source = manual`（用户在核对界面确认过），差额那组是 `system`；归属人按 R5 算（分类默认 > 卡号 > 账户），没有手动指定；`is_pre_tax` 按分类默认
   - 原来的非主拆分全部删掉（只有 R20.6 确认覆盖后才会有）
8. 合计永远等于交易金额（R15.1）

只有一组时（比如整张都是食品），结果就是交易不变，只多挂了一张小票。

## R20.4 匹配交易

从悬浮 + 按钮"拍小票"进来时，在本家庭找候选：

- `amount_cents` = −总额
- 交易日期 − 小票日期 ∈ [0, 3] 天（和 R8.2 一样，银行入账不早于消费）
- `transfer_status = none`（转账不能拆，R15.2；`suggested` 的也不要）
- 还没挂小票
- `pending`、`confirmed` 都算（包括手动录入的这笔消费）
- 卡号：小票有 `cardLast4`，并且本家庭 `card` 表里有这个尾号 → 只在这些卡所在的账户里找，交易的 `card_last4` 不为空时必须相同。`card` 表里没有这个尾号就不按卡号过滤

排序（给用户看的）：`card_last4` 和小票相同的在前；merchant 包含小票店名建议关键词（R3 清洗后取 R13 `suggestKeyword`，不区分大小写）的在前；再按日期差从小到大。

| 候选数 | 处理 |
| --- | --- |
| 0 | 按 R20.5 新建 |
| 1 | 默认选中，用户可以改成"新建"（R20.5） |
| ≥ 2 | 列出来让用户选，不默认选；也可以选"都不是，新建" |

从**交易详情**"上传小票"进来时，交易已经定了，不找候选、不检查日期，直接按 R20.3 处理（差额按第 4 步）。这个按钮只在支出、`transfer_status = none`、还没挂小票的交易上出现。

## R20.5 没有匹配时新建交易

小票通常当天拍，银行流水要过几天才导入，所以刷卡的小票不能直接记成现金：

| payment | 账户 |
| --- | --- |
| card，`card` 表里有这个尾号 | 默认选卡所在的账户（多个账户有同一个尾号时让用户选） |
| card，没有尾号或表里没有 | 用户选，默认 R17.2 的上次账户 |
| cash | 用户选，默认第一个没归档的现金账户 |
| unknown | 用户选，默认 R17.2 的上次账户 |

新交易：

- `status` 按账户走 R8.1：ANZ、CBA → `pending`，等导入 CSV 时按 R8.2 确认；现金、ANZ Plus → `confirmed`
- `source = receipt`，`date` = 小票日期，`amount_cents` = −总额
- `raw_description` = 店名（R20.2 整理后），`merchant` = R3 清洗结果
- `card_last4` 空（同 R17.1，银行流水确认时 R8.3 再填）
- 主分类：对 merchant 跑 R7 第 2、3 步（同 R17.2 猜分类），没命中就是未分类，`category_source` 按 R17.3
- 不跑 R6.1（同 R17.1）
- 然后按 R20.3 拆分

## R20.6 交易已经改过

要挂上的交易满足下面任何一条，算"已经改过"：

- 有多个拆分
- 主拆分的 `category_source = manual`

这时保存前弹窗："这笔已经手动改过（拆分 N 条 / 手动改过分类），用小票的结果覆盖吗？原来的拆分会删掉，主拆分的备注保留。" 确认后按 R20.3 重新拆；取消就不保存，回到核对界面。

## R20.7 和其他规则的关系

- **一张小票只能挂一笔交易，一笔交易只能挂一张小票**（`receipt.transaction_id` 唯一）
- **重复上传**：本家庭已有小票的店名（清洗后）、日期、总额都相同 → 核对界面提示"可能已经上传过"，不拦
- **R7.2 重新应用规则**：多个拆分的跳过，照旧。只有一组的小票交易不受影响
- **R8.2、R8.3**：R20.5 建的 pending 和手动录入的一样参加匹配；确认时拆分保留，`source` 保留 `receipt`，小票照样挂着
- **R12.1 撤销导入**：
  - 被删的交易挂了小票 → 小票脱开（`transaction_id` 变空，外键 `on delete set null`），变回"没挂上"的状态，可以重新匹配
  - 被确认的 pending 恢复成 pending → 小票照样挂着
  - 撤销前的弹窗里，"手动改过"的计数加一项"挂了小票 N 笔"
- **R17.5 编辑和删除**：`source = receipt` 的和 `source = manual` 的一样处理（还没被导入确认时能改、能删）。删除后小票脱开
- **R15**：保存以后拆分就是普通拆分，在详情页照常改。改拆分不改小票的 `parsed_json`
- **删除小票**：交易详情里能删掉小票，只删 `receipt` 那行，拆分不动
- **没挂上的小票**：F8 顶部提示"N 张小票没挂上交易"，点开列出来，每张能重新按 R20.4 匹配或 R20.5 新建
- **统计**（R10、R11、R14）按拆分算，不用改

## R20.8 例子

用 `fixtures/receipts/` 的假数据（不是真小票），家庭配置同 `fixtures/README.md`。期望值也写在 fixtures/README 的"小票用例"一节。

**R-A：匹配 + 单件折扣**（`coles-a.json`，先导入 `joint-2026-09.csv`）

小票 COLES，`31/08/2026`，card `1111`，总额 58.40：

| 商品 | 金额 | LLM 建议 | 用的分类 |
| --- | --- | --- | --- |
| MILK 3L | 4.50 | null | 主分类 |
| BANANAS PERKG | 3.20 | null | 主分类 |
| KIWIFRUIT GOLD | 6.80 | null | 主分类 |
| KIWIFRUIT 4 FOR $6 | -0.80 | null | 跟上一件 → 主分类 |
| PAPER TOWEL 2PK | 6.00 | Home & utilities / Household supplies | Household supplies |
| DISHWASHING LIQUID | 9.00 | Home & utilities / Household supplies | Household supplies |
| SHAMPOO 400ML | 12.00 | Personal & medical / Cosmetics & toiletries | Cosmetics & toiletries |
| WHITE BREAD | 4.70 | null | 主分类 |
| TASTY CHEESE | 13.00 | null | 主分类 |

- R20.2：合计 58.40 = 总额，能保存
- R20.4：候选只有 joint #19（-58.40，09-01，相差 1 天，卡 1111）→ 默认选中
- R20.3 结果（#19 主分类 Groceries / Supermarket）：

| 拆分 | 金额 | 分类 | 归属人 | category_source |
| --- | --- | --- | --- | --- |
| 主 | -31.40 | Groceries / Supermarket | Home（category） | 不变（`rule`） |
| | -15.00 | Home & utilities / Household supplies | Home（category） | manual |
| | -12.00 | Personal & medical / Cosmetics & toiletries | **Male（card 1111）** | manual |

**R-B：整单折扣分摊**（`grocer-b.json`，纯函数，交易 -32.33，主分类 Groceries / Supermarket）

小票 SUNNY GROCER，总额 32.33：商品 RICE 5KG 20.00（主分类 Groceries / Supermarket）、LAUNDRY POWDER 10.00（Household supplies）、TOOTHPASTE 3.33（Cosmetics & toiletries），整单折扣 -1.00。

- 合计 33.33 − 1.00 = 32.33，能保存
- 分摊：20.00 组 `floor(100 × 2000 / 3333)` = 60，10.00 组 30，3.33 组 9，合计 99，余 1 分给最大的一组
- 结果：主拆分 -19.39 Supermarket，-9.70 Household supplies，-3.24 Cosmetics & toiletries，合计 -32.33

**R-C：差额**（`coles-a.json`，从交易详情上传到一笔 -59.28 的交易）

- 差额 0.88 > 0 → 多一组 -0.88 未分类（`system`），归属人按 R5（未分类没有分类默认 → 卡号 / 账户）
- 同一张小票上传到一笔 -50.00 的交易 → 报错"小票合计比这笔交易多 $8.40，不支持"

**R-D：合计对不上**（`bad-total.json`）

- 商品合计 30.00，总额 31.00 → `checkReceipt` 失败，"差 $1.00"，不能保存

**R-E：没有匹配，新建 pending**（`coles-e.json`，空数据库）

小票 COLES，`28/09/2026`，card `2222`，总额 23.45，商品都是 `null`：

- R20.4：没有候选
- R20.5：卡 2222 在 ANZ Joint 上 → 默认 ANZ Joint，`pending`，`source = receipt`，日期 2026-09-28，-23.45，`card_last4` 空
- 主分类：merchant `COLES` 命中预置规则 → Groceries / Supermarket，`category_source = rule`；归属人 Home（category）。只有一组，就是一个主拆分
- 之后导入一行 `2026-09-29 -23.45 VISA DEBIT PURCHASE CARD 2222 COLES 0559 MELBOURNE`（测试里现拼的 CSV，不新加 fixture 文件）→ R8.2 确认这笔 pending，`source` 还是 `receipt`，小票还挂着
