# Hearth 业务规则

> 这份文档是核心逻辑的唯一标准。每条规则都要有对应的单元测试，测试用例直接从这里的例子来。
> 规则代码放在 `src/lib/import/`、`src/lib/rules/`、`src/lib/tax/`，全部是纯函数，不碰数据库。
> 规则编号（R1、R2…）在代码注释和测试名里引用，方便对照。

---

## 怎么读

- 正文按规则编号拆在 `docs/rules/` 里，一个 R 一个文件。代码注释里的 `business-rules.md R4.1` 就去 `rules/R04-*.md` 找
- **只读任务需要的那几个文件**，不要把整个目录都读一遍。任务文件的"读"一行会列出来
- 规则里引用别的规则（"见 R6.2"）时，需要了才去读那个文件
- 改规则时直接改对应的 `rules/` 文件；新增 R21 以后要在下面的表里加一行

## 索引

| 规则 | 文件 | 小节 |
|---|---|---|
| R1. 解析（CSV 和 ANZ 对账单） | [`rules/R01-parse.md`](rules/R01-parse.md) | R1.0、R1A、R1C、R1C.1、R1B、R1B.1、R1B.2 |
| R2. 提取和脱敏 | [`rules/R02-extract-mask.md`](rules/R02-extract-mask.md) | R2.1、R2.2、R2.3 |
| R3. 清洗商家名 | [`rules/R03-merchant.md`](rules/R03-merchant.md) | — |
| R4. 去重 | [`rules/R04-dedupe.md`](rules/R04-dedupe.md) | R4.1、R4.2 |
| R5. 归属人 | [`rules/R05-member.md`](rules/R05-member.md) | R5.1 |
| R6. 内部转账识别 | [`rules/R06-transfer.md`](rules/R06-transfer.md) | R6.1、R6.2、R6.3、R6.4 |
| R7. 分类 | [`rules/R07-classify.md`](rules/R07-classify.md) | R7.1、R7.2 |
| R8. pending 交易匹配 | [`rules/R08-pending.md`](rules/R08-pending.md) | R8.1、R8.2、R8.3、R8.4 |
| R9. 对账校验 | [`rules/R09-reconcile.md`](rules/R09-reconcile.md) | — |
| R10. 统计口径 | [`rules/R10-stats.md`](rules/R10-stats.md) | R10.1、R10.2、R10.3、R10.4、R10.5、R10.6 |
| R11. 预算 | [`rules/R11-budget.md`](rules/R11-budget.md) | R11.1、R11.2、R11.3 |
| R12. 导入流程（一次事务） | [`rules/R12-import-flow.md`](rules/R12-import-flow.md) | R12.1、R12.2 |
| R13. 从手动改分类生成规则 | [`rules/R13-rule-from-edit.md`](rules/R13-rule-from-edit.md) | — |
| R14. 税后估算 | [`rules/R14-tax.md`](rules/R14-tax.md) | R14.1、R14.2、R14.3、R14.4、R14.5、R14.6、R14.7 |
| R15. 简单拆分 | [`rules/R15-split.md`](rules/R15-split.md) | R15.1、R15.2、R15.3、R15.4、R15.5 |
| R16. 流水查询里的修改（F8，2026-10-24 新增） | [`rules/R16-transaction-edit.md`](rules/R16-transaction-edit.md) | R16.1、R16.2、R16.3、R16.4、R16.5、R16.6、R16.7、R16.8、R16.9、R16.10 |
| R17. 手动录入（F3，2026-10-25 新增） | [`rules/R17-manual-entry.md`](rules/R17-manual-entry.md) | R17.1、R17.2、R17.3、R17.4、R17.5、R17.6 |
| R18. 规则管理（2026-10-25 新增） | [`rules/R18-rule-admin.md`](rules/R18-rule-admin.md) | R18.1、R18.2、R18.3、R18.4、R18.5 |
| R19. 分类管理（2026-10-25 新增） | [`rules/R19-category-admin.md`](rules/R19-category-admin.md) | R19.1、R19.2、R19.3、R19.4、R19.5 |
| R20. 小票识别（2026-10-27 新增） | [`rules/R20-receipt.md`](rules/R20-receipt.md) | R20.1、R20.1a、R20.1b、R20.2、R20.3、R20.4、R20.5、R20.6、R20.7、R20.8 |
