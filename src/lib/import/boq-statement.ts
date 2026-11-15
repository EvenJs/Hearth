// BOQ PDF 对账单解析（business-rules.md R1F 第二层）
// 输入是 src/server/pdf/ 读出来的行 { page, text }[]，输出和 R1G 一样的形状
// 不抛错，返回结果对象。任何一条检查不过，整份失败，什么都不返回
// 纯函数，不 import 数据库和 Next.js
import type { StatementLine } from './anz-statement';
import { parseAuDate } from '@/lib/rules/date';
import { formatAud, parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import type { ParsedRow } from '@/lib/rules/types';

export type ParseBoqStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 旧的在前（就是表里的顺序，R1F，同 R1G）。balanceCents 是每笔余额，不印的是算出来的 0（R4.1）
      periodFrom: string; // YYYY-MM-DD，账期是闭区间 [periodFrom, periodTo]（R1F，同 R1D、R1E、R1G）
      periodTo: string;
      openingCents: number;
      closingCents: number;
    }
  | {
      ok: false;
      message: string; // 不含 BSB 和完整账号，最多带后 4 位
      page: number | null; // 出错交易所在的页，和交易无关的错误为 null
      index: number | null; // 这一页的第几笔，从 1 开始
    };

// R1F 账期和交易表的月份都是三个字母，首字母大写
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = `(${MONTHS.join('|')})`;

// 金额：1,234.56，千分位逗号可有可无，没有 $
const MONEY = '((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})';
const SIGNED_MONEY = `(-?${MONEY.slice(1, -1)})`;

// R1F 认格式：第 1 页第 2 行整行 Statement period + 表头之前有 Account summary + 有表头
const PERIOD_LABEL = 'Statement period';
const SUMMARY_LABEL = 'Account summary';
const NOT_BOQ_MESSAGE = '这不像 BOQ 对账单';

// R1F 第 1 页第 3 行：DD Mon YYYY - DD Mon YYYY
const PERIOD = new RegExp(`^(\\d{2}) ${MONTH} (\\d{4}) - (\\d{2}) ${MONTH} (\\d{4})$`);

// R1F 账号：表头之前 Account number  后面 9 位数字
const ACCOUNT_LINE = /^Account number\s+(\d+)$/;

// R1F 汇总：表头之前，各取第一个以标签开头的行。$ 后面可以有一个空格，期初期末带 - 是透支
const SUMMARY = {
  opening: {
    label: 'Opening balance',
    pattern: new RegExp(`^Opening balance\\s+(-)?\\$ ?${MONEY}$`),
  },
  credits: { label: 'Total credits', pattern: new RegExp(`^Total credits\\s+()\\$ ?${MONEY}$`) },
  debits: { label: 'Total debits', pattern: new RegExp(`^Total debits\\s+()\\$ ?${MONEY}$`) },
  closing: {
    label: 'Closing balance',
    pattern: new RegExp(`^Closing balance\\s+(-)?\\$ ?${MONEY}$`),
  },
} as const;

// R1F 交易表
const TABLE_HEADER =
  /^Date\s+Processed\s+Description\s+Debits \(\$\)\s+Credits \(\$\)\s+Balance \(\$\)$/;
const LETTER_ROW = /^[A-Za-z]$/;
const YEAR_ROW = /^\d{4}$/;
const FOOTER = /^(Bank of Queensland Limited ABN |Page \d+ of \d+)/;
const TRANSACTION_START = new RegExp(`^(\\d{2})-${MONTH}\\s+(\\d{2})-${MONTH}\\s+(.*)$`);
// 一笔的第一行末尾：…  金额  [余额]。余额是 0 时不印（R1F）
const FIRST_LINE_END = new RegExp(`^(.*?)\\s+${SIGNED_MONEY}(?:\\s+${SIGNED_MONEY})?$`);
// 续行末尾像金额
const ENDS_WITH_MONEY = new RegExp(`(?:^|\\s)${SIGNED_MONEY}$`);
const MAX_DESCRIPTION_LINES = 3;

const OVERDRAFT_MESSAGE = '没见过透支的对账单';

class StatementError extends Error {
  constructor(
    message: string,
    readonly page: number | null = null,
    readonly index: number | null = null,
  ) {
    super(message);
  }
}

type Position = { page: number; index: number }; // index：这一页的第几笔，从 1 开始

type Transaction = Position & {
  date: string;
  amountCents: number; // 带符号：借方印了 -（R1F）
  balanceCents: number | null; // null：没印（R1F 余额是 0 时不印）
  parts: string[];
  lineCount: number; // 描述占了几行，第一行也算
};

