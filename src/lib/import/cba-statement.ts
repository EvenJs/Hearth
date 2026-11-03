// CBA PDF 对账单解析（business-rules.md R1E 第二层）
// 输入是 src/server/pdf/ 读出来的行 { page, text }[]，输出和 R1D 一样的形状（没有 Interest Earned）
// 不抛错，返回结果对象。任何一条检查不过，整份失败，什么都不返回
// 纯函数，不 import 数据库和 Next.js
import type { StatementLine } from './anz-statement';
import { parseAuDate } from '@/lib/rules/date';
import { formatAud, parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import type { ParsedRow } from '@/lib/rules/types';

export type ParseCbaStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 新的在前（表里是旧的在前，反过来，R1E）。balanceCents 是每笔余额（R4.1）
      periodFrom: string; // YYYY-MM-DD，账期是闭区间 [periodFrom, periodTo]（R1E，同 R1D）
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = `(${MONTHS.join('|')})`;

// 金额：1,234.56，千分位逗号可有可无，没有 $
const MONEY = '((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})';
// 余额后面一个空格加 CR / DR（DR 是透支，没见过，认出来以后整份失败）
const BALANCE = `${MONEY} (CR|DR)`;

// R1E 左边距的乱码：只在行首，按条码、= 块、* * 的顺序各去一次
const BARCODE =
  /^\d{3,4}\.\d{4,5}\.\d\.\d [A-Za-z]{2}\d{3}[A-Za-z]\d \d{4} [A-Za-z]{2}\.[A-Za-z]\d\.[A-Za-z]\d{3}\.[A-Za-z]\d{3}\.[A-Za-z] [A-Za-z]\d{2}\.\d{2}\.\d{2}/;
const EQUALS_BLOCK = /^=(?=[^)]{0,4}\P{ASCII})[^\s)]{5}\)/u; // = + 5 个字符（有非 ASCII）+ )
const STARS = /^\* \*/;
// R1E：去掉以后还像乱码（形状变了）→ 整份失败
const LOOKS_LIKE_GARBAGE = /\d+\.\d+\.\d+\.\d+|=.{0,4}\P{ASCII}/u;

// R1E 认格式：整行 Your Statement + 第一个表头之前有 Account Number + 有 OPENING BALANCE
const TITLE = 'Your Statement';
const ACCOUNT_NUMBER_PREFIX = 'Account Number ';
const NOT_CBA_MESSAGE = '这不像 CBA 对账单';

// R1E 页眉和交易表
const PAGE_HEADER = /^Statement \d+\s+Page \d+ of \d+\)?$/;
const TABLE_HEADER = /^Date\s+Transaction\s+Debit\s+Credit\s+Balance$/;
const OPENING_ROW = new RegExp(`^(\\d{2}) ${MONTH} (\\d{4}) OPENING BALANCE\\s+${BALANCE}$`);
const CLOSING_ROW = new RegExp(`^(\\d{2}) ${MONTH} (\\d{4}) CLOSING BALANCE\\s+${BALANCE}$`);
const TRANSACTION_START = new RegExp(`^(\\d{2}) ${MONTH}(?=\\s|$)(.*)$`);
// 一笔的最后一行：…  金额  余额 CR。描述部分可以是空的
const TRANSACTION_END = new RegExp(`^(?:(.*?)\\s+)?${MONEY}\\s+${BALANCE}$`);
const VALUE_DATE = /^Value Date (\d{2}\/\d{2}\/\d{4})$/;

// R1E 账期：一行以 D Mon YYYY - D Mon YYYY 结尾
const PERIOD = new RegExp(`(?:^|\\s)(\\d{1,2}) ${MONTH} (\\d{4}) - (\\d{1,2}) ${MONTH} (\\d{4})$`);

// R1E 汇总：标签一行，下一行是期初、借合计、贷合计、期末
const SUMMARY_LABEL = /^Opening balance\b.*Total debits.*Total credits.*Closing balance$/;
const SUMMARY_VALUES = new RegExp(`^${BALANCE}\\s+${MONEY}\\s+${MONEY}\\s+${BALANCE}$`);

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

