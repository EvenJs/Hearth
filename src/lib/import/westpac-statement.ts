// Westpac PDF 对账单解析（business-rules.md R1G 第二层）
// 输入是 src/server/pdf/ 读出来的行 { page, text }[]，输出和 R1E 一样的形状
// 不抛错，返回结果对象。任何一条检查不过，整份失败，什么都不返回
// 纯函数，不 import 数据库和 Next.js
import type { StatementLine } from './anz-statement';
import { parseAuDate } from '@/lib/rules/date';
import { formatAud, parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import type { ParsedRow } from '@/lib/rules/types';

export type ParseWestpacStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 旧的在前（就是表里的顺序，R1G，同 R1D）。balanceCents 是每笔余额（R4.1）
      periodFrom: string; // YYYY-MM-DD，账期是闭区间 [periodFrom, periodTo]（R1G，同 R1D、R1E）
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

// R1G 账期的月份是英文全称
const MONTHS = [
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
const MONTH = `(${MONTHS.join('|')})`;

// 金额：1,234.56，千分位逗号可有可无，没有 $、没有正负号
const MONEY = '((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})';
// 交易表里的日期：DD/MM/YY
const SHORT_DATE = '(\\d{2})\\/(\\d{2})\\/(\\d{2})';

// R1G 认格式：第 1 页第 1 行整行 Statement Period + 有表头 + 有 STATEMENT OPENING BALANCE
const TITLE = 'Statement Period';
const NOT_WESTPAC_MESSAGE = '这不像 Westpac 对账单';

// R1G 第 1 页第 2 行：DD Month YYYY - DD Month YYYY
const PERIOD = new RegExp(`^(\\d{2}) ${MONTH} (\\d{4}) - (\\d{2}) ${MONTH} (\\d{4})$`);

// R1G 账号：以 BSB  Account Number 结尾那行的下一行，ddd-ddd  ddd ddd
const ACCOUNT_LABEL = /\sBSB\s+Account Number$/;
const ACCOUNT_LINE = /^\d{3}-\d{3}\s{2,}(.+)$/;

// R1G 汇总：表头之前，整行。期初期末可以带 + 也可以不带，- 是透支
const SUMMARY = {
  opening: { label: 'Opening Balance', pattern: new RegExp(`^Opening Balance\\s+(?:([+-]) )?\\$${MONEY}$`) },
  credits: { label: 'Total Credits', pattern: new RegExp(`^Total Credits\\s+(\\+) \\$${MONEY}$`) },
  debits: { label: 'Total Debits', pattern: new RegExp(`^Total Debits\\s+(-) \\$${MONEY}$`) },
  closing: { label: 'Closing Balance', pattern: new RegExp(`^Closing Balance\\s+(?:([+-]) )?\\$${MONEY}$`) },
} as const;

// R1G 交易表
const TABLE_HEADER = /^DATE\s+TRANSACTION DESCRIPTION\s+DEBIT\s+CREDIT\s+BALANCE$/;
const OPENING_ROW = new RegExp(`^${SHORT_DATE}\\s+STATEMENT OPENING BALANCE\\s+${MONEY}$`);
const CLOSING_ROW = new RegExp(`^${SHORT_DATE}\\s+CLOSING BALANCE\\s+${MONEY}$`);
const TRANSACTION_START = new RegExp(`^${SHORT_DATE} {2}(.*)$`);
// 一笔的最后一行：…  金额  余额。三个以上金额时只取最后两个，前面的留在描述里
const TRANSACTION_END = new RegExp(`^(?:(.*?)\\s+)?${MONEY}\\s+${MONEY}$`);

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
  unsignedCents: number; // 方向在余额检查时判断
  balanceCents: number;
  description: string;
};

// 读到一半的一笔：金额余额还没出现
type Pending = Position & {
  date: string;
  parts: string[];
  amount: { unsignedCents: number; balanceCents: number } | null;
};

export function parseWestpacStatement(
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseWestpacStatementResult {
  try {
    return parse(cleanLines(lines), accountSuffix);
  } catch (error) {
    if (error instanceof StatementError) {
      return { ok: false, message: error.message, page: error.page, index: error.index };
    }
    throw error;
  }
}

// R1G 认格式（自动选解析器用）
export function looksLikeWestpacStatement(lines: readonly StatementLine[]): boolean {
  return isWestpac(cleanLines(lines));
}

// 去首尾空白，空行跳过
function cleanLines(lines: readonly StatementLine[]): StatementLine[] {
  return lines.map((l) => ({ page: l.page, text: l.text.trim() })).filter((l) => l.text !== '');
}

// R1G 认格式：三条缺一条就不是
function isWestpac(lines: StatementLine[]): boolean {
  return (
    lines[0]?.page === 1 &&
    lines[0].text === TITLE &&
    lines.some((l) => TABLE_HEADER.test(l.text)) &&
    lines.some((l) => OPENING_ROW.test(l.text))
  );
}

function parse(lines: StatementLine[], accountSuffix: string | null): ParseWestpacStatementResult {
  if (!isWestpac(lines)) throw new StatementError(NOT_WESTPAC_MESSAGE);
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));
  const beforeHeader = lines.slice(0, headerAt);

  const { periodFrom, periodTo } = readPeriod(lines[1]);

  // R1G：账号只拿来核对，不返回、不写进错误信息
  if (!accountSuffix) {
    throw new StatementError('这个账户还没填账号尾号，先去账户设置填，才能核对对账单');
  }
  if (!readAccountDigits(beforeHeader).endsWith(accountSuffix)) {
    throw new StatementError('这份对账单不是这个账户的');
  }

  // R1G：表头下面紧挨着 STATEMENT OPENING BALANCE，后面某一行是 CLOSING BALANCE
  const openingAt = headerAt + 1;
  const opening = readBalanceRow(lines[openingAt], OPENING_ROW);
  if (!opening) throw new StatementError('找不到 OPENING BALANCE');
  const closingOffset = lines.slice(openingAt + 1).findIndex((l) => CLOSING_ROW.test(l.text));
  if (closingOffset === -1) throw new StatementError('找不到 CLOSING BALANCE');
  const closingAt = openingAt + 1 + closingOffset;
  const closing = readBalanceRow(lines[closingAt], CLOSING_ROW);
  if (!closing) throw new StatementError('找不到 CLOSING BALANCE');

  // R1G：表头到表底必须在同一页，先查这一条再逐笔读
  if (lines[closingAt].page !== lines[openingAt].page) {
    throw new StatementError(
      '交易表跨页了，还没见过跨页的 Westpac 对账单',
      lines[headerAt].page,
      null,
    );
  }

  if (opening.date !== periodFrom || closing.date !== periodTo) {
    throw new StatementError('账期和 OPENING / CLOSING BALANCE 的日期对不上');
  }

  const summary = readSummary(beforeHeader);

  const transactions = readTable(
    lines.slice(openingAt + 1, closingAt),
    lines[openingAt].page,
    opening.date,
    periodFrom,
    periodTo,
  );

  // R1G：表里旧的在前，用上一笔余额判断方向，同时就是"期初 + 逐笔 = 每一笔的余额"
  const amounts: number[] = [];
  let balance = opening.cents;
  let debits = 0;
  let credits = 0;
  for (const t of transactions) {
    let amount: number;
    if (balance - t.unsignedCents === t.balanceCents) amount = -t.unsignedCents;
    else if (balance + t.unsignedCents === t.balanceCents) amount = t.unsignedCents;
    else {
      throw new StatementError(
        `第 ${t.index} 笔余额接不上：上一笔余额 ${cents(balance)} 加减 ${cents(t.unsignedCents)} 都不等于 ${cents(t.balanceCents)}`,
        t.page,
        t.index,
      );
    }
    if (amount < 0) debits += t.unsignedCents;
    else credits += t.unsignedCents;
    amounts.push(amount);
    balance = t.balanceCents;
  }

  // R1G：最后一笔的余额 = CLOSING BALANCE；一笔都没有时 OPENING = CLOSING
  if (balance !== closing.cents) {
    throw new StatementError(
      transactions.length === 0
        ? `没有交易，但 OPENING BALANCE ${cents(opening.cents)} 和 CLOSING BALANCE ${cents(closing.cents)} 不一样`
        : `最后一笔的余额是 ${cents(balance)}，CLOSING BALANCE 是 ${cents(closing.cents)}`,
    );
  }

  // R1G 汇总：期初期末和表里一致，借贷合计和逐笔一致（都按正数比）
  if (summary.opening !== opening.cents) {
    throw new StatementError(
      `汇总的期初是 ${cents(summary.opening)}，OPENING BALANCE 是 ${cents(opening.cents)}`,
    );
  }
  if (summary.closing !== closing.cents) {
    throw new StatementError(
      `汇总的期末是 ${cents(summary.closing)}，CLOSING BALANCE 是 ${cents(closing.cents)}`,
    );
  }
  if (summary.debits !== debits) {
    throw new StatementError(
      `逐笔借合计是 ${cents(debits)}，汇总的 Total Debits 是 ${cents(summary.debits)}`,
    );
  }
  if (summary.credits !== credits) {
    throw new StatementError(
      `逐笔贷合计是 ${cents(credits)}，汇总的 Total Credits 是 ${cents(summary.credits)}`,
    );
  }

  // R1G：输出旧的在前（表里的顺序，同 R1D），rowIndex 按输出顺序从 1 开始
  return {
    ok: true,
    rows: transactions.map((t, i) => ({
      date: t.date,
      amountCents: amounts[i],
      description: t.description,
      balanceCents: t.balanceCents, // R1G、R4.1：Westpac 的 key 放余额
      rowIndex: i + 1,
    })),
    periodFrom,
    periodTo,
    openingCents: opening.cents,
    closingCents: closing.cents,
  };
}

