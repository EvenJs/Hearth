// ANZ PDF 对账单解析（business-rules.md R1C 第二层）
// 输入是 src/server/pdf/ 读出来的行 { page, text }[]，输出和 R1 一样的 ParsedRow[]，外加账期和期初期末
// 不抛错，返回结果对象。任何一条检查不过，整份失败，什么都不返回
// 纯函数，不 import 数据库和 Next.js
import { parseAuDate } from '@/lib/rules/date';
import { formatAud, parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import { addDays } from '@/lib/rules/periods';
import type { ParsedRow } from '@/lib/rules/types';

export type StatementLine = { page: number; text: string };

export type ParseStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 文件顺序，旧的在前。balanceCents 都是 null（R1C：余额不进 key）
      periodFrom: string; // YYYY-MM-DD，账期是 (periodFrom, periodTo]
      periodTo: string;
      openingCents: number;
      closingCents: number;
    }
  | {
      ok: false;
      message: string; // 不含完整账号
      page: number | null; // 出错交易所在的页，和交易无关的错误为 null
      index: number | null; // 这一页的第几笔，从 1 开始
    };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const FULL_MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
];

// R1C 表头
const PERIOD = /(\d{2}) ([A-Z]+) (\d{4}) TO (\d{2}) ([A-Z]+) (\d{4})/;
const ACCOUNT_LABEL = 'Account Number';
// 前后不能再连着数字或 -，免得从别的长号码里截一段
const ACCOUNT_NUMBER = /(?<![\d-])(\d{4}-\d{5})(?![\d-])/;
// R1C：账号在标签那行或后面 3 行里，汇总金额在标签那行或后面 4 行里
const ACCOUNT_LOOKAHEAD = 3;
const SUMMARY_LOOKAHEAD = 4;
const SUMMARY_LABELS = {
  opening: 'Opening Balance',
  closing: 'Closing Balance',
  deposits: 'Total Deposits',
  withdrawals: 'Total Withdrawals',
} as const;
type SummaryKey = keyof typeof SUMMARY_LABELS;
// 汇总金额：前面是行首、空白或 $，取一行里的第一个
const SUMMARY_AMOUNT = /(?:^|[\s$])(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d.,])/;