export function parseCbaStatement(
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseCbaStatementResult {
  try {
    return parse(cleanLines(lines), accountSuffix);
  } catch (error) {
    if (error instanceof StatementError) {
      return { ok: false, message: error.message, page: error.page, index: error.index };
    }
    throw error;
  }
}

// R1E 认格式（M8.5-5 三选一用）
export function looksLikeCbaStatement(lines: readonly StatementLine[]): boolean {
  return isCba(cleanLines(lines));
}

// R1E 自动认账户（M8.5-5，照 R1D）：在调用方给的账户（没归档的 CBA）里，找 number_suffix 和对账单账号尾部对得上的
// BSB 和账号不返回；错误信息里只带后 4 位
export function identifyCbaStatementAccount(
  lines: readonly StatementLine[],
  accounts: readonly { id: string; numberSuffix: string | null }[],
): { ok: true; accountId: string } | { ok: false; message: string } {
  const cleaned = cleanLines(lines);
  if (!isCba(cleaned)) return { ok: false, message: NOT_CBA_MESSAGE };
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
      message: `找不到尾号是 ${digits.slice(-4)} 的 CBA 账户，先去账户设置填上尾号`,
    };
  }
  return {
    ok: false,
    message: `有 ${matches.length} 个 CBA 账户的尾号都对得上，去账户设置把尾号填长一点`,
  };
}

// R1E：每一行先去掉行首的乱码，再去首尾空白，去完是空行就跳过
function cleanLines(lines: readonly StatementLine[]): StatementLine[] {
  return lines
    .map((l) => ({ page: l.page, text: stripMarginGarbage(l.text) }))
    .filter((l) => l.text !== '');
}

function stripMarginGarbage(text: string): string {
  let rest = text.trim();
  for (const pattern of [BARCODE, EQUALS_BLOCK, STARS]) rest = rest.replace(pattern, '').trimStart();
  return rest.trimEnd();
}

// R1E 认格式：三条缺一条就不是。Account Number 要在第一个表头之前（后面几页的不算）
function isCba(lines: StatementLine[]): boolean {
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));
  return (
    lines.some((l) => l.text === TITLE) &&
    headerAt !== -1 &&
    lines.slice(0, headerAt).some((l) => l.text.startsWith(ACCOUNT_NUMBER_PREFIX)) &&
    lines.some((l) => OPENING_ROW.test(l.text))
  );
}

function parse(lines: StatementLine[], accountSuffix: string | null): ParseCbaStatementResult {
  if (!isCba(lines)) throw new StatementError(NOT_CBA_MESSAGE);
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.text));

  const { periodFrom, periodTo } = readPeriod(lines);

  // R1E：账号只拿来核对，不返回、不写进错误信息
  if (!accountSuffix) {
    throw new StatementError('这个账户还没填账号尾号，先去账户设置填，才能核对对账单');
  }
  if (!readAccountDigits(lines.slice(0, headerAt)).endsWith(accountSuffix)) {
    throw new StatementError('这份对账单不是这个账户的');
  }

  // R1E：表头下面紧挨着 OPENING BALANCE，后面某一行是 CLOSING BALANCE
  const openingAt = headerAt + 1;
  const opening = readBalanceRow(lines[openingAt], OPENING_ROW);
  if (!opening) throw new StatementError('找不到 OPENING BALANCE');
  const closingOffset = lines.slice(openingAt + 1).findIndex((l) => CLOSING_ROW.test(l.text));
  if (closingOffset === -1) throw new StatementError('找不到 CLOSING BALANCE');
  const closingAt = openingAt + 1 + closingOffset;
  const closing = readBalanceRow(lines[closingAt], CLOSING_ROW);
  if (!closing) throw new StatementError('找不到 CLOSING BALANCE');

  if (opening.date !== periodFrom || closing.date !== periodTo) {
    throw new StatementError('账期和 OPENING / CLOSING BALANCE 的日期对不上');
  }

  const summary = readSummary(lines.slice(closingAt + 1));

  // R1E：表外的行去掉乱码以后还像乱码 → 整份失败。表里的在 readTable 里查，带第几笔
  const outside = [...lines.slice(0, openingAt), ...lines.slice(closingAt + 1)];
  if (outside.some((l) => LOOKS_LIKE_GARBAGE.test(l.text))) {
    throw new StatementError('对账单里有一行像乱码');
  }

  const transactions = readTable(
    lines.slice(openingAt + 1, closingAt),
    lines[openingAt].page,
    opening.date,
    periodFrom,
    periodTo,
  );

  // R1E：表里旧的在前，用上一笔余额判断方向，同时就是"期初 + 逐笔 = 每一笔的余额"
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

  // R1E：最后一笔的余额 = CLOSING BALANCE；一笔都没有时 OPENING = CLOSING
  if (balance !== closing.cents) {
    throw new StatementError(
      transactions.length === 0
        ? `没有交易，但 OPENING BALANCE ${cents(opening.cents)} 和 CLOSING BALANCE ${cents(closing.cents)} 不一样`
        : `最后一笔的余额是 ${cents(balance)}，CLOSING BALANCE 是 ${cents(closing.cents)}`,
    );
  }

  // R1E 汇总：期初期末和表里一致，借贷合计和逐笔一致（都按正数比）
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
      `逐笔借合计是 ${cents(debits)}，汇总的 Total debits 是 ${cents(summary.debits)}`,
    );
  }
  if (summary.credits !== credits) {
    throw new StatementError(
      `逐笔贷合计是 ${cents(credits)}，汇总的 Total credits 是 ${cents(summary.credits)}`,
    );
  }

  // R1E：输出新的在前（同 CBA CSV），rowIndex 按输出顺序从 1 开始，R4.1 的 occurrence 才和 CSV 一样
  const rows = transactions.map((t, i) => ({
    date: t.date,
    amountCents: amounts[i],
    description: t.description,
    balanceCents: t.balanceCents, // R1E、R4.1：CBA 的 key 放余额
  }));
  return {
    ok: true,
    rows: rows.reverse().map((r, i) => ({ ...r, rowIndex: i + 1 })),
    periodFrom,
    periodTo,
    openingCents: opening.cents,
    closingCents: closing.cents,
  };
}

