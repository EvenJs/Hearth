// ANZ Plus PDF 对账单解析（business-rules.md R1D 第二层）
// 输入是 src/server/pdf/ 读出来的行 { page, text }[]，输出和 R1C 一样的形状，外加 Interest Earned
// 不抛错，返回结果对象。任何一条检查不过，整份失败，什么都不返回
// 纯函数，不 import 数据库和 Next.js
import type { StatementLine } from './anz-statement';
import { parseAuDate } from '@/lib/rules/date';
import { formatAud, parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import type { ParsedRow } from '@/lib/rules/types';

export type ParseAnzPlusStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 旧的在前（表里是新的在前，反过来）。balanceCents 是每行余额（R1D、R4.1）
      periodFrom: string; // YYYY-MM-DD，账期是闭区间 [periodFrom, periodTo]（R1D，和 R1C 不一样）
      periodTo: string;
      openingCents: number;
      closingCents: number;
      interestEarnedCents: number; // 没有 Interest Earned 那一行时是 0
    }
  | {
      ok: false;
      message: string; // 不含 BSB 和完整账号，最多带后 4 位
      page: number | null; // 出错交易所在的页，和交易无关的错误为 null
      index: number | null; // 这一页的第几笔，从 1 开始
    };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// R1D 认格式：整行 Account Statement + 表头之前以 ANZ Plus 开头的产品名
const TITLE = 'Account Statement';
const PRODUCT_PREFIX = 'ANZ Plus ';
const NOT_ANZ_PLUS_MESSAGE = '这不像 ANZ Plus 对账单';

// R1D 账期：D Month YYYY - D Month YYYY，后面同一行是户名
const PERIOD = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4}) - (\d{1,2}) ([A-Z][a-z]+) (\d{4})(?=\s|$)/;

// R1D 汇总：标签一行，下一行是 BSB、账号、期初、期末 4 段
const SUMMARY_LABEL = /Account Number\s+Opening Balance\s+Closing Balance$/;
const BSB = /^\d{3} \d{3}$/;
const ACCOUNT_NUMBER = /^\d+(?: \d+)*$/;
const INTEREST_LABEL = /^Interest Earned\b/;
const INTEREST_AMOUNT = /^\+ (\S+)$/; // + $25.00

