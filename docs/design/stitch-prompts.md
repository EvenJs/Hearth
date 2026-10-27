# Stitch Prompts

> 给 Google Stitch 用的 prompt，每个页面一条 desktop、一条 mobile。页面编号和文件名按 `README.md` 的命名规则。
> 数据全是假的，不要换成真实流水。

## 怎么用

1. Stitch 里新建项目，desktop 的选 **Web**，mobile 的选 **Mobile**（建议 desktop 和 mobile 分两个项目）
2. **第一条先发"0. 全局风格"**，让 Stitch 记住风格；之后每个页面发一条
3. 生成后把 screen 改名成表格里的名字（如 `02-dashboard`、`02-dashboard-mobile`），导出 PNG 放进这个目录
4. 一次只改一处：不满意时发短的修改指令（"make the sidebar narrower"），不要整条重发
5. 先做 `02-dashboard` 和 `03-transactions`，风格定了再做其他的

Prompt 用英文写（Stitch 对英文理解更稳），界面文字用中文，放在引号里。

---

## 0. 全局风格（每个项目第一条发）

```
I'm designing "Hearth", a private family bookkeeping web app for a couple in Melbourne, Australia. It imports bank CSV statements, auto-categorises transactions, and shows where the money goes. Two users, no marketing pages.

Style for every screen in this project:
- Calm, warm, trustworthy. Think a well-made personal finance tool, not a flashy fintech app. Data-dense but breathable.
- Background warm off-white #FAF8F5, cards white with a 1px #E7E2DA border and 12px radius, very soft shadow or none.
- Text near-black #1F1D1A, secondary text #6B655C.
- One accent colour: terracotta #C2410C for primary buttons, active nav and links.
- Income green #15803D. Expenses in normal text colour, NOT red. Red #B91C1C only for over-budget and errors. Amber #B45309 for warnings.
- Font: Inter for Latin and numbers, Noto Sans SC for Chinese. All amounts use tabular figures, right-aligned in tables.
- Currency format: $1,234.56 (AUD). Negative expenses shown as -$58.40.
- UI labels in Simplified Chinese. Category names stay in English (e.g. "Groceries / Supermarket").
- "Pending" transactions (manually entered, waiting for bank import) are shown with a small clock icon and a muted "待确认" tag, never hidden.
- Three "members" (who the money was spent on): Home, Male, Female. Each has a small coloured dot: Home #C2410C, Male #2563EB, Female #9333EA.
- Component style like shadcn/ui: simple inputs, ghost buttons, compact tables, badges, dialogs, sheets.
```

---

## 01 登录

### `01-login`（Desktop）
```
Login screen for Hearth, desktop 1440px wide. Centered card 400px wide on the warm off-white background. Small logo mark (a simple house-with-flame icon) and the word "Hearth" above the card. Card contains: title "登录", email input "邮箱", password input "密码", full-width terracotta button "登录". Below the button a small grey note: "仅限家庭成员使用，不开放注册". No sign-up link, no social login, no illustrations.
```

### `01-login-mobile`（Mobile）
```
Mobile login screen for Hearth, 375px wide. Logo and "Hearth" at the top third. Email input "邮箱", password input "密码", full-width terracotta button "登录", small grey note "仅限家庭成员使用，不开放注册". Inputs are tall (48px) for thumbs. No sign-up link.
```

---

## 02 首页看板