// ---------- 表头部分 ----------

// R1E 账期：第 1 页，闭区间，会跨年；不能超过 12 个月
function readPeriod(lines: StatementLine[]) {
  const match = lines
    .filter((l) => l.page === 1)
    .map((l) => PERIOD.exec(l.text))
    .find((m) => m !== null);
  if (!match) throw new StatementError('找不到账期');
  const [, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
  const periodFrom = toIsoDate(fromDay, fromMonth, Number(fromYear));
  const periodTo = toIsoDate(toDay, toMonth, Number(toYear));
  if (periodFrom === null || periodTo === null) throw new StatementError('账期不对：日期不存在');
  if (periodFrom > periodTo) throw new StatementError('账期不对：开始日晚于结束日');
  const oneYearLater = `${Number(periodFrom.slice(0, 4)) + 1}${periodFrom.slice(4)}`;
  if (periodTo >= oneYearLater) {
    throw new StatementError('账期超过 12 个月，还没见过这么长的 CBA 对账单');
  }
  return { periodFrom, periodTo };
}

// R1E：表头之前第一个 Account Number 行，去掉空格是 14 位（BSB 6 位 + 账号 8 位）
function readAccountDigits(beforeHeader: StatementLine[]): string {
  const line = beforeHeader.find((l) => l.text.startsWith(ACCOUNT_NUMBER_PREFIX));
  const digits = line?.text.slice(ACCOUNT_NUMBER_PREFIX.length).replace(/\s/g, '') ?? '';
  if (!/^\d{14}$/.test(digits)) throw new StatementError('找不到账号');
  return digits;
}

// OPENING / CLOSING BALANCE 那行：带年份，最后一段是余额
function readBalanceRow(line: StatementLine | undefined, pattern: RegExp) {
  const match = line ? pattern.exec(line.text) : null;
  if (!line || !match) return null;
  const [, day, monthName, year, rawBalance, side] = match;
  if (side !== 'CR') throw new StatementError(OVERDRAFT_MESSAGE, line.page);
  const date = toIsoDate(day, monthName, Number(year));
  if (date === null) throw new StatementError(`${line.text.split(/\s+/).slice(0, 3).join(' ')} 日期不对`);
  return { date, cents: toCents(rawBalance, '余额', parseBalanceToCents) };
}

// R1E 汇总：CLOSING BALANCE 之后的标签行，下一行 4 个数
function readSummary(afterClosing: StatementLine[]) {
  const at = afterClosing.findIndex((l) => SUMMARY_LABEL.test(l.text));
  const values = at === -1 ? null : SUMMARY_VALUES.exec(afterClosing[at + 1]?.text ?? '');
  if (!values) throw new StatementError('找不到汇总');
  const [, opening, openingSide, debits, credits, closing, closingSide] = values;
  if (openingSide !== 'CR' || closingSide !== 'CR') throw new StatementError(OVERDRAFT_MESSAGE);
  return {
    opening: toCents(opening, '汇总的期初', parseBalanceToCents),
    debits: toCents(debits, '汇总的 Total debits', parseBalanceToCents),
    credits: toCents(credits, '汇总的 Total credits', parseBalanceToCents),
    closing: toCents(closing, '汇总的期末', parseBalanceToCents),
  };
}

// ---------- 交易表 ----------

// OPENING 和 CLOSING 之间的行 → 交易，表里的顺序（旧的在前）
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
  // R1E 年份：从 periodFrom 的年份开始，月份比上一笔小就加一年。第一笔和 OPENING BALANCE 比
  let year = Number(periodFrom.slice(0, 4));
  let previousDate = openingDate;

  for (const line of lines) {
    const { page, text } = line;
    if (pending && page !== pending.page) throw rowError(pending, '跨页了，还没见过跨页的交易');

    if (LOOKS_LIKE_GARBAGE.test(text)) {
      if (pending) throw rowError(pending, '里有一行像乱码，认不出来');
      throw new StatementError('对账单里有一行像乱码', page);
    }

    if (PAGE_HEADER.test(text) || TABLE_HEADER.test(text) || text.startsWith(ACCOUNT_NUMBER_PREFIX)) {
      continue; // R1E：换页的页眉
    }

    const start = TRANSACTION_START.exec(text);
    if (start) {
      if (pending) throw rowError(pending, '找不到金额和余额');
      const index = (countByPage.get(page) ?? 0) + 1;
      countByPage.set(page, index);
      const at: Position = { page, index };

      const [, day, monthName, rest] = start;
      if (MONTHS.indexOf(monthName) + 1 < Number(previousDate.slice(5, 7))) year += 1;
      const date = toIsoDate(day, monthName, year);
      if (date === null) throw rowError(at, `的日期不对：${day} ${monthName}`);
      if (date < previousDate) throw rowError(at, `的日期比上一笔早：${date} 早于 ${previousDate}`);
      if (date < periodFrom || date > periodTo) {
        throw rowError(at, `的日期不在账期里：${date} 不在 ${periodFrom} 到 ${periodTo} 里`);
      }
      previousDate = date;

      pending = { ...at, date, parts: [], amount: null };
      addPart(pending, rest, true);
    } else if (pending) {
      addPart(pending, text, false);
    } else {
      // R1E：上一笔已经结束，这一行又不是新的一笔。不带这一行的内容，免得带出号码
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
        description: pending.parts.join(' '), // R1E：各段用一个空格拼
      });
      pending = null;
    }
  }

  if (pending) throw rowError(pending, '找不到金额和余额'); // 下一行就是 CLOSING BALANCE
  return transactions;
}

