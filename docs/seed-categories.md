# Hearth 预置分类和规则

> seed 脚本按这份文档创建归属人、分类和规则。
> 分类列表是 2026-10-22 确定的版本，参考 Moneysmart Budget Planner 调整。
> 预置规则从 2026 年的真实 ANZ 和 CBA 流水整理，关键词匹配的是清洗后的 merchant（见 `business-rules.md` R3、R7）。
> 标了 ❓ 的是猜的，导入后看一眼，不对就改。

---

## 1. 归属人（钱用在谁身上）

| name   | kind   | 说明                     |
| ------ | ------ | ------------------------ |
| Male   | person | 我                       |
| Female | person | 老婆                     |
| Home   | shared | 家庭共同部分             |
| Kid    | child  | **先不建**，有孩子时再加 |

---

## 2. 支出分类（kind = expense）

每个一级分类都自动带一个 **Other** 二级（不在下表重复列出），放不进其他二级的先归到这里。

| 一级                        | 默认归属人 | 二级                                                                                                                                                                      |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home & utilities**        | Home       | Mortgage · Rent · Body corporate fees · Council rates · Furniture & appliances · Renovations & maintenance · Household supplies · Electricity · Water · Internet · Mobile |
| **Insurance & financial**   | Home       | Car insurance · Home insurance · Personal & life insurance                                                                                                                |
| **Groceries**               | Home       | Supermarket · Butcher · Fruit · Vegetable · Pet                                                                                                                           |
| **Personal & medical**      |            | Hair & beauty · Cosmetics & toiletries · Medicines & pharmacy · Hobbies · Clothing & shoes · Jewellery & accessories · Education · Computers & gadgets                    |
| **Entertainment & eat-out** |            | Coffee & tea · Lunches · Restaurants · Take-away & snacks · Drinks · Books · Movies & music · Holidays · Celebrations & gifts                                             |
| **Transport & auto**        |            | Public transport · Petrol / EV charging · Rego & licence · Road tolls & parking · Repairs & maintenance · Fines                                                           |

- 默认归属人设在一级上，二级继承。空的表示不设，按卡号或账户决定（见 R5）
- 中文名先不填，界面直接显示英文。以后要中文再补 `name_zh`
- **Groceries 的二级是"店的类型"**：Supermarket、Butcher、Fruit、Vegetable 分别对应超市、肉店、水果店、蔬菜店。在超市买的水果算 Supermarket
- Household supplies 没有预置规则，主要靠从超市账单里拆出来（F10）

---

## 3. 收入分类（kind = income）

| 一级       | 二级                  | 默认税前 | 说明                                      |
| ---------- | --------------------- | -------- | ----------------------------------------- |
| **Income** | Salary                | 否       | 进银行时已扣 PAYG                         |
|            | Contract income (B2B) | **是**   | 按发票全额收款，不代扣税                  |
|            | Interest              | **是**   | 银行不代扣税                              |
|            | Tax (ATO)             | 否       | 付给 ATO 的预缴税、BAS 记负数；退税记正数 |
|            | Other                 | 否       | 政府补贴、其他收入                        |

> 退款和报销不放在收入里，冲减原支出分类（R7.1）。
> 交税放在 Income 下面记负数，不算支出：交税不是消费，它让收入回到税后。

---

## 4. 系统分类（kind = system，不可删除）

一级分类，没有二级，没有默认归属人。

| system_key        | 名称              | 统计     |
| ----------------- | ----------------- | -------- |
| internal_transfer | Internal transfer | 不计收支 |
| cash_withdrawal   | Cash withdrawal   | 计入支出 |
| bank_fee          | Bank fees         | 计入支出 |
| uncategorized     | Uncategorised     | 单独显示 |

---

## 5. 预置规则

全部 `match_type = contains`，`priority = 0`，`is_system = true`。同时命中时关键词长的优先。

### Groceries

| 关键词                 | 二级        |
| ---------------------- | ----------- |
| COLES                  | Supermarket |
| WOOLWORTHS             | Supermarket |
| WW METRO               | Supermarket |
| ALDI                   | Supermarket |
| IGA                    | Supermarket |
| CROWN ASIAN            | Supermarket |
| MELB ASIAN MARKET      | Supermarket |
| ASIAN DELI             | Supermarket |
| DOWNTOWN GROCER        | Supermarket |
| EGGPORIUM              | Supermarket |
| MEATS                  | Butcher     |
| MEAT                   | Butcher     |
| FRESH FRUIT            | Fruit       |
| APPLE CORNER           | Fruit       |
| FRESH PEAR             | Fruit       |
| VEGGIE                 | Vegetable   |
| VEGETABLES             | Vegetable   |
| CONTINENTAL PRODUCE ❓ | Vegetable   |
| MARKET BOYS ❓         | Vegetable   |
| DOWNTOWN FRESH ❓      | Vegetable   |
| SEAFOOD                | Other       |
| BREAD                  | Other       |
| BAKERS                 | Other       |

### Personal & medical