### `02-dashboard`（Desktop）
```
Dashboard home page of Hearth, desktop 1440px. This is the main screen; it answers "where did our money go this month".

Layout: left sidebar 240px with logo "Hearth" and nav items "看板" (active), "流水", "导入", "设置" (with sub-items "账户", "预算", "税务"). Top bar: page title "看板", a period selector showing "本月 · 2026年10月" with options (本周, 上周, 本月, 上月, 本季度, 今年, 本财年, 自定义), a member filter as segmented control "全部 / Home / Male / Female", and on the right a terracotta button "+ 记一笔".

Main content, top to bottom:
1. Pinned budgets strip: 3 compact progress bars - "Groceries $612 / $800" (amber, 77%), "Entertainment & eat-out $455 / $400" (red, over), "Transport & auto $120 / $300" (normal).
2. Four KPI cards in a row: "收入 $9,840.00" with small text "其中税前 $1,200.00"; "支出 $4,215.60"; "储蓄率 57%"; "未分类 12 笔 · $386.20" with a link "去处理 →". Each card shows "对比上月同期 +8%" in small grey text.
3. Two columns: left (wider) a horizontal bar list of spending by category with amount and % share - Home & utilities $1,640, Groceries $612, Entertainment & eat-out $455, Transport & auto $120, Personal & medical $310, Insurance & financial $280, Cash withdrawal $200; each row expandable with a chevron to show subcategories. Right column: two tax cards "预计年底补税" for "Male" ($0, 工资已代扣) and "Female" ($8,700, small caption "估算，以 ATO 为准"); below it "支出 Top 商家" list of 5 merchants (COLES, WOOLWORTHS, ORIGIN ENERGY, KUMO MELBOURNE, MYKI).
4. Full-width "汇总表" card: toggle "按周 / 按月" and "按分类 / 按归属人"; a table with weeks as columns ("10/1–10/5 部分", "10/6–10/12", "10/13–10/19", "10/20–10/22 部分", "合计") and members as rows (Home, Male, Female, 合计). Row and column totals in bold.
5. Full-width line/bar chart "近 12 个月收支" with income bars and expense bars per month, Nov 2025 to Oct 2026.

Small note under KPI cards: "含 3 笔待确认交易" with the clock icon.
```

### `02-dashboard-mobile`（Mobile）
```
Mobile version of the Hearth dashboard, 375px wide. Must work without horizontal scrolling.

Top app bar: "看板" and a period chip "本月 ▾". Below it a horizontally scrollable chip row for members "全部 / Home / Male / Female".
Content stacked in one column:
1. KPI cards as a 2x2 grid: "收入 $9,840", "支出 $4,216", "储蓄率 57%", "未分类 12 笔".
2. Pinned budgets: 3 thin progress bars (Groceries amber, Entertainment red over budget, Transport normal).
3. "分类支出" list with amount and % per category, tap to expand.
4. Tax card "预计年底补税" showing Female $8,700 with caption "估算，以 ATO 为准".
5. "支出 Top 商家" top 5 list.
Hide the summary table and 12-month chart behind a link "查看汇总表和趋势 →".

Bottom tab bar with 4 tabs: "看板" (active), "流水", "导入", "设置". A round terracotta floating "+" button bottom-right, above the tab bar.
```

---

## 03 流水查询

### `03-transactions`（Desktop）
```
Transactions list page of Hearth, desktop 1440px, same left sidebar as the dashboard with "流水" active, top bar with "+ 记一笔" button.

Top: page title "流水". A filter bar with dropdowns: "时间段: 本月", "账户: 全部", "归属人: 全部", "分类: 全部", "类型: 收入/支出/内部转账", "状态: 全部", a checkbox "仅税前", a search input "搜索商家", an amount range "金额 从 – 到", and a "清除筛选" ghost button. Quick filter chips above the table: "未分类 12", "待确认 3", "建议转账 2", "可能重复 1".

Summary line under filters: "共 86 笔 · 合计 -$3,829.40".

Dense table, one row per transaction, columns: checkbox, 日期, 商家 (bold merchant like "COLES 0559 MELBOURNE" with a small grey raw description below), 账户 ("ANZ Joint"), 分类 (inline dropdown showing "Groceries / Supermarket"), 归属人 (inline dropdown with coloured dot "Home"), 金额 (right aligned, income in green). Include examples:
- a pending row with clock icon and "待确认" tag,
- an "Uncategorised" row highlighted with a soft amber background and a "选择分类" dropdown,
- a suggested transfer row with a badge "建议转账" and two small buttons "确认" / "不是",
- a refund row "+$0.72" in green under Groceries,
- an internal transfer row in muted grey "Internal transfer",
- a split transaction showing a small "已拆分 3" badge.
Pagination at the bottom. Clicking a row opens the transaction detail.
```

### `03-transactions-bulk`（Desktop，批量修改）
```
Same transactions page, but 5 rows are selected with checkboxes. A sticky action bar appears at the bottom of the table: "已选 5 笔 · 合计 -$214.30", buttons "改分类", "改归属人", "取消选择". Show the "改分类" popover open with a searchable two-level category list (Groceries > Supermarket, Butcher, Fruit...).
```

