# 测试数据（fixtures）

> 全部是**假数据**：账号、卡号、人名、金额都是编的，格式照着 2026 年真实 ANZ 和 CBA 导出做。金额已确认不和真实流水重合。
> 真实导出**不要**放进这个目录，也不要提交到 git。

## 格式说明（和真实导出一致）

- **ANZ**：没有表头，3 列：日期、金额（带引号）、描述（不带引号）；文件末尾有空行
- **CBA**：没有表头，4 列：日期、金额、描述、余额，全部带引号，金额和余额带 `+`/`-`
- 行尾都是 **CRLF**（`\r\n`）
- `anz/joint-2026-09-lf.csv` 是同样内容的 LF 版本，解析器两种都要支持
- CBA 文件的余额是按期初 $10,000.00 逐行算出来的，余额链是连续的（`broken-balance.csv` 除外）

---

## 测试用的家庭配置

测试前先建好这些（seed 或测试 setup 里）：

| 归属人 | kind   |
| ------ | ------ |
| Male   | person |
| Female | person |
| Home   | shared |

| 账户             | bank     | type     | 默认归属人 | number_suffix |
| ---------------- | -------- | -------- | ---------- | ------------- |
| ANZ Joint        | anz      | joint    | Home       | `0001`        |
| ANZ Male         | anz      | everyday | Male       | `0002`        |
| CBA Female       | cba      | everyday | Female     | `0003`        |
| CBA Female Saver | cba      | savings  | Female     | `7777`        |
| ANZ Plus Male    | anz_plus | savings  | Male       | `0004`        |

`CBA Female Saver` 是假的账户，只用来测 CBA 4 位尾号的转账识别（R6.1）。真实家庭里没有这个账户。

| 卡（都在 ANZ Joint 上） | 归属人 |
| ----------------------- | ------ |
| `1111`                  | Male   |
| `2222`                  | Female |

分类、分类默认归属人、预置规则用 `docs/seed-categories.md` 的内容（Home & utilities、Insurance & financial、Groceries 默认 Home）。

---

## 文件清单

| 文件                            | 导入到     | 测什么                                                         |
| ------------------------------- | ---------- | -------------------------------------------------------------- |
| `anz/joint-2026-09.csv`         | ANZ Joint  | 主测试文件，覆盖大部分规则                                     |
| `anz/joint-2026-09-lf.csv`      | ANZ Joint  | 同上，LF 行尾                                                  |
| `anz/joint-2026-09-overlap.csv` | ANZ Joint  | 和上面日期重叠，测去重（R4）                                   |
| `anz/me-2026-09.csv`            | ANZ Male   | 测转账配对（R6.2）和兜底建议（R6.3）                           |
| `anz/invalid-date.csv`          | ANZ 任意   | 第 1 行 31/02，整个文件应失败（R1）                            |
| `anz/invalid-zero-amount.csv`   | ANZ 任意   | 金额 0，应失败（R1）                                           |
| `cba/female-2026-09.csv`        | CBA Female | CBA 解析和清洗、余额、税前收入、Tax (ATO)、和 joint 的转账配对 |
| `cba/broken-balance.csv`        | CBA Female | 余额不连续时只警告不失败（R1B.1）                              |
| `anz-statement/*.txt`           | ANZ Joint  | ANZ PDF 对账单（R1C、R12.2），读文字以后的样子，见"ANZ 对账单用例" |
| `anz-plus-statement/*.txt`      | ANZ Plus Male | ANZ Plus PDF 对账单（R1D），读文字以后的样子，见"ANZ Plus 对账单用例" |
| `receipts/*.json`               | —          | 小票识别（R20），见最后一节"小票用例"                       |

---

## 期望结果在哪里

每组用例一个文件，在 `fixtures/cases/` 里。**只读任务用到的那个文件**，这份 README 的上半部分（格式、家庭配置、文件清单）写测试前都要看。
01 到 04 是一条连续场景，要按顺序导入，后一个的期望建立在前一个之上。

| 用例 | 文件 | 前提 |
|---|---|---|
| 期望结果：`joint-2026-09.csv` | [`cases/01-joint-2026-09.md`](cases/01-joint-2026-09.md) | 第 1 步，空数据库开始 |
| 期望结果：再导入 `joint-2026-09-overlap.csv` | [`cases/02-joint-overlap.md`](cases/02-joint-overlap.md) | 第 2 步，接 01 |
| 期望结果：再导入 `me-2026-09.csv`（到 ANZ Male） | [`cases/03-me-2026-09.md`](cases/03-me-2026-09.md) | 第 3 步，接 02 |
| 期望结果：导入 `cba/female-2026-09.csv`（到 CBA Female） | [`cases/04-cba-female-2026-09.md`](cases/04-cba-female-2026-09.md) | 第 4 步，接 03 |
| 期望结果：导入 `cba/broken-balance.csv`（空数据库） | [`cases/05-cba-broken-balance.md`](cases/05-cba-broken-balance.md) | 独立，空数据库 |
| pending 匹配用例（R8） | [`cases/06-pending.md`](cases/06-pending.md) | 看各用例自己的前提 |
| 撤销导入用例（R12.1） | [`cases/07-undo.md`](cases/07-undo.md) | 看各用例自己的前提 |
| ANZ 对账单用例（R1C、R12.2，M6.6） | [`cases/08-anz-statement.md`](cases/08-anz-statement.md) | 看各用例自己的前提 |
| 小票用例（R20，M6.7） | [`cases/09-receipts.md`](cases/09-receipts.md) | 看各用例自己的前提 |
| ANZ Plus 对账单用例（R1D，M7.5） | [`cases/10-anz-plus-statement.md`](cases/10-anz-plus-statement.md) | 看各用例自己的前提 |