| 关键词            | 二级                 |
| ----------------- | -------------------- |
| KIS HAIR          | Hair & beauty        |
| CHEMIST WAREHOUSE | Medicines & pharmacy |
| PHARMACY          | Medicines & pharmacy |
| MEDICARE          | Other                |
| MCARE BENEFITS    | Other                |
| I-MED             | Other                |
| UNIQLO            | Clothing & shoes     |
| MYER ❓           | Clothing & shoes     |
| JB HI-FI          | Computers & gadgets  |
| POP MART          | Hobbies              |
| AMAZON ❓         | Other                |
| TEMU ❓           | Other                |
| APPLE.COM/BILL ❓ | Other                |
| SPORTS DIRECT ❓  | Clothing & shoes     |

> `MEDICARE` 是正数（报销），冲减 Personal & medical / Other（R7.1）。

### Entertainment & eat-out

| 关键词          | 二级                 |
| --------------- | -------------------- |
| GONG CHA        | Coffee & tea         |
| TOP TEA         | Coffee & tea         |
| MOLLY TEA       | Coffee & tea         |
| COFFEE          | Coffee & tea         |
| CAFE ❓         | Coffee & tea         |
| MESSINA         | Take-away & snacks   |
| YOGURT          | Take-away & snacks   |
| LUNE            | Take-away & snacks   |
| KFC             | Take-away & snacks   |
| MCDONALDS       | Take-away & snacks   |
| DUMPLINGS       | Take-away & snacks   |
| LANZHOU         | Take-away & snacks   |
| NOODLES         | Take-away & snacks   |
| FOOD FACTORY ❓ | Take-away & snacks   |
| SECRET KITCHEN  | Restaurants          |
| POCHANA         | Restaurants          |
| RIBS            | Restaurants          |
| TAIWAN VILLAGE  | Restaurants          |
| RESTAURANT      | Restaurants          |
| MAGICCUISINE    | Restaurants          |
| BRIGHT PALACE   | Restaurants          |
| SON OF TUCCI    | Restaurants          |
| EAT EAT         | Restaurants          |
| TICKETEK        | Movies & music       |
| FLORIS          | Celebrations & gifts |

> Lunches 没有预置规则：同一家面馆是不是午饭，从流水看不出来。

### Transport & auto

| 关键词                    | 二级                 |
| ------------------------- | -------------------- |
| MYKI                      | Public transport     |
| DEPARTMENT OF TRANSPOR ❓ | Public transport     |
| CHARGEFOX                 | Petrol / EV charging |
| DIDIMOBILITY              | Other                |
| UBER                      | Other                |

### Home & utilities

| 关键词                 | 二级                      |
| ---------------------- | ------------------------- |
| BPAY GWW               | Water                     |
| BPAY SEENE ❓          | Electricity               |
| BUNNINGS               | Renovations & maintenance |
| LIGHTNING BROADBAND    | Internet                  |
| AMAYSIM                | Mobile                    |
| LOAN REPAYMENT ❓      | Mortgage                  |
| BPAY DEFT PAYMENTS ❓  | Body corporate fees       |
| BPAY CITY OF MELBOURNE | Council rates             |

### Insurance & financial

| 关键词     | 二级                      |
| ---------- | ------------------------- |
| BUPA ❓    | Personal & life insurance |
| SUNCORP ❓ | Other                     |

> BUPA 是健康险，分类里没有健康险，先放 Personal & life insurance。Suncorp 不确定是车险还是房屋险，先放 Other。

### Income

| 关键词             | 二级      |
| ------------------ | --------- |
| SALARY             | Salary    |
| CREDIT INTEREST ❓ | Interest  |
| TAX OFFICE ❓      | Tax (ATO) |
| CBA YELLO          | Other     |
| REFUND FROM CBA ❓ | Other     |

> B2B 收入没有预置规则，每个客户的付款描述不一样。第一次手动分到 Contract income (B2B) 时存成规则（R13）。
> **不要把真实的人名、客户名写进预置规则**（这个文件会进 git）。朋友、客户相关的规则在 app 里手动建。
> `SALARY`：CBA 的工资描述以 `Salary` 开头（如 `Salary <雇主> ...`）。
> `CBA YELLO`：CBA 房贷配套账户的每月返现。
> `EAT EAT`：转给朋友的聚餐 AA 款，备注里写了 "Eat Eat"。朋友转回来的钱（如 `FAST TRANSFER FROM ... DINNER`）手动分到 Restaurants，会冲减支出（R7.1）。
> `TAX OFFICE` 对应 ATO 的 BPAY 付款，拿到真实流水后确认描述格式。

---

## 6. 有意不加规则的商家

从描述看不出是什么，留给 Uncategorised，第一次手动分类时存成规则：

`EASI AU`、`VIT MELBOURNE`、`AUWE INTERNATIONAL`、`272 SW WHITE`、`LING ZHENG`、`H PRENTICE`、`JU S LUO`、`PRIMO@VIC`、`THE TRUSTEE FOR HAOSO`、`ZIYAN AUSTRALIA`、`BIZOE AU`、`GOLDEN FRIENDSHIP`、`WASSHOI`、`KUMO`、`QUEEN VIC GOURMET`、`QUEEN VICTORIA MARK`

---

## 7. 检查清单（seed 跑完后）

- [ ] 用真实的 ANZ 半年流水导一遍，Uncategorised 占比低于 15%
- [ ] 看 ❓ 标记的规则有没有分错
- [ ] 看 `MEAT`、`LUNE` 这类短关键词有没有误伤
- [ ] 看各一级的 Other 里有没有哪类特别多，多的话拆成新二级