### `03-transactions-mobile`（Mobile）
```
Mobile transactions list of Hearth, 375px wide, no horizontal scrolling.

Top app bar: "流水" with a search icon and a filter icon showing a badge "2". Below: horizontal scrollable quick chips "本月", "未分类 12", "待确认 3", "建议转账 2".
Summary line: "86 笔 · -$3,829.40".
List grouped by date headers ("10月22日 周四"). Each item is a two-line row: left side merchant name bold ("COLES 0559 MELBOURNE") and below in small grey "Groceries · Home · ANZ Joint"; right side the amount. Show a pending item with clock icon, an uncategorised item with amber "未分类" badge, and a green income item "+$4,920.00 SALARY".
Bottom tab bar with "流水" active and the floating "+" button.
```

---

## 04 交易详情（含拆分）

### `04-transaction-detail`（Desktop）
```
Transaction detail page of Hearth, desktop 1440px, same sidebar with "流水" active. Breadcrumb "流水 / 交易详情".

Header card: big amount "-$58.40", merchant "COLES 0559 MELBOURNE", date "2026年9月29日", account "ANZ Joint", status badge "已确认", source badge "CSV 导入".

Info section (two columns of label/value): 原始描述 "VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE", 卡号后四位 "1111", 导入批次 "joint-2026-09.csv", 转账状态 "无", 备注 (editable text field).

Splits section titled "拆分" with a button "拆出一部分". A table of splits with columns 金额, 分类, 归属人, 来源, 操作:
- "-$35.40  Groceries / Supermarket  Home  分类默认  主拆分" (no delete button, marked "主")
- "-$15.00  Home & utilities / Household supplies  Home  分类默认  [删除]"
- "-$8.00  Personal & medical / Cosmetics & toiletries  Male  卡号  [删除]"
Footer row "合计 -$58.40 = 交易金额" with a green check.

Right side panel: "改分类后存成规则" helper showing keyword "COLES" and a button "存成规则".
```

### `04-transaction-detail-split`（Desktop，拆分对话框）
```
Same transaction detail page with a centered dialog open titled "拆出一部分". Fields: "金额" input with "$" prefix showing "15.00" and helper text "主拆分剩余 $43.40"; "分类" searchable select showing "Home & utilities / Household supplies"; "归属人" select with placeholder "按分类自动 (Home)"; "备注" optional input. Buttons "取消" and terracotta "拆分". Show one validation example state below the amount: red text "不能超过主拆分 $35.40" (as an alternate small inline example).
```

### `04-transaction-detail-mobile`（Mobile）
```
Mobile transaction detail of Hearth, 375px. Top app bar with back arrow and "交易详情". Large amount "-$58.40" centered, merchant "COLES 0559 MELBOURNE", small line "2026年9月29日 · ANZ Joint · 已确认".
Card "拆分" listing 3 splits as stacked rows (amount, category, member dot), main split marked "主"; a full-width outline button "拆出一部分".
Card "详情" with label/value rows: 原始描述, 卡号后四位, 来源, 导入批次, 备注.
For a manually entered transaction show buttons at the bottom "编辑" and red text button "删除".
```

---

## 05 快速录入

### `05-quick-add`（Desktop，弹窗）
```
Hearth dashboard dimmed in the background with a centered dialog 480px wide titled "记一笔". This must feel very fast.

Fields in order:
1. Large amount input at the top, already focused, showing "$ 12.50" in big tabular numbers, with a toggle "支出 / 收入" (支出 selected).
2. "描述" input showing "Coffee Lab".
3. "分类" as a row of chips for the most used categories ("Coffee & tea" pre-selected with a small hint "根据描述猜的", "Lunches", "Supermarket", "Public transport", "更多…").
4. Inline row: "账户" select "现金（我）" (hint "上次使用"), "日期" "今天 10月22日", "归属人" select "Male".
5. Status hint at the bottom: for cash accounts "现金账户，保存后直接确认"; show this text.
Buttons: "取消" and terracotta "保存" with keyboard hint "⌘↵". Small link "保存并再记一笔".
```

