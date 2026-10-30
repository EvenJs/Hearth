# R3. 清洗商家名

> 业务规则的一部分，总则和索引见 [`docs/business-rules.md`](../business-rules.md)。其他规则按编号去 `docs/rules/` 找。

**输入**：脱敏后的描述
**输出**：`merchant`（大写字符串）

ANZ 和 CBA 用同一套步骤，不适用的步骤自然不生效。按顺序执行：

1. 转大写
2. 去掉 ANZ 交易类型前缀（只去开头）：
   - `VISA DEBIT PURCHASE CARD \d{4}`
   - `ANZ INTERNET BANKING BPAY` → 替换成 `BPAY`
   - `ANZ M-BANKING FUNDS TFER` → 替换成 `TRANSFER`，并去掉后面的 `TRANSFER \d+`
   - `EFTPOS`
   - `NON-ANZ ATM` → 替换成 `ATM`
3. 去掉 CBA 的附加信息：
   - ` VALUE DATE: \d{2}/\d{2}/\d{4}`
   - ` AUS CARD XX\d{4}`
   - CBA 的 BPAY：`^(.+?) COMMBANK APP BPAY .*$` → `BPAY $1`（和 ANZ 的格式统一）
   - 转账里的 ` TO PAYID PHONE`、` PAYID PHONE`、` FROM COMMBANK APP`、` COMMBANK APP`
4. 去掉开头的支付通道前缀：`ZLR*`、`SQ *`、`SMP*`、`LS `、`\d+PIN* `（如 `794PIN*`）
5. 去掉 BPAY 账单码：`\{\d+\}`
6. 反斜杠 `\` 替换成空格
7. 连续空白合并成一个空格，去掉首尾空白
8. 反复去掉结尾的地区词：`AU`、`AUS`、`VI`、`VIC`、`VICAU`、`NS`、`NSW`（至少保留一个词）

| 脱敏后描述                                                             | merchant                                 |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE`                   | `COLES 0559 MELBOURNE`                   |
| `EFTPOS MELB ASIAN MARKET\`                                            | `MELB ASIAN MARKET`                      |
| `EFTPOS SECRET KITCHEN     \MELBOURNE         AU`                      | `SECRET KITCHEN MELBOURNE`               |
| `EFTPOS 794PIN* CHARGEFOX PTY LTD\NORTH MELBOUR\`                      | `CHARGEFOX PTY LTD NORTH MELBOUR`        |
| `ANZ INTERNET BANKING BPAY SEENE                         {022288}`     | `BPAY SEENE`                             |
| `ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ****6691`               | `TRANSFER TO ****6691`                   |
| `EFTPOS ZLR*POCHANA MELBOURNE \MELBOURNE AU`                           | `POCHANA MELBOURNE MELBOURNE`            |
| `VISA DEBIT PURCHASE CARD 2222 SQ *KUMO MELBOURNE`                     | `KUMO MELBOURNE`                         |
| `NON-ANZ ATM CBA\HAWTHORN VIC AU`                                      | `ATM CBA HAWTHORN`                       |
| `ACCOUNT SERVICING FEE`                                                | `ACCOUNT SERVICING FEE`                  |
| `Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026`     | `MYER PTY LTD DOCKLANDS`                 |
| `myki tap Transport VIC VIC VI AUS Card xx1234 Value Date: 29/08/2026` | `MYKI TAP TRANSPORT`                     |
| `ZLR*Tower Sushi & Gourm Melbourne AU`                                 | `TOWER SUSHI & GOURM MELBOURNE`          |
| `MCDONALDS VIC MARKET MELBOURNE VICAU`                                 | `MCDONALDS VIC MARKET MELBOURNE`         |
| `seene CommBank app BPAY 959502 ****9999`                              | `BPAY SEENE`                             |
| `DEFT PAYMENTS CommBank app BPAY 96503 ****7890 INV No 0012345`        | `BPAY DEFT PAYMENTS`                     |
| `Transfer To TEST FRIEND PayID Phone from CommBank App Eat Eat`        | `TRANSFER TO TEST FRIEND EAT EAT`        |
| `Fast Transfer From OTHER FRIEND to PayID Phone dinner`                | `FAST TRANSFER FROM OTHER FRIEND DINNER` |
| `Transfer from xx7777 CommBank app Home`                               | `TRANSFER FROM XX7777 HOME`              |
| `LIGHTNING BROADBAND Value Date: 11/09/2026`                           | `LIGHTNING BROADBAND`                    |

清洗结果不需要完美，分类规则用关键词包含匹配，门店号、地名多出来不影响。

**CBA 的已知问题**：转账备注里的中文导出后会变成下划线（如 `Transfer To Y CHENG ... __`），所以转账备注最好用英文写，规则才能匹配。