// 金额：$1,234.56，千分位逗号可有可无。负号、括号没见过，不认
const MONEY = /^\$((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/;
// 两个以上空格分段
const SEGMENTS = /\s{2,}/;

// R1D 交易表
const TABLE_HEADER = /^Date\s+Description\s+Credit\s+Debit\s+Balance$/;
const TABLE_BOTTOM = /^Opening Balance\b/;
const EFFECTIVE_DATE = /^Effective Date\b/;
const TRANSACTION_START = new RegExp(`^(\\d{2}) (${MONTHS.join('|')})(?=\\s|$)(.*)$`);
const LAST_TWO = /^(.*?)\s+(\S+)\s+(\S+)$/;
const INTEREST_ROW = /CREDIT INTEREST/;

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
  unsignedCents: number; // 方向在余额检查时判断
  balanceCents: number;
  description: string;
};

export function parseAnzPlusStatement(
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseAnzPlusStatementResult {
  try {
    return parse(
      lines.map((l) => ({ page: l.page, text: l.text.trim() })).filter((l) => l.text !== ''),
      accountSuffix,
    );
  } catch (error) {
    if (error instanceof StatementError) {
      return { ok: false, message: error.message, page: error.page, index: error.index };
    }
    throw error;
  }
}

function parse(lines: StatementLine[], accountSuffix: string | null): ParseAnzPlusStatementResult {
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));
  const beforeHeader = headerAt === -1 ? lines : lines.slice(0, headerAt);

  // R1D 认格式：两条缺一条就不是。页脚说明里的 ANZ Plus 在表头之后，不算
  const hasTitle = lines.some((l) => l.text === TITLE);
  const hasProduct = beforeHeader.some((l) => l.text.startsWith(PRODUCT_PREFIX));
  if (!hasTitle || !hasProduct) throw new StatementError(NOT_ANZ_PLUS_MESSAGE);

  const { periodFrom, periodTo } = readPeriod(lines);

  // R1D：账号只拿来核对，不返回、不写进错误信息
  if (!accountSuffix) {
    throw new StatementError('这个账户还没填账号尾号，先去账户设置填，才能核对对账单');
  }
  const summary = readSummary(beforeHeader);
  if (!summary.accountDigits.endsWith(accountSuffix)) {
    throw new StatementError('这份对账单不是这个账户的');
  }
  const interest = readInterestEarned(beforeHeader);

  if (headerAt === -1) throw new StatementError('找不到交易表');
  const { transactions, openingRowCents } = readTable(lines, headerAt, periodFrom, periodTo);

  // R1D：表底的 Opening Balance = 汇总的期初。先查这一条，余额链从汇总的期初开始
  if (openingRowCents !== summary.opening) {
    throw new StatementError(
      `交易表的 Opening Balance 是 ${cents(openingRowCents)}，汇总的期初是 ${cents(summary.opening)}`,
    );
  }

  // R1D：从表底往上，用上一笔余额判断方向，同时就是"期初 + 逐笔 = 每行余额"
  const oldestFirst = [...transactions].reverse();
  const amounts: number[] = [];
  let balance = summary.opening;
  for (const t of oldestFirst) {
    let amount: number;
    if (balance + t.unsignedCents === t.balanceCents) amount = t.unsignedCents;
    else if (balance - t.unsignedCents === t.balanceCents) amount = -t.unsignedCents;
    else {
      throw new StatementError(
        `第 ${t.index} 笔余额接不上：上一笔余额 ${cents(balance)} 加减 ${cents(t.unsignedCents)} 都不等于 ${cents(t.balanceCents)}`,
        t.page,
        t.index,
      );
    }
    amounts.push(amount);
    balance = t.balanceCents;
  }

  // R1D：最新一笔的余额 = 汇总的期末；一笔都没有时期初 = 期末
  if (balance !== summary.closing) {
    throw new StatementError(
      transactions.length === 0
        ? `没有交易，但汇总的期初 ${cents(summary.opening)} 和期末 ${cents(summary.closing)} 不一样`
        : `最新一笔的余额是 ${cents(balance)}，汇总的期末是 ${cents(summary.closing)}`,
    );
  }

  // R1D：利息行合计 = Interest Earned，没有这一项当 0
  const interestTotal = oldestFirst.reduce(
    (total, t, i) => (INTEREST_ROW.test(t.description) ? total + amounts[i] : total),
    0,
  );
  if (interestTotal !== interest.cents) {
    throw new StatementError(
      interest.found
        ? `利息行合计是 ${cents(interestTotal)}，Interest Earned 是 ${cents(interest.cents)}`
        : `利息行合计是 ${cents(interestTotal)}，但对账单上没有 Interest Earned（当 0）`,
    );
  }

  return {
    ok: true,
    // R1D：旧的在前，rowIndex 按输出顺序从 1 开始
    rows: oldestFirst.map((t, i) => ({
      date: t.date,
      amountCents: amounts[i],
      description: t.description,
      balanceCents: t.balanceCents, // R1D、R4.1：ANZ Plus 的 key 放余额
      rowIndex: i + 1,
    })),
    periodFrom,
    periodTo,
    openingCents: summary.opening,
    closingCents: summary.closing,
    interestEarnedCents: interest.cents,
  };
}

// ---------- 表头部分 ----------

