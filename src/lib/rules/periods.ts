// 统计时间段（business-rules.md R10.1）
// 日期全程是 YYYY-MM-DD 字符串，加减天数用整数天数换算，不转 JS Date
// 纯函数，不 import 数据库和 Next.js

export const PRESET_PERIODS = [
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'this_fy',
] as const;
export type PresetPeriod = (typeof PRESET_PERIODS)[number];
export type PeriodOption = PresetPeriod | 'custom';

// 含首尾
export type DateRange = { start: string; end: string };
// 带上选项，previousPeriod 按选项决定怎么往前挪
export type Period = DateRange & { option: PeriodOption };

// ---------- 日期工具 ----------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Ymd = { y: number; m: number; d: number };

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function parse(date: string): Ymd {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`日期格式不对，应为 YYYY-MM-DD: "${date}"`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error(`日期不存在: "${date}"`);
  return { y, m, d };
}

function format({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 1970-01-01 起的天数（Howard Hinnant days_from_civil），只用整数
function toDays({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDays(days: number): Ymd {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: era * 400 + yoe + (m <= 2 ? 1 : 0), m, d };
}

export function addDays(date: string, n: number): string {
  return format(fromDays(toDays(parse(date)) + n));
}

// 两个日期相差的天数（b − a）
export function daysBetween(a: string, b: string): number {
  return toDays(parse(b)) - toDays(parse(a));
}

// 周一 = 0 … 周日 = 6。1970-01-01 是周四
export function weekdayMondayFirst(date: string): number {
  return (((toDays(parse(date)) + 3) % 7) + 7) % 7;
}

export function mondayOf(date: string): string {
  return addDays(date, -weekdayMondayFirst(date));
}

export function startOfMonth(date: string): string {
  return format({ ...parse(date), d: 1 });
}

export function endOfMonth(date: string): string {
  const { y, m } = parse(date);
  return format({ y, m, d: daysInMonth(y, m) });
}

// 往前或往后挪 n 个月，日号超出新月份的天数时截到月底
function addMonths(date: string, n: number): string {
  const { y, m, d } = parse(date);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = index - ny * 12 + 1;
  return format({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

// R10.1："今天"按 Australia/Melbourne
export function todayInMelbourne(now: Date = new Date()): string {
  // en-CA 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ---------- R10.1 ----------

// R10.1 各选项的范围。自定义传 { start, end }，含首尾
export function periodRange(option: PresetPeriod | DateRange, today: string): Period {
  parse(today);

  if (typeof option === 'object') {
    parse(option.start);
    parse(option.end);
    if (option.start > option.end) {
      throw new Error(`开始日期不能晚于结束日期: ${option.start} > ${option.end}`);
    }
    return { option: 'custom', start: option.start, end: option.end };
  }

  const { y, m } = parse(today);
  const period = (start: string, end: string): Period => ({ option, start, end });

  switch (option) {
    case 'this_week':
      return period(mondayOf(today), today);
    case 'last_week': {
      const lastMonday = addDays(mondayOf(today), -7);
      return period(lastMonday, addDays(lastMonday, 6));
    }
    case 'this_month':
      return period(startOfMonth(today), today);
    case 'last_month': {
      const start = addMonths(startOfMonth(today), -1);
      return period(start, endOfMonth(start));
    }
    case 'this_quarter': {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      return period(format({ y, m: qm, d: 1 }), today);
    }
    case 'this_year':
      return period(format({ y, m: 1, d: 1 }), today);
    case 'this_fy':
      // 今天在 1 到 6 月时，从去年 7 月 1 日开始
      return period(format({ y: m >= 7 ? y : y - 1, m: 7, d: 1 }), today);
  }
}

const MONTHS_BACK: Partial<Record<PeriodOption, number>> = {
  this_month: 1,
  last_month: 1,
  this_quarter: 3,
  this_year: 12,
  this_fy: 12,
};

// R10.1 对比用的上一期：按日历单位往前挪（本月 1–21 日 → 上月 1–21 日）
// - 本周、上周：往前 7 天
// - 月、季度、年、财年：往前 1、3、12 个月；原来到月底的仍到月底，日号超出时截到月底
// - 自定义：紧挨着的同样天数
export function previousPeriod(period: Period): DateRange {
  const { option, start, end } = period;

  if (option === 'this_week' || option === 'last_week') {
    return { start: addDays(start, -7), end: addDays(end, -7) };
  }

  const months = MONTHS_BACK[option];
  if (months) {
    const prevStart = addMonths(start, -months);
    const prevEnd =
      end === endOfMonth(end) ? endOfMonth(addMonths(end, -months)) : addMonths(end, -months);
    return { start: prevStart, end: prevEnd };
  }

  // custom
  const length = daysBetween(start, end) + 1;
  return { start: addDays(start, -length), end: addDays(start, -1) };
}
