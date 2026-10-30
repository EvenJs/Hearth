# R2. 提取和脱敏

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

在清洗之前做。顺序：**先提取，再脱敏**。

## R2.1 提取卡号后四位

- 正则：`/\bCARD (?:XX)?(\d{4})\b/i`
- ANZ：`VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE` → `1111`
- CBA：`Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026` → `1234`
- 没有匹配 → `null`

## R2.2 提取转账对方账号

- 只在描述含 `FUNDS TFER` 或 `TRANSFER` 时提取（不区分大小写）
- 两种格式：
  - 完整账号（ANZ）：`/\b(?:FROM|TO)\s+(?:\d{6}-)?(\d{8,})\b/i`。账号前面可能带 6 位 BSB 和 `-`（转去 ANZ Plus 是这种，2026-10-25 用真实导出确认），BSB 不算账号
  - 银行已经打码的尾号（CBA）：`/\b(?:FROM|TO)\s+XX(\d{4})\b/i`
- `TRANSFER 681801  TO  012345400006691` → `012345400006691`
- `TRANSFER 815033  FROM       400006691` → `400006691`
- `TRANSFER TO 012345-400000004 #123456` → `400000004`（带 BSB；`#123456` 是参考号，不提取）
- `TRANSFER FROM 012345-400000004 #123456` → `400000004`（转入方向还没见过真实导出，先按同样格式处理）
- `Transfer from xx5678 CommBank app Home` → `5678`
- `Transfer To MISS X Y PayID Phone from CommBank App Eat Eat` → `null`（PayID 转账只有人名，没有账号）
- 注意 `681801`、`815033` 是转账流水号，不是账号，不提取
- 提取出的数字**只在内存里用于 R6 匹配，不入库**

## R2.3 脱敏

- 把描述里所有**连续 8 位及以上的数字**替换成 `****` + 后 4 位
- `TO  012345400006691` → `TO  ****6691`
- `FROM       400006691` → `FROM       ****6691`
- `EASI AU 280672605`（9 位）→ `EASI AU ****2605`（宁可多脱敏）
- `TRANSFER TO 012345-400000004 #123456` → `TRANSFER TO 012345-****0004 #123456`（6 位 BSB 和参考号不受影响）
- CBA 的 BPAY 客户号、贷款号、直接扣款参考号也会被脱敏：`LN REPAY 700006979` → `LN REPAY ****6979`
- BPAY 账单码 `{022288}`（6 位）、门店号 `0559`、卡号后四位、流水号 `681801`（6 位）、CBA 的 `xx5678` **不受影响**