export function parseBoqStatement(
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseBoqStatementResult {
  try {
    return parse(cleanLines(lines), accountSuffix);
  } catch (error) {
    if (error instanceof StatementError) {
      return { ok: false, message: error.message, page: error.page, index: error.index };
    }
    throw error;
  }
}

// R1F 认格式（自动选解析器用）
export function looksLikeBoqStatement(lines: readonly StatementLine[]): boolean {
  return isBoq(cleanLines(lines));
}

// R1F 自动认账户（照 R1G）：在调用方给的账户（没归档的 BOQ）里，找 number_suffix 和对账单账号尾部对得上的
// BSB 和账号不返回；错误信息里只带后 4 位
export function identifyBoqStatementAccount(
  lines: readonly StatementLine[],
  accounts: readonly { id: string; numberSuffix: string | null }[],
): { ok: true; accountId: string } | { ok: false; message: string } {
  const cleaned = cleanLines(lines);
  if (!isBoq(cleaned)) return { ok: false, message: NOT_BOQ_MESSAGE };
  const headerAt = cleaned.findIndex((l) => TABLE_HEADER.test(l.text));
  let digits: string;
  try {
    digits = readAccountDigits(cleaned.slice(0, headerAt));
  } catch (error) {
    if (error instanceof StatementError) return { ok: false, message: error.message };
    throw error;
  }

  const matches = accounts.filter((a) => a.numberSuffix && digits.endsWith(a.numberSuffix));
  if (matches.length === 1) return { ok: true, accountId: matches[0].id };
  if (matches.length === 0) {
    return {
      ok: false,
      message: `找不到尾号是 ${digits.slice(-4)} 的 BOQ 账户，先去账户设置填上尾号`,
    };
  }
  return {
    ok: false,
    message: `有 ${matches.length} 个 BOQ 账户的尾号都对得上，去账户设置把尾号填长一点`,
  };
}

// 去首尾空白，空行跳过
function cleanLines(lines: readonly StatementLine[]): StatementLine[] {
  return lines.map((l) => ({ page: l.page, text: l.text.trim() })).filter((l) => l.text !== '');
}

// R1F 认格式：三条缺一条就不是
function isBoq(lines: StatementLine[]): boolean {
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));
  return (
    lines[1]?.page === 1 &&
    lines[1].text === PERIOD_LABEL &&
    headerAt !== -1 &&
    lines.slice(0, headerAt).some((l) => l.text === SUMMARY_LABEL)
  );
}

function parse(lines: StatementLine[], accountSuffix: string | null): ParseBoqStatementResult {
  if (!isBoq(lines)) throw new StatementError(NOT_BOQ_MESSAGE);
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));
  const beforeHeader = lines.slice(0, headerAt);

  const { periodFrom, periodTo } = readPeriod(lines[2]);

  // R1F：账号只拿来核对，不返回、不写进错误信息
  if (!accountSuffix) {
    throw new StatementError('这个账户还没填账号尾号，先去账户设置填，才能核对对账单');
  }
  if (!readAccountDigits(beforeHeader).endsWith(accountSuffix)) {
    throw new StatementError('这份对账单不是这个账户的');
  }

  const summary = readSummary(beforeHeader);
  const transactions = readTable(lines, headerAt, periodFrom, periodTo);

  // R1F：方向用印出来的符号，再用余额检查：上一笔余额 + 带符号的金额 = 这一笔余额
  const balances: number[] = [];
  let balance = summary.opening;
  let debits = 0;
  let credits = 0;
  for (const t of transactions) {
    const expected = balance + t.amountCents;
    if (t.balanceCents === null) {
      // R1F：只有算出来正好是 0 才允许不印
      if (expected !== 0) {
        throw rowError(
          t,
          `没有余额，算出来也不是 0：上一笔余额 ${cents(balance)} 加 ${cents(t.amountCents)} 是 ${cents(expected)}`,
        );
      }
    } else if (expected !== t.balanceCents) {
      throw rowError(
        t,
        `余额接不上：上一笔余额 ${cents(balance)} 加 ${cents(t.amountCents)} 不等于 ${cents(t.balanceCents)}`,
      );
    }
    if (t.amountCents < 0) debits -= t.amountCents;
    else credits += t.amountCents;
    balance = expected;
    balances.push(expected);
  }

  // R1F：最后一笔的余额 = 汇总的期末；一笔都没有时，期初 = 期末
  if (balance !== summary.closing) {
    throw new StatementError(
      transactions.length === 0
        ? `没有交易，但汇总的期初 ${cents(summary.opening)} 和期末 ${cents(summary.closing)} 不一样`
        : `最后一笔的余额是 ${cents(balance)}，汇总的 Closing balance 是 ${cents(summary.closing)}`,
    );
  }

  // R1F 汇总：借贷合计和逐笔一致（都按正数比）
  if (summary.debits !== debits) {
    throw new StatementError(
      `逐笔借合计是 ${cents(debits)}，汇总的 Total debits 是 ${cents(summary.debits)}`,
    );
  }
  if (summary.credits !== credits) {
    throw new StatementError(
      `逐笔贷合计是 ${cents(credits)}，汇总的 Total credits 是 ${cents(summary.credits)}`,
    );
  }

  // R1F：输出旧的在前（表里的顺序，同 R1G），rowIndex 按输出顺序从 1 开始
  return {
    ok: true,
    rows: transactions.map((t, i) => ({
      date: t.date,
      amountCents: t.amountCents,
      description: t.parts.join(' '), // R1F：各段用一个空格拼，NA、NOTPROVIDED 留着
      balanceCents: balances[i], // R1F、R4.1：BOQ 的 key 放余额，不印的写算出来的 0
      rowIndex: i + 1,
    })),
    periodFrom,
    periodTo,
    openingCents: summary.opening,
    closingCents: summary.closing,
  };
}