// R1C 交易行：DD MON 开头，最后三段是支出、存入、余额
const TRANSACTION_START = new RegExp(`^(\\d{2}) (${MONTHS.join('|')})(?=\\s|$)(.*)$`);
const LAST_THREE = /^(.*?)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const LAST_TWO = /^(.*?)\s+(\S+)\s+(\S+)$/;
const BLANK = 'blank';
// 金额：千分位逗号可有可无，两位小数
const AMOUNT_WITH_COMMAS = /^-?(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/;

// R1C 跳过的行
const YEAR_ONLY = /^(\d{4})(?:\s+blank)+$/; // 2026  blank  blank
const EFFECTIVE_DATE = /^EFFECTIVE DATE\b/;
// 这些行之后不会再有上一笔的续行（换页、合计、页眉）
const PAGE_FURNITURE = [
  /^(blank\s+)?TOTALS AT END OF (PAGE|PERIOD)\b/, // 前面可能多一个 blank
  /^Page \d+ of \d+$/,
  /^Account Number\b/,
  /^Transaction Details\b/,
  /^Date\s+Transaction Details\b/,
];

const FIRST_DAY_MESSAGE = '账期第一天有交易，R1C 对账期的假设不对';

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

type RawTransaction = Position & {
  date: string;
  // null：换年那一笔只剩金额、余额两段，方向在余额检查时按上一笔余额判断（R1C 例外）
  amountCents: number | null;
  unsignedCents: number;
  balanceCents: number;
  parts: string[]; // 描述：交易行那段 + 续行
};

type Transaction = RawTransaction & { amountCents: number };

export function parseAnzStatement(
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseStatementResult {
  try {
    return parse(
      lines.map((l) => ({ page: l.page, text: l.text.trim() })),
      accountSuffix,
    );
  } catch (error) {
    if (error instanceof StatementError) {
      return { ok: false, message: error.message, page: error.page, index: error.index };
    }
    throw error;
  }
}

function parse(lines: StatementLine[], accountSuffix: string | null): ParseStatementResult {
  const header = readHeader(lines, accountSuffix);
  const { transactions: raw, openingRowCents } = readTransactions(
    lines,
    header.periodFrom,
    header.periodTo,
  );
  const { summary } = header;

  // R1C：OPENING BALANCE 那行要等于汇总页的期初
  if (openingRowCents !== null && openingRowCents !== summary.opening) {
    throw new StatementError(
      `OPENING BALANCE 那行是 ${cents(openingRowCents)}，汇总页的期初是 ${cents(summary.opening)}`,
    );
  }

  // R1C 检查 1：期初 + 逐笔金额 = 每一行的余额
  let balance = summary.opening;
  const transactions: Transaction[] = [];
  for (const r of raw) {
    const t = { ...r, amountCents: r.amountCents ?? directionByBalance(r, balance) };
    transactions.push(t);
    balance += t.amountCents;
    if (balance !== t.balanceCents) {
      throw rowError(
        t,
        `余额对不上，算出来是 ${cents(balance)}，对账单上是 ${cents(t.balanceCents)}`,
      );
    }
  }

  // R1C 检查 2：最后的余额 = 汇总页的期末
  if (balance !== summary.closing) {
    throw new StatementError(
      `最后的余额是 ${cents(balance)}，汇总页的期末是 ${cents(summary.closing)}`,
    );
  }

  // R1C 检查 3：支出合计、存入合计 = 汇总页
  const withdrawals = -sum(transactions.filter((t) => t.amountCents < 0));
  const deposits = sum(transactions.filter((t) => t.amountCents > 0));
  if (withdrawals !== summary.withdrawals) {
    throw new StatementError(
      `支出合计是 ${cents(withdrawals)}，汇总页的 Total Withdrawals 是 ${cents(summary.withdrawals)}`,
    );
  }
  if (deposits !== summary.deposits) {
    throw new StatementError(
      `存入合计是 ${cents(deposits)}，汇总页的 Total Deposits 是 ${cents(summary.deposits)}`,
    );
  }

  return {
    ok: true,
    rows: transactions.map((t, i) => ({
      date: t.date,
      amountCents: t.amountCents,
      description: t.parts.join(' ').trim(), // R1C：用一个空格拼起来，去首尾空白
      balanceCents: null, // R1C、R4.1：ANZ 的 key 不放余额
      rowIndex: i + 1,
    })),
    periodFrom: header.periodFrom,
    periodTo: header.periodTo,
    openingCents: summary.opening,
    closingCents: summary.closing,
  };
}

// R1C 例外：只有金额、余额两段时，上一笔余额 − 金额 = 余额 → 支出，+ 金额 = 余额 → 存入
function directionByBalance(t: RawTransaction, previousBalance: number): number {
  if (previousBalance - t.unsignedCents === t.balanceCents) return -t.unsignedCents;
  if (previousBalance + t.unsignedCents === t.balanceCents) return t.unsignedCents;
  throw rowError(
    t,
    `只有金额和余额两段，上一笔余额 ${cents(previousBalance)} 加减 ${cents(t.unsignedCents)} 都不等于 ${cents(t.balanceCents)}`,
  );
}

function sum(transactions: Transaction[]): number {
  return transactions.reduce((total, t) => total + t.amountCents, 0);
}

// ---------- 表头 ----------

function readHeader(lines: StatementLine[], accountSuffix: string | null) {
  // R1C：有一行含 ANZ 和 STATEMENT
  if (!lines.some((l) => isTitle(l.text))) {
    throw new StatementError('找不到对账单标题，这不像 ANZ 对账单');
  }

  // R1C：账期 DD MONTH YYYY TO DD MONTH YYYY
  const periodMatch = lines.map((l) => PERIOD.exec(l.text)).find((m) => m !== null);
  if (!periodMatch) throw new StatementError('找不到账期');
  const periodFrom = fullDate(periodMatch[1], periodMatch[2], periodMatch[3]);
  const periodTo = fullDate(periodMatch[4], periodMatch[5], periodMatch[6]);
  if (periodFrom >= periodTo) throw new StatementError('账期的开始日不早于结束日');

  // R1C：账号只拿来核对，不返回、不写进错误信息
  if (!accountSuffix) {
    throw new StatementError('这个账户还没填账号尾号，先去账户设置填，才能核对对账单');
  }
  const accountNumber = findAfterLabel(lines, ACCOUNT_LABEL, ACCOUNT_LOOKAHEAD, ACCOUNT_NUMBER);
  if (accountNumber === null) throw new StatementError('找不到账号');
  if (!accountNumber.replace(/-/g, '').endsWith(accountSuffix)) {
    throw new StatementError('这份对账单不是这个账户的');
  }

  return { periodFrom, periodTo, summary: readSummary(lines) };
}

// R1C 自动认账户（M6.6-6b）：在调用方给的账户（没归档的 ANZ）里，找 number_suffix 和对账单账号尾部对得上的
// 账号不返回；错误信息里只带后 4 位
export function identifyStatementAccount(
  lines: readonly StatementLine[],
  accounts: readonly { id: string; numberSuffix: string | null }[],
): { ok: true; accountId: string } | { ok: false; message: string } {
  const trimmed = lines.map((l) => ({ page: l.page, text: l.text.trim() }));
  if (!trimmed.some((l) => isTitle(l.text))) {
    return { ok: false, message: '找不到对账单标题，这不像 ANZ 对账单' };
  }
  const accountNumber = findAfterLabel(trimmed, ACCOUNT_LABEL, ACCOUNT_LOOKAHEAD, ACCOUNT_NUMBER);
  if (accountNumber === null) return { ok: false, message: '找不到账号' };
  const digits = accountNumber.replace(/-/g, '');

  const matches = accounts.filter((a) => a.numberSuffix && digits.endsWith(a.numberSuffix));
  if (matches.length === 1) return { ok: true, accountId: matches[0].id };
  if (matches.length === 0) {
    return {
      ok: false,
      message: `找不到尾号是 ${digits.slice(-4)} 的 ANZ 账户，先去账户设置填上尾号`,
    };
  }
  return {
    ok: false,
    message: `有 ${matches.length} 个 ANZ 账户的尾号都对得上，去账户设置把尾号填长一点`,
  };
}

function isTitle(text: string): boolean {
  return /\bANZ\b/.test(text) && /\bSTATEMENT\b/.test(text);
}

// R1C 汇总：标签后面的第一个金额，在同一行或后面 4 行里
function readSummary(lines: StatementLine[]): Record<SummaryKey, number> {
  const result = {} as Record<SummaryKey, number>;
  for (const key of Object.keys(SUMMARY_LABELS) as SummaryKey[]) {
    const label = SUMMARY_LABELS[key];
    if (!lines.some((l) => l.text.includes(label))) {
      throw new StatementError(`汇总页找不到 ${label}`);
    }
    const amount = findAfterLabel(lines, label, SUMMARY_LOOKAHEAD, SUMMARY_AMOUNT);
    if (amount === null) throw new StatementError(`汇总页的 ${label} 读不出金额`);
    result[key] = toCents(amount, `汇总页的 ${label}`, parseBalanceToCents);
  }
  return result;
}

// 找第一个含 label 的行，在 label 之后的部分和后面 lookahead 行里找 pattern，返回第一个分组
// 汇总页左右两栏拼在一起，label 不一定在行首，值也常常隔几行（R1C）
function findAfterLabel(
  lines: StatementLine[],
  label: string,
  lookahead: number,
  pattern: RegExp,
): string | null {
  const at = lines.findIndex((l) => l.text.includes(label));
  if (at === -1) return null;
  const sameLine = lines[at].text.slice(lines[at].text.indexOf(label) + label.length);
  const candidates = [sameLine, ...lines.slice(at + 1, at + 1 + lookahead).map((l) => l.text)];
  for (const text of candidates) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

// ---------- 交易行 ----------

function readTransactions(lines: StatementLine[], periodFrom: string, periodTo: string) {
  const transactions: RawTransaction[] = [];
  let openingRowCents: number | null = null;

  // R1C 年份：起始 = periodFrom 的年份，月份比上一笔小就加一年，只有年份的那行以它为准
  let year = Number(periodFrom.slice(0, 4));
  let lastMonth: number | null = null;

  let current: RawTransaction | null = null; // 续行拼到这一笔
  let page = 0;
  let indexOnPage = 0;

  for (const line of lines) {
    const { text } = line;
    if (line.page !== page) {
      page = line.page;
      indexOnPage = 0;
      current = null; // 续行不跨页
    }
    if (text === '') continue;

    const yearOnly = YEAR_ONLY.exec(text);
    if (yearOnly) {
      year = Number(yearOnly[1]);
      lastMonth = null;
      current = null;
      continue;
    }
    if (EFFECTIVE_DATE.test(text)) continue; // 实际消费日期，不拼进描述，后面可能还有续行
    if (isTitle(text) || PAGE_FURNITURE.some((p) => p.test(text))) {
      current = null;
      continue;
    }

    const start = TRANSACTION_START.exec(text);
    if (!start) {
      // R1C 续行：前面有交易行时才算。汇总页、页眉里的其他文字不影响
      if (current) current.parts.push(text);
      continue;
    }

    const [, day, monthName, rest] = start;
    const month = MONTHS.indexOf(monthName) + 1;
    if (lastMonth !== null && month < lastMonth) year += 1;
    lastMonth = month;

    // OPENING BALANCE 那行不是交易，不算笔数
    const isOpeningRow = /^OPENING BALANCE\b/.test(rest.trim());
    const at: Position | null = isOpeningRow ? null : { page, index: ++indexOnPage };

    const date = toIsoDate(day, month, year);
    if (date === null) throw rowError(at, `日期不对：${day} ${monthName} ${year}`);

    if (at === null) {
      // R1C：OPENING BALANCE 最后一段是余额，前面的 blank 可能跑到了年份那行
      const [balance, ...before] = rest.trim().split(/\s+/).slice(2).reverse();
      if (balance === undefined) throw rowError(at, 'OPENING BALANCE 那行没有余额');
      if (before.some((x) => x !== BLANK)) {
        throw rowError(at, 'OPENING BALANCE 那行不应该有支出或存入');
      }
      openingRowCents = toCents(balance, '期初余额', parseBalanceToCents, at);
      current = null;
      continue;
    }

    // R1C 年份：日期要在 (periodFrom, periodTo] 里
    if (date === periodFrom) throw rowError(at, FIRST_DAY_MESSAGE);
    if (date < periodFrom || date > periodTo) {
      throw rowError(at, `日期 ${date} 不在账期 ${periodFrom} 到 ${periodTo} 里`);
    }

    const columns = readColumns(rest, at);
    current = { ...at, date, ...columns };
    transactions.push(current);
  }

  return { transactions, openingRowCents };
}

// R1C 交易行的最后几段
// 正常：支出、存入、余额，支出和存入恰好一个是金额、另一个是 blank
// 例外：换年那一笔的 blank 被年份那行占了，只剩金额、余额两段，方向留给余额检查判断
function readColumns(
  rest: string,
  at: Position,
): Pick<RawTransaction, 'amountCents' | 'unsignedCents' | 'balanceCents' | 'parts'> {
  const three = LAST_THREE.exec(rest);
  if (three) {
    const [, description, withdrawal, deposit, rawBalance] = three;
    const isColumn = (x: string) => x === BLANK || AMOUNT_WITH_COMMAS.test(x);
    if (isColumn(withdrawal) && isColumn(deposit)) {
      const balanceCents = toCents(rawBalance, '余额', parseBalanceToCents, at);
      let amountCents: number;
      if (withdrawal !== BLANK && deposit === BLANK) {
        amountCents = -toCents(withdrawal, '支出', parsePositiveCents, at);
      } else if (withdrawal === BLANK && deposit !== BLANK) {
        amountCents = toCents(deposit, '存入', parsePositiveCents, at);
      } else {
        throw rowError(at, '支出和存入应该恰好一个有金额');
      }
      return {
        amountCents,
        unsignedCents: Math.abs(amountCents),
        balanceCents,
        parts: [description.trim()],
      };
    }
  }

  const two = LAST_TWO.exec(rest);
  if (two && AMOUNT_WITH_COMMAS.test(two[2]) && AMOUNT_WITH_COMMAS.test(two[3])) {
    const [, description, rawAmount, rawBalance] = two;
    return {
      amountCents: null,
      unsignedCents: toCents(rawAmount, '金额', parsePositiveCents, at),
      balanceCents: toCents(rawBalance, '余额', parseBalanceToCents, at),
      parts: [description.trim()],
    };
  }

  // 末尾不是 "支出 存入 余额" 也不是 "金额 余额"
  const last = three?.[4] ?? two?.[3];
  if (last !== undefined && !AMOUNT_WITH_COMMAS.test(last)) {
    throw rowError(at, `余额格式不对: "${last}"`);
  }
  throw rowError(at, '交易行应该以支出、存入、余额三段结尾');
}

// ---------- 工具 ----------

// R1C：去掉千分位逗号，按 R1.0-4 转成分
function toCents(
  raw: string,
  label: string,
  parser: (input: string) => number,
  at: Position | null = null,
): number {
  if (!AMOUNT_WITH_COMMAS.test(raw)) throw rowError(at, `${label}格式不对: "${raw}"`);
  try {
    return parser(raw.replace(/,/g, ''));
  } catch (error) {
    throw rowError(at, `${label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

// 错误带页码和这一页的第几笔（R1C 检查）
function rowError(at: Position | null, message: string): StatementError {
  if (at === null) return new StatementError(message);
  return new StatementError(`第 ${at.page} 页第 ${at.index} 笔：${message}`, at.page, at.index);
}

// R1.0-4，支出和存入栏写的都是正数，正负号由栏位决定
function parsePositiveCents(input: string): number {
  const value = parseAmountToCents(input);
  if (value < 0) throw new Error(`不应该是负数: "${input}"`);
  return value;
}

function fullDate(day: string, monthName: string, year: string): string {
  const date = toIsoDate(day, FULL_MONTHS.indexOf(monthName) + 1, Number(year));
  if (date === null) throw new StatementError(`账期日期不对：${day} ${monthName} ${year}`);
  return date;
}

// 日、月、年 → YYYY-MM-DD，日期不存在时返回 null。复用 R1.0-3，不转 JS Date
function toIsoDate(day: string, month: number, year: number): string | null {
  if (month < 1 || month > 12) return null;
  try {
    return parseAuDate(`${day}/${pad(month)}/${year}`);
  } catch {
    return null;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// 错误信息里的金额
const cents = formatAud;

// R1C：批次存 date_from = periodFrom 的第二天、date_to = periodTo。页面上显示纸面对账单印的账期
export function statementPeriod(dateFrom: string, dateTo: string): { from: string; to: string } {
  return { from: addDays(dateFrom, -1), to: dateTo };
}