// ---------- 表头部分 ----------

// R1G 账期：第 1 页第 2 行整行，闭区间，日期带年份；不能超过 12 个月
function readPeriod(line: StatementLine | undefined) {
  const match = line?.page === 1 ? PERIOD.exec(line.text) : null;
  if (!match) throw new StatementError('找不到账期');
  const [, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
  const periodFrom = toIsoDate(fromDay, MONTHS.indexOf(fromMonth) + 1, fromYear);
  const periodTo = toIsoDate(toDay, MONTHS.indexOf(toMonth) + 1, toYear);
  if (periodFrom === null || periodTo === null) throw new StatementError('账期不对：日期不存在');
  if (periodFrom > periodTo) throw new StatementError('账期不对：开始日晚于结束日');
  const oneYearLater = `${Number(periodFrom.slice(0, 4)) + 1}${periodFrom.slice(4)}`;
  if (periodTo >= oneYearLater) {
    throw new StatementError('账期超过 12 个月，还没见过这么长的 Westpac 对账单');
  }
  return { periodFrom, periodTo };
}

// R1G：BSB  Account Number 那行的下一行，两个空格后面那段去掉空格是 6 位（不含 BSB）
function readAccountDigits(beforeHeader: StatementLine[]): string {
  const labelAt = beforeHeader.findIndex((l) => ACCOUNT_LABEL.test(l.text));
  const match = labelAt === -1 ? null : ACCOUNT_LINE.exec(beforeHeader[labelAt + 1]?.text ?? '');
  const digits = match ? match[1].replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(digits)) throw new StatementError('找不到账号');
  return digits;
}

