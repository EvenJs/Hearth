# R21. 小票商品类型（2026-11-01 新增）

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

小票上每件商品有一个**商品类型**（水果、肉、零食……），用来按月看各类型花了多少（M7.6）。

- 类型只存在小票明细里（`receipt.parsed_json` 的 items），**不在拆分上**，不参与 R20.3，不影响分类、看板其他数字、预算、税
- 类型和分类是两回事，互不推导：LLM 给了分类的商品（洗发水 → Cosmetics & toiletries）照样有类型（日用）；类型改了不改分类，分类改了不改类型
- 不用 AI：预置关键词 + 从用户手动修改里学（思路同 R7、R13）。LLM reader 不给类型，prompt 不改（R20.1a）
- 每件商品都有类型，认不出来就是"其他"。只有 M7.6 以前存的旧小票没有类型（"未分"，R21.6）

## R21.1 类型列表

代码里是固定的 key，中文名只在界面上显示。列表只写在 `src/lib/rules/item-type.ts` 一处，按下面的顺序（下拉、统计都按这个顺序）：

| key | 中文名 | 例子 |
| --- | --- | --- |
| `fruit` | 水果 | 香蕉、奇异果 |
| `vegetable` | 蔬菜 | 生菜、土豆 |
| `meat` | 肉 | 肉末、鸡腿 |
| `seafood` | 海鲜 | 三文鱼、虾 |
| `dairy_egg` | 乳制品和蛋 | 牛奶、奶酪、鸡蛋 |
| `pantry` | 主食干货 | 米、面、面包、罐头、调料酱料 |
| `snack` | 零食 | 薯片、饼干、巧克力 |
| `drink` | 饮料 | 果汁、汽水、酒 |
| `household` | 日用 | 纸巾、洗洁精、洗发水、牙膏、药 |
| `other` | 其他 | 都没认出来的 |

- 不单独分面包、冷冻、个护和药。冷冻的按食物本身归（冷冻虾 → 海鲜，速冻饺子 → 主食干货，冰淇淋 → 零食）
- 统计里另有一行"未分"（key `untyped`），**不是类型**，下拉里没有，只表示旧小票没存类型（R21.6）

## R21.2 预置关键词

写在代码里（`item-type.ts`），不进数据库，不能在界面上改。都是通用英文词，**不从真实小票抄整行**。关键词存大写，对规范化后的商品名（R21.3）做**包含**匹配（同 R7 的 `contains`）。

| 类型 | 关键词 |
| --- | --- |
| `fruit` | `BANANA` `APPLE` `KIWI` `ORANGE` `MANDARIN` `GRAPE` `STRAWBERR` `BLUEBERR` `RASPBERR` `MANGO` `PEAR` `PEACH` `PLUM` `CHERR` `LEMON` `LIME` `AVOCADO` `WATERMELON` `MELON` `PINEAPPLE` |
| `vegetable` | `LETTUCE` `POTATO` `TOMATO` `ONION` `CARROT` `BROCCOLI` `CABBAGE` `CUCUMBER` `CAPSICUM` `SPINACH` `MUSHROOM` `ZUCCHINI` `PUMPKIN` `BUTTERNUT` `CELERY` `GARLIC` `GINGER` `BOK CHOY` `EGGPLANT` `ASPARAGUS` |
| `meat` | `BEEF` `PORK` `LAMB` `CHICKEN` `MINCE` `STEAK` `SAUSAGE` `BACON` `SALAMI` `THIGH` `DRUMSTICK` |
| `seafood` | `SALMON` `PRAWN` `SHRIMP` `TUNA` `FISH` `BARRAMUNDI` `SQUID` `MUSSEL` `OYSTER` |
| `dairy_egg` | `MILK` `CHEESE` `YOGHURT` `YOGURT` `BUTTER` `CREAM` `EGG` |
| `pantry` | `RICE` `PASTA` `SPAGHETTI` `NOODLE` `FLOUR` `BREAD` `SUGAR` `SALT` `OLIVE OIL` `CANOLA` `VINEGAR` `SAUCE` `STOCK` `CEREAL` `OATS` `DUMPLING` `TOFU` `TORTILLA` `HONEY` `PEANUT BUTTER` `COCONUT MILK` `BAKED BEANS` `OYSTER SAUCE` `FISH SAUCE` `TOMATO SAUCE` |
| `snack` | `CHIPS` `POTATO CHIP` `BISCUIT` `COOKIE` `CHOC` `CHOCOLATE` `CANDY` `LOLLIES` `ICE CREAM` `CRACKER` `POPCORN` `MUESLI BAR` |
| `drink` | `JUICE` `WATER` `SODA` `COLA` `SOFT DRINK` `BEER` `GINGER BEER` `WINE` `COFFEE` `KOMBUCHA` `LEMONADE` |
| `household` | `TISSUE` `TOILET` `PAPER TOWEL` `DISHWASH` `DETERGENT` `LAUNDRY` `BLEACH` `SPONGE` `FOIL` `CLING WRAP` `GARBAGE BAG` `SHAMPOO` `CONDITIONER` `TOOTHPASTE` `TOOTHBRUSH` `SOAP` `BODY WASH` `DEODORANT` `NAPPIES` `BATTERY` `PARACETAMOL` `IBUPROFEN` |