// ---------- 表头部分 ----------

// R1F 账期：第 1 页第 3 行整行，闭区间，日期带年份；不能超过 12 个月
function readPeriod(line: StatementLine | undefined) {
  const match = line?.page === 1 ? PERIOD.exec(line.text) : null;
  if (!match) throw new StatementError('找不到账期');
  const [, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
  const periodFrom = toIsoDate(fromDay, MONTHS.indexOf(fromMonth) + 1, Number(fromYear));
  const periodTo = toIsoDate(toDay, MONTHS.indexOf(toMonth) + 1, Number(toYear));
  if (periodFrom === null || periodTo === null) throw new StatementError('账期不对：日期不存在');
  if (periodFrom > periodTo) throw new StatementError('账期不对：开始日晚于结束日');
  const oneYearLater = `${Number(periodFrom.slice(0, 4)) + 1}${periodFrom.slice(4)}`;
  if (periodTo >= oneYearLater) {
    throw new StatementError('账期超过 12 个月，还没见过这么长的 BOQ 对账单');
  }
  return { periodFrom, periodTo };
}

// R1F：表头之前 Account number  那一行，9 位数字（不含 BSB）
function readAccountDigits(beforeHeader: StatementLine[]): string {
  const line = beforeHeader.find((l) => l.text.startsWith('Account number '));
  const digits = line ? (ACCOUNT_LINE.exec(line.text)?.[1] ?? '') : '';
  if (!/^\d{9}$/.test(digits)) throw new StatementError('找不到账号');
  return digits;
}

// R1F 汇总：表头之前，四行各取第一个以标签开头的
function readSummary(beforeHeader: StatementLine[]) {
  const read = ({ label, pattern }: (typeof SUMMARY)[keyof typeof SUMMARY]) => {
    const line = beforeHeader.find((l) => l.text.startsWith(`${label} `));
    const match = line ? pattern.exec(line.text) : null;
    if (!match) throw new StatementError('找不到汇总');
    return { sign: match[1], raw: match[2] };
  };
  const opening = read(SUMMARY.opening);
  const credits = read(SUMMARY.credits);
  const debits = read(SUMMARY.debits);
  const closing = read(SUMMARY.closing);
  if (opening.sign === '-' || closing.sign === '-') throw new StatementError(OVERDRAFT_MESSAGE);
  return {
    opening: toCents(opening.raw, '汇总的期初', parseBalanceToCents),
    credits: toCents(credits.raw, '汇总的 Total credits', parseBalanceToCents),
    debits: toCents(debits.raw, '汇总的 Total debits', parseBalanceToCents),
    closing: toCents(closing.raw, '汇总的期末', parseBalanceToCents),
  };
}

// ---------- 交易表 ----------

// R1F 年份行：第一个表头下面，可选的一个字母那行，然后 YYYY。返回年份和下一行的位置
function readYearRow(lines: StatementLine[], headerAt: number, periodFrom: string) {
  let at = headerAt + 1;
  if (LETTER_ROW.test(lines[at]?.text ?? '')) at += 1;
  const line = lines[at];
  if (!line || !YEAR_ROW.test(line.text)) {
    throw new StatementError('找不到年份', lines[headerAt].page, null);
  }
  if (line.text !== periodFrom.slice(0, 4)) throw new StatementError('年份行和账期对不上');
  return { year: Number(line.text), next: at + 1 };
}

// 第一个表头起往后的行 → 交易，表里的顺序（旧的在前）。每页的表从表头到页脚
function readTable(
  lines: StatementLine[],
  headerAt: number,
  periodFrom: string,
  periodTo: string,
): Transaction[] {
  const { year: firstYear, next } = readYearRow(lines, headerAt, periodFrom);
  const transactions: Transaction[] = [];
  const countByPage = new Map<number, number>();
  let pending: Transaction | null = null;
  let inTable = true;
  let year = firstYear;
  let previous: { date: string; month: number } | null = null;

  for (const { page, text } of lines.slice(next)) {
    // R1F：页脚结束这一页的表；表头开始下一页的表（换页后不再印年份行）
    if (FOOTER.test(text)) {
      if (pending) transactions.push(pending);
      pending = null;
      inTable = false;
      continue;
    }
    if (TABLE_HEADER.test(text)) {
      if (pending) transactions.push(pending);
      pending = null;
      inTable = true;
      continue;
    }
    if (!inTable) continue; // 标题、小标题、说明页

    const start = TRANSACTION_START.exec(text);
    if (start) {
      if (pending) transactions.push(pending);
      pending = null;
      const index = (countByPage.get(page) ?? 0) + 1;
      countByPage.set(page, index);
      const at: Position = { page, index };

      const [, day, monthName, processedDay, processedMonth, rest] = start;
      const month = MONTHS.indexOf(monthName) + 1;
      // R1F 年份：月份比上一笔小（如 Dec → Jan）就加一年（照 R1E）
      if (previous && month < previous.month) year += 1;
      const date = toIsoDate(day, month, year);
      if (date === null) throw rowError(at, `的日期不对：${day}-${monthName}`);
      // R1F：交易日期用 Date，和 Processed 不一样的没见过
      if (`${day}-${monthName}` !== `${processedDay}-${processedMonth}`) {
        throw rowError(at, '的 Date 和 Processed 不一样，还没见过');
      }
      if (previous && date < previous.date) {
        throw rowError(at, `的日期比上一笔早：${date} 早于 ${previous.date}`);
      }
      if (date < periodFrom || date > periodTo) {
        throw rowError(at, `的日期不在账期里：${date} 不在 ${periodFrom} 到 ${periodTo} 里`);
      }
      previous = { date, month };

      pending = { ...at, date, ...readFirstLine(rest, at) };
    } else if (pending) {
      addContinuation(pending, text);
    } else {
      // R1F：表头（或年份行）下面不是新的一笔。不带这一行的内容，免得带出号码
      const last = transactions.at(-1);
      if (last && last.page !== page) {
        throw rowError(last, '跨页了，还没见过跨页的交易');
      }
      throw new StatementError('交易表里第一笔上面有一行认不出来', page, null);
    }
  }

  if (pending) transactions.push(pending);
  return transactions;
}

// R1F 一笔的第一行：两个日期之后是描述，末尾是金额和余额（余额是 0 时不印）
function readFirstLine(rest: string, at: Position) {
  const end = FIRST_LINE_END.exec(rest);
  if (!end) throw rowError(at, '找不到金额');
  const [, before, rawAmount, rawBalance] = end;
  if (rawBalance?.startsWith('-')) throw new StatementError(OVERDRAFT_MESSAGE, at.page, at.index);
  const description = before.trim();
  return {
    amountCents: toCents(rawAmount, '金额', parseAmountToCents, at),
    balanceCents:
      rawBalance === undefined ? null : toCents(rawBalance, '余额', parseBalanceToCents, at),
    parts: description === '' ? [] : [description],
    lineCount: 1,
  };
}

// R1F 续行的保护：像年份行、像金额、超过 3 行都失败，免得页脚、年份行变了样悄悄混进描述
function addContinuation(pending: Transaction, text: string) {
  if (YEAR_ROW.test(text) || LETTER_ROW.test(text)) {
    throw rowError(pending, '下面有一行像年份行，还没见过跨年时的样子');
  }
  if (ENDS_WITH_MONEY.test(text)) throw rowError(pending, '下面有一行像金额，认不出来');
  pending.lineCount += 1;
  if (pending.lineCount > MAX_DESCRIPTION_LINES) {
    throw rowError(pending, `的描述超过 ${MAX_DESCRIPTION_LINES} 行，还没见过`);
  }
  pending.parts.push(text);
}

// ---------- 工具 ----------

// 1,234.56 → 去掉千分位逗号，按 R1.0-4 转成分。调用前已经用正则检查过格式
function toCents(
  raw: string,
  label: string,
  parser: (input: string) => number,
  at: Position | null = null,
): number {
  try {
    return parser(raw.replace(/,/g, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (at === null) throw new StatementError(`${label}：${reason}`);
    throw rowError(at, `的${label}：${reason}`);
  }
}

// 错误带页码和这一页的第几笔（R1F 检查）
function rowError(at: Position, message: string): StatementError {
  return new StatementError(`第 ${at.index} 笔${message}`, at.page, at.index);
}

// 日、月、四位年 → YYYY-MM-DD，日期不存在时返回 null。复用 R1.0-3，不转 JS Date
function toIsoDate(day: string, month: number, year: number): string | null {
  if (month < 1) return null;
  try {
    return parseAuDate(`${day}/${String(month).padStart(2, '0')}/${year}`);
  } catch {
    return null;
  }
}

// 错误信息里的金额
const cents = formatAud;