// STATEMENT OPENING BALANCE / CLOSING BALANCE 那行：DD/MM/YY，最后一段是余额
function readBalanceRow(line: StatementLine | undefined, pattern: RegExp) {
  const match = line ? pattern.exec(line.text) : null;
  if (!line || !match) return null;
  const [, day, month, year, rawBalance] = match;
  const date = toIsoDate(day, Number(month), `20${year}`);
  if (date === null) throw new StatementError(`${day}/${month}/${year} 日期不对`);
  return { date, cents: toCents(rawBalance, '余额', parseBalanceToCents) };
}

// R1G 汇总：表头之前，四行各取第一个以标签开头的
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
    credits: toCents(credits.raw, '汇总的 Total Credits', parseBalanceToCents),
    debits: toCents(debits.raw, '汇总的 Total Debits', parseBalanceToCents),
    closing: toCents(closing.raw, '汇总的期末', parseBalanceToCents),
  };
}

// ---------- 交易表 ----------

// STATEMENT OPENING BALANCE 和 CLOSING BALANCE 之间的行 → 交易，表里的顺序（旧的在前）
function readTable(
  lines: StatementLine[],
  openingPage: number,
  openingDate: string,
  periodFrom: string,
  periodTo: string,
): Transaction[] {
  const transactions: Transaction[] = [];
  const countByPage = new Map<number, number>();
  let pending: Pending | null = null;
  let previousDate = openingDate;

  for (const { page, text } of lines) {
    const start = TRANSACTION_START.exec(text);
    if (start) {
      if (pending) throw rowError(pending, '找不到金额和余额');
      const index = (countByPage.get(page) ?? 0) + 1;
      countByPage.set(page, index);
      const at: Position = { page, index };

      // R1G：两位年份 YY → 20YY
      const [, day, month, year, rest] = start;
      const date = toIsoDate(day, Number(month), `20${year}`);
      if (date === null) throw rowError(at, `的日期不对：${day}/${month}/${year}`);
      if (date < previousDate) throw rowError(at, `的日期比上一笔早：${date} 早于 ${previousDate}`);
      if (date < periodFrom || date > periodTo) {
        throw rowError(at, `的日期不在账期里：${date} 不在 ${periodFrom} 到 ${periodTo} 里`);
      }
      previousDate = date;

      pending = { ...at, date, parts: [], amount: null };
      addPart(pending, rest);
    } else if (pending) {
      addPart(pending, text); // R1G：续行，Osko 的第 2 行
    } else {
      // R1G：上一笔已经结束，这一行又不是新的一笔。不带这一行的内容，免得带出号码
      const last = transactions.at(-1);
      throw new StatementError(
        `交易表里${last ? `第 ${last.index} 笔` : ' OPENING BALANCE '}下面有一行认不出来`,
        last?.page ?? openingPage,
        last?.index ?? null,
      );
    }

    if (pending.amount) {
      transactions.push({
        page: pending.page,
        index: pending.index,
        date: pending.date,
        ...pending.amount,
        description: pending.parts.join(' '), // R1G：各段用一个空格拼
      });
      pending = null;
    }
  }

  if (pending) throw rowError(pending, '找不到金额和余额'); // 下一行就是 CLOSING BALANCE
  return transactions;
}

// 一笔的一行：末尾有金额余额就结束这一笔；剩下的部分进描述
function addPart(pending: Pending, text: string) {
  let description = text;
  const end = TRANSACTION_END.exec(text);
  if (end) {
    const [, before = '', rawAmount, rawBalance] = end;
    pending.amount = {
      unsignedCents: toCents(rawAmount, '金额', parseAmountToCents, pending),
      balanceCents: toCents(rawBalance, '余额', parseBalanceToCents, pending),
    };
    description = before;
  }
  description = description.trim();
  if (description !== '') pending.parts.push(description);
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

// 错误带页码和这一页的第几笔（R1G 检查）
function rowError(at: Position, message: string): StatementError {
  return new StatementError(`第 ${at.index} 笔${message}`, at.page, at.index);
}

// 日、月、四位年 → YYYY-MM-DD，日期不存在时返回 null。复用 R1.0-3，不转 JS Date
function toIsoDate(day: string, month: number, year: string): string | null {
  if (month < 1) return null;
  try {
    return parseAuDate(`${day}/${String(month).padStart(2, '0')}/${year}`);
  } catch {
    return null;
  }
}

// 错误信息里的金额
const cents = formatAud;