- 一个关键词只能在一个类型里（测试检查没有重复）
- 有些长关键词专门用来压住短的误命中：`PEANUT BUTTER` 压 `BUTTER`，`ICE CREAM` 压 `CREAM`，`EGGPLANT` 压 `EGG`，`OYSTER SAUCE` 压 `OYSTER`，`GINGER BEER` 压 `GINGER`，`BUTTERNUT` 压 `BUTTER`
- 太短、容易误命中的词不放（如 `HAM` 会命中 `SHAMPOO`，`TEA` 会命中 `STEAK`，`OIL` 会命中 `TOILET`）。没认对的靠学习（R21.5）
- 以后加词直接改这张表和代码，加了只影响以后认的，已经存了类型的小票不重算

## R21.3 商品名规范化和匹配顺序

**规范化**（`normalizeItemName`）：复用 `normalizeKeyword`，去首尾空格、多个空格合成一个、转大写。输入是 R20.2 整理后的商品名（已经脱敏、最长 100）。学习表的 key 和预置匹配都用规范化后的名字。

**一件正数商品的类型**（`matchItemType`），按顺序，第一个命中的生效：

1. **学到的**（R21.5）：规范化后的名字和学习表里的 `name_key` **完全相同** → 学到的类型，来源 `learned`
2. **预置关键词**：规范化后的名字包含关键词 → 那个关键词的类型，来源 `preset`。多个命中时：
   - 关键词长的优先（同 R7）
   - 一样长时，在名字里**出现位置靠后**的优先（英文商品名中心词一般在后面：`APPLE JUICE` 取 `JUICE`）
   - 一样长又同一个位置就是同一个词，不会再有平局
3. 都没命中 → `other`，来源 `default`

**负数商品**（单件折扣）不按名字认，见 R21.4。

核对界面手动加的行，填完名字以后同样按上面的顺序认。reader 是 `none` 或识别失败手动填的，也一样。

## R21.4 一整张小票

`assignItemTypes(items, learned)`：按商品顺序给每一件定类型。

- 正数商品按 R21.3
- **负数商品跟它前面最近的一件正数商品的类型**（连续几行负数都跟同一件），来源 `follow`。第一行就是负数（前面没有正数商品）→ `other`，来源 `default`（同 R20.3 第 1 步的思路）
- 负数商品**没有自己的类型下拉**：核对界面和详情页上改了某件正数商品的类型，紧跟在它后面的负数行一起变。负数行的类型也存进 `parsed_json`，统计时直接读
- 保存时服务器按用户提交的正数商品类型重新算负数行，不用客户端传的负数行类型
- 整单折扣（`discounts`）没有类型，统计时按比例分摊（R21.7）

## R21.5 学习

学习表 `item_type_rule`（schema.md，M7.6-4 建）：一个家庭里一个 `name_key` 一行，存一个类型。

- **只在用户手动改了**某件正数商品的类型时写。自动认出来、用户没动的不写
- "改了"怎么判断：保存时服务器用当时的学习表再跑一次 `assignItemTypes`，用户提交的类型和自动给的不一样 → 改了。不信客户端传的"改没改"
- 写入：`(household_id, normalizeItemName(name))` 已有 → 覆盖成新类型（最后一次为准）；没有 → 新建。学成 `other` 也写（用来压住预置的误命中）
- 同一张小票里同名商品出现几次、改成了不同类型 → 按商品顺序，后面的为准
- 负数商品不学（它们不按名字认）
- 和小票保存在**同一个事务**里，保存失败就都不写
- 学错了：下次在核对界面或详情页改掉就覆盖。**不做**学习规则的管理页，也不能删
- 学习只影响以后认的类型，**不回头改**已经存了类型的小票

## R21.6 详情页改类型、旧小票

交易详情的小票明细里每件正数商品能改类型（下拉，R21.1 的 10 个）：

- 只改 `parsed_json` 里这一件的 `type`（和紧跟在后面的负数行，R21.4），**不改**金额、分类、拆分、交易
- 学习：和这件商品**原来存的类型**比，不一样就按 R21.5 写学习表。原来没类型（旧小票）也算改了
- 旧小票（M7.6 以前存的，items 没有 `type`）：详情页显示"未分"。改一件就只给这一件（和后面的负数行）补上类型，别的件还是没类型，**不自动补**
- 统计里没类型的件算"未分"（`untyped`），和"其他"分开