### `05-quick-add-mobile`（Mobile，全屏）
```
Full-screen mobile quick add form for Hearth, 375px, opened from the floating + button. This is the most important mobile screen: record a cash expense in under 10 seconds with one hand.

Top bar: "×" close on the left, title "记一笔", "保存" text button on the right.
Huge amount display at the top "$12.50" with a "支出 / 收入" segmented toggle.
Below, compact fields: "描述" input "Coffee Lab"; horizontally scrollable category chips with "Coffee & tea" pre-selected (small label "猜的"); a row of two pills "现金（我）▾" and "今天 ▾"; member pills "Home / Male / Female" with Male selected.
The bottom half of the screen is a large custom numeric keypad (1-9, ".", 0, backspace) with big keys, and a full-width terracotta "保存" button above the keypad.
Show a small note "ANZ / CBA 账户会先记为待确认，导入时自动匹配".
```

---

## 06 导入

### `06-import`（Desktop）
```
CSV import page of Hearth, desktop 1440px, sidebar with "导入" active.

Step layout in one card, max width 720px:
1. "选择账户": a list of radio cards, each showing account name, bank logo text and suffix: "ANZ Joint · ANZ · ••6691", "ANZ Access Advantage（我）· ANZ", "ANZ Progress Saver · ANZ", "CBA 日常（老婆）· CBA". Under the list a grey note "ANZ Plus 和现金账户不能导入 CSV，请手动记录".
2. "上传 CSV": a dashed drop zone "拖入 CSV 文件，或点击选择", showing a selected file chip "joint-2026-10.csv · 42 行 · 2026-09-23 至 2026-10-21".
3. "对账（可选）": for ANZ accounts two inputs "期初余额" and "期末余额" with helper "从 PDF 对账单抄过来，可以不填". (Add a small note: "CBA 账户会从余额列自动对账".)
Primary button "开始导入", and a link on the top right "导入历史 →".
Side note card on the right: "怎么从 ANZ 导出 CSV" with 4 short steps.
```

### `06-import-mobile`（Mobile）
```
Mobile import page of Hearth, 375px. Title "导入". Stacked steps: account selector as a dropdown "选择账户", a file picker button "选择 CSV 文件" showing a chosen file "joint-2026-10.csv · 42 行", optional opening/closing balance inputs collapsed under "对账（可选）", and a full-width "开始导入" button. Small note "建议在电脑上导入". Bottom tab bar with "导入" active.
```

---

## 07 导入结果

### `07-import-result`（Desktop）
```
Import result page of Hearth, desktop 1440px, sidebar "导入" active. Title "导入完成", subtitle "ANZ Joint · joint-2026-10.csv · 2026-09-23 至 2026-10-21".

Row of 4 stat cards: "新增 31", "跳过重复 9", "确认待确认交易 2", "未分类 6" (amber, with button "去分类 →").
Reconciliation card: green check "对账通过", "期初 $3,210.55 + 本期 -$842.10 = 期末 $2,368.45". Also show an alternate red variant small beside it: "对账不通过，差额 $45.00".
Warnings card (amber): "第 12 行和第 13 行之间余额不连续" (for CBA) and "建议转账 2 笔，去确认 →".
"待检查的待确认交易" table: 2 pending manual entries older than 3 days that didn't match any bank row, columns 日期, 描述, 账户, 金额, with hint "可能金额录错、账户选错，或其实是现金" and actions "编辑" / "改成现金".
Buttons at the bottom: "查看本次导入的交易" and ghost "撤销这次导入".
```

### `07-import-result-mobile`（Mobile）
```
Mobile import result of Hearth, 375px. Title "导入完成" and account/file line. A 2x2 grid of stats: 新增 31, 跳过 9, 确认 2, 未分类 6. A green "对账通过" card with the formula in small text. An amber warnings card. A list of 2 pending items to check. Full-width buttons "去处理未分类" and ghost "撤销这次导入".
```

---

## 08 导入历史

### `08-import-history`（Desktop）
```
Import history page of Hearth, desktop 1440px, sidebar "导入" active. Title "导入历史", button "新的导入" on the right.
Table columns: 导入时间, 账户, 文件名, 日期范围, 新增, 跳过, 确认 pending, 对账 (green "通过" / red "差 $45.00" / grey "—"), 操作 ("查看" link, "撤销" ghost button).
6 example rows across ANZ Joint, ANZ Access Advantage and CBA 日常.
Show a confirmation dialog for undo: "撤销这次导入？会删除这次新增的 31 笔交易，被确认的 2 笔待确认交易会恢复成待确认。" with buttons "取消" and red "撤销".
```