// 一笔的一行：末尾有金额余额就结束这一笔；剩下的部分进描述
function addPart(pending: Pending, text: string, isFirstLine: boolean) {
  let description = text;
  const end = TRANSACTION_END.exec(text);
  if (end) {
    const [, before = '', rawAmount, rawBalance, side] = end;
    if (side !== 'CR') throw new StatementError(OVERDRAFT_MESSAGE, pending.page, pending.index);
    pending.amount = {
      unsignedCents: toCents(rawAmount, '金额', parseAmountToCents, pending),
      balanceCents: toCents(rawBalance, '余额', parseBalanceToCents, pending),
    };
    description = before;
  }
  description = description.trim();
  // R1E：整行正好是 Value Date dd/mm/yyyy 的续行补冒号，和 CSV 一样
  if (!isFirstLine) description = description.replace(VALUE_DATE, 'Value Date: $1');
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

// 错误带页码和这一页的第几笔（R1E 检查）
function rowError(at: Position, message: string): StatementError {
  return new StatementError(`第 ${at.index} 笔${message}`, at.page, at.index);
}

// 日、月份缩写、年 → YYYY-MM-DD，日期不存在时返回 null。复用 R1.0-3，不转 JS Date
function toIsoDate(day: string, monthName: string, year: number): string | null {
  const month = MONTHS.indexOf(monthName) + 1;
  if (month < 1) return null;
  try {
    return parseAuDate(`${day.padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`);
  } catch {
    return null;
  }
}

// 错误信息里的金额
const cents = formatAud;