## R21.7 统计

`sumByItemType(receipts)`：输入几张小票（`receipt_date` + `parsed_json`），输出 `月份 × 类型 → 分`（正数，小票方向）。

- **范围**：本家庭、**挂上了交易的**小票（`transaction_id` 不为空）。没挂上的不算（可能是撤销导入留下的，挂回去再算；2026-10-31 定）。挂的是 pending 也算
- **月份**：按 `receipt_date` 的 `YYYY-MM`，不按交易日期
- **全家**：不分归属人（类型不在拆分上，没有归属人）
- **金额是小票上的**，不是交易的：R20.3 第 4 步的差额（刷卡手续费等）不算进任何类型
- **每张小票单独算**，再按月加起来：
  1. 按类型合计商品金额（负数商品已经带着类型，直接加）；没类型的件合计成 `untyped`
  2. **整单折扣按比例分摊**到各类型，写法同 R20.3 第 3 步（复用同一个函数）：总折扣 D（绝对值），商品合计 S，每组 g 先扣 `floor(D × g / S)` 分，余下的几分从 g 最大的一组扣；一样大时取商品顺序里第一个出现的（类型没有"主分类"）
  3. 每张小票各类型合计 = 小票总额，差一分也不行
- **不报错**：某个类型算出来是负数（比如第一行负数 → 其他，后面没有别的"其他"）就照样显示负数，合计还是对的。合计为 0 的类型不输出
- 页面上写明"只统计拍了小票的部分"。这里的数字和看板 Groceries 的支出不会一样（没拍小票的消费不在里面，日用、个护也在里面）

## R21.8 和其他规则的关系

- **R20.3**：`planReceiptSplits`、`checkReceipt` **不读类型**。同一张小票有没有类型、类型怎么改，拆分结果一个字都不变
- **R20.1、R20.2**：reader 原始结果里没有类型；R20.2 整理以后按 R21.4 填。保存的 `parsed_json` items 是 `{ name, amountCents, category, type }`，`type` 是 R21.1 的 key；旧数据没有 `type`，读的时候要能读
- **R20.6、R15**：改拆分不改类型；R20.6 覆盖重拆时类型按用户在核对界面提交的存
- **R20.7 删除小票、撤销导入**：小票删了它的类型就没了，学习表不动。小票脱开（`transaction_id` 变空）→ 不进统计，挂回去再进
- **R7、R13**：思路相同，表和代码分开：`category_rule` 管分类，`item_type_rule` 管类型，互不影响
- **R10、R11、R14**：按拆分算，不用改。商品类型统计是看板上单独一块，不进收支、预算、税

## R21.9 例子

商品名都是编的。期望值和更多用例见 `fixtures/cases/11-item-types.md`。

| 商品名 | 学习表 | 类型 | 来源 | 为什么 |
| --- | --- | --- | --- | --- |
| `BANANAS PERKG` | 空 | `fruit` | preset | 包含 `BANANA` |
| `GIFT CARD ****5678` | 空 | `other` | default | 没命中 |
| `EGGPLANT` | 空 | `vegetable` | preset | `EGGPLANT`（8）比 `EGG`（3）长 |
| `ICE CREAM VANILLA` | 空 | `snack` | preset | `ICE CREAM`（9）比 `CREAM`（5）长 |
| `APPLE JUICE` | 空 | `drink` | preset | `APPLE`、`JUICE` 一样长，`JUICE` 在后面 |
| `CHICKEN STOCK` | 空 | `meat` | preset | `CHICKEN`（7）比 `STOCK`（5）长（认错了，靠学习改） |
| ` chicken  stock ` | `CHICKEN STOCK → pantry` | `pantry` | learned | 规范化后完全相同，学到的优先于预置 |
| `CHICKEN STOCK 1L` | `CHICKEN STOCK → pantry` | `meat` | preset | 名字不完全相同，学习不命中 |

一张小票（`coles-a.json`）：`KIWIFRUIT GOLD` 6.80 → `fruit`，下一行 `KIWIFRUIT 4 FOR $6` -0.80 是负数 → 跟上一件 `fruit`。按类型合计：fruit 9.20、dairy_egg 17.50、household 27.00、pantry 4.70，合计 58.40 = 总额。

整单折扣（`grocer-b.json`，折扣 -1.00）：pantry 20.00、household 13.33 → 分摊 pantry 扣 `floor(100 × 2000 / 3333)` = 60、household 扣 39，余 1 分从最大的 pantry 扣 → pantry 19.39、household 12.94，合计 32.33。