### `08-import-history-mobile`（Mobile）
```
Mobile import history of Hearth, 375px. Title "导入历史". A list of cards, each: account name, file name, date range, small stats "新增 31 · 跳过 9", a reconciliation badge, and an overflow menu "⋯" with "查看" and "撤销".
```

---

## 09 账户设置

### `09-settings-accounts`（Desktop）
```
Account settings page of Hearth, desktop 1440px, sidebar "设置 > 账户" active. Title "账户", terracotta button "新增账户".

Table of accounts with columns: 名称, 银行, 类型, 账号尾号, 默认归属人, 能否导入, 操作:
- "ANZ Joint" · ANZ · joint · ••6691 · Home · 可导入 CSV
- "ANZ Access Advantage" · ANZ · 日常 · ••1234 · Male · 可导入 CSV
- "ANZ Progress Saver" · ANZ · 储蓄 · ••5678 · Male · 可导入 CSV
- "ANZ Plus" · ANZ Plus · 储蓄 · ••9012 · Male · 手动录入
- "CBA 日常" · CBA · 日常 · ••3456 · Female · 可导入 CSV
- "现金（我）" · 现金 · 现金 · — · Male · 手动录入
- "现金（老婆）" · 现金 · 现金 · — · Female · 手动录入

Below, a card "卡号映射" for ANZ Joint: rows "卡号后四位 1111 → Male · 我的借记卡", "2222 → Female · 老婆的借记卡", button "添加卡".

Show the side sheet "编辑账户" open on the right with fields 名称, 银行 (select), 类型 (select), 账号尾号 (helper "只填后 4 到 6 位数字，用来识别内部转账"), 默认归属人, and a privacy note "不保存完整账号和 BSB".
```

### `09-settings-accounts-mobile`（Mobile）
```
Mobile account settings of Hearth, 375px. Top bar with back arrow "设置" and title "账户", "+" icon on the right. List of account cards, each with name, bank and type in grey, suffix "••6691", member dot, and a tag "CSV" or "手动". Tapping ANZ Joint shows its card mapping section "卡号映射: 1111 → Male, 2222 → Female".
```

---

## 10 预算设置

### `10-settings-budgets`（Desktop）
```
Budget settings page of Hearth, desktop 1440px, sidebar "设置 > 预算" active. Title "预算", subtitle "按自然月计算", button "新增预算".
Table columns: 分类 (level 1 or level 2, e.g. "Groceries", "Entertainment & eat-out / Coffee & tea"), 每月上限, 提醒阈值 ("80%"), 本月进度 (progress bar with "$612 / $800"), 固定到首页 (toggle), 操作.
Show 5 budgets: one normal (green-grey), one amber (≥ 80%), one red (over 100%).
A dialog "新增预算" with fields: 分类 (two-level select, helper "选一级分类会统计它下面所有二级"), 每月上限 "$", 提醒阈值 "%" default 80, toggle "固定到首页".
```

### `10-settings-budgets-mobile`（Mobile）
```
Mobile budget settings of Hearth, 375px. Title "预算" with "+" icon. A list of budget cards: category name, "$612 / $800" with a progress bar coloured normal/amber/red, a pin icon if pinned to home. Tap opens an edit sheet from the bottom with 分类, 每月上限, 提醒阈值, 固定到首页 toggle.
```

---

## 11 税务设置

### `11-settings-tax`（Desktop）
```
Tax settings page of Hearth, desktop 1440px, sidebar "设置 > 税务" active. Title "税务", financial year selector "2026-27 财年 ▾".
An info banner: "这里只用于估算年底补税，不是税务建议。没有计算业务开支抵扣和各种 offset，结果偏高，以 ATO 为准。"
Two side-by-side cards, one per person ("Male", "Female"), each with inputs "全年工资税前总额" ($60,000.00) and "雇主已代扣的税" ($9,720.00), helper "来自工资单或 myGov income statement", and a "保存" button.
Below, a read-only estimate table per person: 工资, 税前收入（B2B、利息）, 应纳税收入, 预计所得税, Medicare levy 2%, 预计总税额, 已代扣, 已预缴 (ATO), 预计年底补税 (bold, e.g. Female "$8,700.00"). Note under the table: "Home 名下的税前收入（如 joint 利息）两人平分".
```