// R1D 账期：闭区间，跨年还没见过，整份失败
function readPeriod(lines: StatementLine[]) {
  const match = lines.map((l) => PERIOD.exec(l.text)).find((m) => m !== null);
  if (!match) throw new StatementError('找不到账期');
  const [, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
  if (fromYear !== toYear) {
    throw new StatementError('账期跨年了，还没见过跨年的 ANZ Plus 对账单');
  }
  const periodFrom = fullDate(fromDay, fromMonth, fromYear);
  const periodTo = fullDate(toDay, toMonth, toYear);
  if (periodFrom > periodTo) throw new StatementError('账期不对：开始日晚于结束日');
  return { periodFrom, periodTo };
}

// R1D 汇总：标签行的下一行正好 4 段
function readSummary(lines: StatementLine[]) {
  const at = lines.findIndex((l) => SUMMARY_LABEL.test(l.text));
  const values = at === -1 ? undefined : lines[at + 1]?.text.split(SEGMENTS);
  if (
    !values ||
    values.length !== 4 ||
    !BSB.test(values[0]) ||
    !ACCOUNT_NUMBER.test(values[1]) ||
    !MONEY.test(values[2]) ||
    !MONEY.test(values[3])
  ) {
    throw new StatementError('找不到期初期末');
  }
  return {
    accountDigits: values[1].replace(/ /g, ''),
    opening: toCents(values[2], '期初', parseBalanceToCents),
    closing: toCents(values[3], '期末', parseBalanceToCents),
  };
}

// R1D：Interest Earned 那行的下一行第一段是 + $25.00；没有这一行当 0
function readInterestEarned(lines: StatementLine[]): { found: boolean; cents: number } {
  const at = lines.findIndex((l) => INTEREST_LABEL.test(l.text));
  if (at === -1) return { found: false, cents: 0 };
  const first = lines[at + 1]?.text.split(SEGMENTS)[0] ?? '';
  const match = INTEREST_AMOUNT.exec(first);
  if (!match || !MONEY.test(match[1])) throw new StatementError('Interest Earned 读不出金额');
  return { found: true, cents: toCents(match[1], 'Interest Earned', parseBalanceToCents) };
}

// ---------- 交易表 ----------

function readTable(lines: StatementLine[], headerAt: number, periodFrom: string, periodTo: string) {
  const headerPage = lines[headerAt].page;
  const bottomOffset = lines.slice(headerAt + 1).findIndex((l) => TABLE_BOTTOM.test(l.text));
  if (bottomOffset === -1) throw new StatementError('找不到交易表的 Opening Balance');
  const bottomAt = headerAt + 1 + bottomOffset;
  const bottom = lines[bottomAt];

  // R1D：表头到表底必须在同一页
  if (bottom.page !== headerPage) {
    throw new StatementError('交易表跨页了，还没见过跨页的 ANZ Plus 对账单', headerPage);
  }

  // R1D：表底最后一段是期初
  const openingRaw = bottom.text.split(SEGMENTS).at(-1) ?? '';
  if (!MONEY.test(openingRaw)) throw new StatementError('交易表的 Opening Balance 读不出金额');
  const openingRowCents = toCents(openingRaw, '交易表的 Opening Balance', parseBalanceToCents);

  const year = periodFrom.slice(0, 4); // R1D：跨年已经在账期那里拦了
  const transactions: Transaction[] = []; // 表里的顺序，新的在前

  for (const { text } of lines.slice(headerAt + 1, bottomAt)) {
    if (EFFECTIVE_DATE.test(text)) continue; // 实际日期，不拼进描述

    const start = TRANSACTION_START.exec(text);
    if (!start) {
      // R1D：没见过描述换行，表里认不出来的行整份失败。不带这一行的内容，免得带出号码
      const last = transactions.at(-1);
      throw new StatementError(
        `交易表里${last ? `第 ${last.index} 笔` : '表头'}下面有一行认不出来`,
        headerPage,
        last?.index ?? null,
      );
    }

    const at: Position = { page: headerPage, index: transactions.length + 1 };
    const [, day, monthName, rest] = start;

    const date = toIsoDate(day, MONTHS.indexOf(monthName) + 1, year);
    if (date === null) throw rowError(at, `的日期不对：${day} ${monthName}`);
    if (date < periodFrom || date > periodTo) {
      throw rowError(at, `的日期不在账期里：${date} 不在 ${periodFrom} 到 ${periodTo} 里`);
    }

    // R1D：最后两段是金额、余额，空的那栏是真的空
    const two = LAST_TWO.exec(rest);
    if (!two || !MONEY.test(two[2]) || !MONEY.test(two[3])) {
      throw rowError(at, '认不出金额和余额');
    }
    const [, description, rawAmount, rawBalance] = two;
    transactions.push({
      ...at,
      date,
      unsignedCents: toCents(rawAmount, '金额', parseAmountToCents, at),
      balanceCents: toCents(rawBalance, '余额', parseBalanceToCents, at),
      description: description.trim(), // R1.0-5
    });
  }

  return { transactions, openingRowCents };
}

// ---------- 工具 ----------

// $1,234.56 → 去掉 $ 和千分位逗号，按 R1.0-4 转成分。调用前已经用 MONEY 检查过格式
function toCents(
  raw: string,
  label: string,
  parser: (input: string) => number,
  at: Position | null = null,
): number {
  try {
    return parser(raw.replace(/[$,]/g, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (at === null) throw new StatementError(`${label}：${reason}`);
    throw rowError(at, `的${label}：${reason}`);
  }
}

// 错误带页码和这一页的第几笔（R1D 检查）
function rowError(at: Position, message: string): StatementError {
  return new StatementError(`第 ${at.index} 笔${message}`, at.page, at.index);
}

function fullDate(day: string, monthName: string, year: string): string {
  const date = toIsoDate(day, FULL_MONTHS.indexOf(monthName) + 1, year);
  if (date === null) throw new StatementError(`账期不对：${day} ${monthName} ${year}`);
  return date;
}

// 日、月、年 → YYYY-MM-DD，日期不存在时返回 null。复用 R1.0-3，不转 JS Date
function toIsoDate(day: string, month: number, year: string): string | null {
  if (month < 1 || month > 12) return null;
  try {
    return parseAuDate(`${day.padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`);
  } catch {
    return null;
  }
}

// 错误信息里的金额
const cents = formatAud;