### `11-settings-tax-mobile`（Mobile）
```
Mobile tax settings of Hearth, 375px. Title "税务", year chip "2026-27 ▾". Info banner "估算，以 ATO 为准". Segmented control "Male / Female". For the selected person: two inputs (全年工资税前总额, 雇主已代扣的税) and a save button, then a summary card listing 应纳税收入, 预计总税额, 已缴, and a large bold "预计年底补税 $8,700.00".
```

---

## 12 规则设置

### `12-settings-rules`（Desktop）
```
Category rules settings page of Hearth, desktop 1440px, sidebar "设置 > 规则" active. Title "分类规则" with a short grey subtitle "导入时按商家名自动分类。关键词越长越优先。" and a terracotta "新建规则" button on the right.
Toolbar: a search input "搜索关键词" and a select "全部分类 ▾".
A compact table with columns: "关键词" (monospace uppercase, e.g. "COLES", "WOOLWORTHS", "MYKI", "GONG CHA", "CAFE"), "匹配方式" (muted text "包含" or "开头是"), "分类" (category tag, e.g. "Groceries / Supermarket" light orange tag, "Public transport" light teal tag, "Coffee & tea"), "命中" (right-aligned number as a link, e.g. "42 笔", "0 笔" in muted grey, "186 笔"), a small grey "预置" badge on some rows, and a row action menu "⋯" with "修改" and "删除".
No pagination needed for about 40 rows. No priority column, no toggles, no AI suggestions.
```

### `12-settings-rules-dialog`（Desktop）
```
The same page dimmed, with a centered dialog 440px titled "修改规则". Fields: "关键词" input "CAFE" (helper "匹配清洗后的商家名，不区分大小写"), "匹配方式" segmented control "包含 / 开头是" (包含 selected), "分类" searchable grouped dropdown showing "Coffee & tea". A muted line "现在命中 12 笔". Buttons "取消" and terracotta "保存".
Show a second small state below as a follow-up dialog: "规则已保存。要对 8 笔交易应用吗？只会改按规则分类的和未分类的，手动改过的不动。" with buttons "暂不" and "应用".
```

### `12-settings-rules-mobile`（Mobile）
```
Mobile category rules page of Hearth, 375px. Title "分类规则" and a "新建" text button. Search input on top. A simple list: each row shows the keyword in bold monospace, the category tag below it, and on the right "42 笔" and a "⋯" button. "预置" small grey badge where relevant. No horizontal scrolling.
```

---

## 13 分类设置

### `13-settings-categories`（Desktop）
```
Category settings page of Hearth, desktop 1440px, sidebar "设置 > 分类" active. Title "分类" with a terracotta "新建一级分类" button on the right and a small checkbox "显示已归档".
Two sections: "支出" and "收入". Each top-level category is a collapsible row with its colour tag (e.g. "Groceries", "Transport & auto", "Work", "Income"), default member dot and name (e.g. "Home"), "1,204 笔", "3 条规则", and a "⋯" menu (修改 / 新建二级 / 归档). Expanded rows show indented subcategories as lighter tags (e.g. "Supermarket", "Bakery", "Other"), each with usage count, rule count and "⋯". Income subcategories like "Interest" and "Contract income" show a small "税前" badge. "Other" rows have no rename option.
At the bottom, a muted read-only section "系统分类": 未分类, 内部转账, 现金支出, 银行费用, with grey dashed tags and a note "系统分类不能修改".
No drag handles, no icons picker, no colour picker.
```

### `13-settings-categories-dialog`（Desktop）
```
The same page dimmed, with a centered dialog 440px titled "新建二级分类 · Groceries". Fields: "名字" input "Asian grocer" (helper "英文，最长 50 字"), "默认归属人" select "继承一级（Home）". Buttons "取消" and terracotta "保存".
Also show a small warning dialog state: "有 3 条规则指向这个分类，先去规则页改掉或删掉，才能归档。" with a link "去规则页 →" and a "知道了" button.
```

### `13-settings-categories-mobile`（Mobile）
```
Mobile category settings of Hearth, 375px. Title "分类" and a "新建" text button. Segmented control "支出 / 收入". A simple collapsible list of top-level categories with their colour tag and "⋯"; tapping expands subcategories below. System categories listed at the bottom in grey. No horizontal scrolling.
```
