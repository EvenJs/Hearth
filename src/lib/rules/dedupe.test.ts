import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readCbaStatementFixture, readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import { parseCbaStatement } from '../import/cba-statement';
import {
  assignOccurrences,
  dedupeKey,
  findBalanceDuplicates,
  normalizeDescription,
  type BalanceCandidate,
  type DedupeRow,
} from './dedupe';
import { extractAndMask } from './extract';

// 期望值来自 business-rules.md R4.1、R4.2、R4.3，fixtures/README.md "再导入 joint-2026-09-overlap.csv"
// 和 fixtures/cases/13-cba-statement.md "补充去重用例"

const JOINT = 'acc-anz-joint';
const FEMALE = 'acc-cba-female';

const GONG_CHA = 'VISA DEBIT PURCHASE CARD 1111 GONG CHA & HO/SPENCER ST MELBOURNE';

function row(description: string, extra: Partial<DedupeRow> = {}): DedupeRow {
  return { date: '2026-09-28', amountCents: -450, description, balanceCents: null, ...extra };
}

// 解析 → R2 脱敏 → R4.1 occurrence → key，和 M2-10 管道里的顺序一致
function keysFor(accountId: string, rows: DedupeRow[]): string[] {
  return assignOccurrences(rows).map((r) => dedupeKey(accountId, r, r.occurrence));
}

function anzKeys(path: 'anz/joint-2026-09.csv' | 'anz/joint-2026-09-overlap.csv'): string[] {
  const rows = parseAnzCsv(readFixture(path)).map((r) => ({
    ...r,
    description: extractAndMask(r.description).description,
  }));
  return keysFor(JOINT, rows);
}

function cbaFemaleKeys(): string[] {
  const rows = parseCbaCsv(readFixture('cba/female-2026-09.csv')).map((r) => ({
    ...r,
    description: extractAndMask(r.description).description,
  }));
  return keysFor(FEMALE, rows);
}

describe('normalizeDescription（R4.1）', () => {
  it('R4.1: uppercase, collapse whitespace, trim', () => {
    expect(normalizeDescription('  seene CommBank app   BPAY\t959502  ****9999 ')).toBe(
      'SEENE COMMBANK APP BPAY 959502 ****9999',
    );
  });
});

describe('assignOccurrences（R4.1）', () => {
  it('R4.1: identical rows get 1, 2, 3 in file order', () => {
    expect(
      assignOccurrences([row(GONG_CHA), row(GONG_CHA), row(GONG_CHA)]).map((r) => r.occurrence),
    ).toEqual([1, 2, 3]);
  });

  it('R4.1: different rows each start at 1, counting is not limited to adjacent rows', () => {
    const other = row('ACCOUNT SERVICING FEE');
    expect(
      assignOccurrences([row(GONG_CHA), other, row(GONG_CHA)]).map((r) => r.occurrence),
    ).toEqual([1, 1, 2]);
  });

  it('R4.1: date, amount or description differing → separate counters', () => {
    const rows = [
      row(GONG_CHA),
      row(GONG_CHA, { date: '2026-09-29' }),
      row(GONG_CHA, { amountCents: -451 }),
      row('VISA DEBIT PURCHASE CARD 1111 GONG CHA'),
    ];
    expect(assignOccurrences(rows).map((r) => r.occurrence)).toEqual([1, 1, 1, 1]);
  });

  it('R4.1: whitespace/case-only differences count as the same row', () => {
    const rows = [row(GONG_CHA), row(GONG_CHA.replace('GONG CHA', 'gong   cha') + '  ')];
    expect(assignOccurrences(rows).map((r) => r.occurrence)).toEqual([1, 2]);
  });

  it('R4.1: balance is not part of the occurrence grouping (CBA #12, #13 → 1, 2)', () => {
    const sushi = 'ZLR*Tower Sushi & Gourm Melbourne AU';
    const rows = [
      row(sushi, { date: '2026-09-12', amountCents: -300, balanceCents: 874835 }),
      row(sushi, { date: '2026-09-12', amountCents: -300, balanceCents: 875135 }),
    ];
    expect(assignOccurrences(rows).map((r) => r.occurrence)).toEqual([1, 2]);
  });

  it('keeps the input rows and their order', () => {
    const input = [row(GONG_CHA), row('ACCOUNT SERVICING FEE')];
    const out = assignOccurrences(input);
    expect(out).toEqual([
      { ...input[0], occurrence: 1 },
      { ...input[1], occurrence: 1 },
    ]);
  });
});

describe('dedupeKey（R4.1）', () => {
  it('R4.1: sha256 hex of account_id|date|amount_cents|normalizedDescription|occurrence|balance_cents', () => {
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(dedupeKey(JOINT, row(GONG_CHA), 1)).toBe(sha(`${JOINT}|2026-09-28|-450|${GONG_CHA}|1|`));
    expect(
      dedupeKey(
        FEMALE,
        row('Credit Interest', { date: '2026-09-30', amountCents: 1234, balanceCents: 1156159 }),
        1,
      ),
    ).toBe(sha(`${FEMALE}|2026-09-30|1234|CREDIT INTEREST|1|1156159`));
  });

  it('R4: same row twice in one file gets different keys', () => {
    const [a, b] = keysFor(JOINT, [row(GONG_CHA), row(GONG_CHA)]);
    expect(a).not.toBe(b);
  });

  it('R4.1: extra whitespace / case differences give the same key', () => {
    expect(
      dedupeKey(JOINT, row('ANZ INTERNET BANKING BPAY SEENE                         {123456}'), 1),
    ).toBe(dedupeKey(JOINT, row('anz internet banking bpay seene {123456}'), 1));
  });

  it('R4.1: balance is part of the key when present', () => {
    expect(dedupeKey(FEMALE, row(GONG_CHA, { balanceCents: 100 }), 1)).not.toBe(
      dedupeKey(FEMALE, row(GONG_CHA, { balanceCents: 200 }), 1),
    );
    expect(dedupeKey(FEMALE, row(GONG_CHA, { balanceCents: 0 }), 1)).not.toBe(
      dedupeKey(FEMALE, row(GONG_CHA, { balanceCents: null }), 1),
    );
  });

  it('R4.1: different account → different key', () => {
    expect(dedupeKey(JOINT, row(GONG_CHA), 1)).not.toBe(dedupeKey(FEMALE, row(GONG_CHA), 1));
  });
});

describe('R4 on fixtures', () => {
  it('R4.2: processing the same file twice gives identical keys', () => {
    expect(anzKeys('anz/joint-2026-09.csv')).toEqual(anzKeys('anz/joint-2026-09.csv'));
    expect(cbaFemaleKeys()).toEqual(cbaFemaleKeys());
  });

  it('R4: joint-2026-09.csv has 19 distinct keys (GONG CHA #4, #5 differ)', () => {
    const keys = anzKeys('anz/joint-2026-09.csv');
    expect(new Set(keys).size).toBe(19);
    expect(keys[3]).not.toBe(keys[4]);
  });

  it('R4.2: overlap file shares 6 keys with joint; WOOLWORTHS, 03/10 and GONG CHA #3 are new', () => {
    const joint = new Set(anzKeys('anz/joint-2026-09.csv'));
    const overlap = anzKeys('anz/joint-2026-09-overlap.csv');
    expect(overlap).toHaveLength(9);

    // overlap 文件行顺序：WOOLWORTHS, 03/10 转账, 两行费用, BPAY, GONG CHA ×3, ATM
    expect(overlap.map((k) => joint.has(k))).toEqual([
      false, // 08/10 WOOLWORTHS
      false, // 03/10 FROM ****0002
      true, // 30/09 REVERSAL
      true, // 30/09 ACCOUNT SERVICING FEE
      true, // 29/09 BPAY SEENE
      true, // 28/09 GONG CHA 第 1 笔
      true, // 28/09 GONG CHA 第 2 笔
      false, // 28/09 GONG CHA 第 3 笔（occurrence = 3）
      true, // 25/09 ATM
    ]);
  });

  it('R4: CBA #12, #13 (same day, shop, amount) get different keys', () => {
    const keys = cbaFemaleKeys();
    expect(keys[11]).not.toBe(keys[12]);
    expect(new Set(keys).size).toBe(20);
  });
});

// R4.3 用例里的一行：(date, amount_cents, balance_cents)
type Triple = [date: string, amountCents: number, balanceCents: number | null];

function incoming(...rows: Triple[]) {
  return rows.map(([date, amountCents, balanceCents]) => ({ date, amountCents, balanceCents }));
}

function existing(...rows: [...Triple, dedupeKey: string | null][]): BalanceCandidate[] {
  return rows.map(([date, amountCents, balanceCents, dedupeKey]) => ({
    date,
    amountCents,
    balanceCents,
    dedupeKey,
  }));
}

describe('findBalanceDuplicates（R4.3）', () => {
  it('R4.3 E1: same date, amount and balance → skipped even though the description differs', () => {
    const candidates = existing(
      ['2026-09-28', -90000, 1154925, 'k1'],
      ['2026-09-22', -45560, 844925, 'k2'],
      ['2026-09-03', -7135, 885865, 'k3'],
    );
    const rows = incoming(
      ['2026-09-28', -90000, 1154925],
      ['2026-09-22', -45560, 844925],
      ['2026-09-03', -7135, 885865],
    );
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([true, true, true]);
  });

  it('R4.3 E2: balance off by 1 cent → not skipped', () => {
    const candidates = existing(['2026-09-03', -7135, 885865, 'k1']);
    const rows = incoming(['2026-09-03', -7135, 885866]);
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([false]);
  });

  it('R4.3 E3: different date → not skipped', () => {
    const candidates = existing(['2026-09-03', -7135, 885865, 'k1']);
    const rows = incoming(['2026-09-04', -7135, 885865]);
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([false]);
  });

  it('R4.3 E4: one candidate absorbs at most one row, earlier rows (output order) first', () => {
    const candidates = existing(['2026-09-10', -1000, 50000, 'k1']);
    const rows = incoming(['2026-09-10', -1000, 50000], ['2026-09-10', -1000, 50000]);
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([true, false]);
  });

  it('R4.3 E5: a candidate not hit by key in R4.2 is still available', () => {
    const candidates = existing(['2026-09-10', -1000, 50000, 'k1'], ['2026-09-10', -1000, 50000, 'k2']);
    const rows = incoming(['2026-09-10', -1000, 50000]);
    expect(findBalanceDuplicates(rows, candidates, new Set(['k1']))).toEqual([true]);
  });

  it('R4.3 E6: the only candidate was already hit by key in R4.2 → not skipped', () => {
    const candidates = existing(['2026-09-10', -1000, 50000, 'k1']);
    const rows = incoming(['2026-09-10', -1000, 50000]);
    expect(findBalanceDuplicates(rows, candidates, new Set(['k1']))).toEqual([false]);
  });

  it('R4.3 E7: candidates without balance (manual entry, pending) are not candidates', () => {
    const candidates = existing(['2026-09-03', -7135, null, null]);
    const rows = incoming(['2026-09-03', -7135, 885865]);
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([false]);
  });

  it('R4.3: candidates without dedupe_key are not candidates', () => {
    const candidates = existing(['2026-09-03', -7135, 885865, null]);
    const rows = incoming(['2026-09-03', -7135, 885865]);
    expect(findBalanceDuplicates(rows, candidates, new Set())).toEqual([false]);
  });

  it('R4.3 E8: no candidates → nothing skipped', () => {
    const rows = incoming(
      ['2026-09-03', -7135, 885865],
      ['2026-09-04', -100, 885765],
      ['2026-09-05', -200, 885565],
    );
    expect(findBalanceDuplicates(rows, [], new Set())).toEqual([false, false, false]);
  });
});

describe('R4.3 on fixtures', () => {
  // D5 的纯函数部分：先有 cba/female-2026-09.csv 的 20 笔，再来 cba-statement/female-2026-09.txt
  it('R4.3: CSV then statement for the same month → R4.2 skips 17, R4.3 skips the 3 BPAY rows', () => {
    const csvRows = parseCbaCsv(readFixture('cba/female-2026-09.csv')).map((r) => ({
      ...r,
      description: extractAndMask(r.description).description,
    }));
    const csvKeys = keysFor(FEMALE, csvRows);
    const candidates = csvRows.map((r, i) => ({ ...r, dedupeKey: csvKeys[i] }));

    const parsed = parseCbaStatement(readCbaStatementFixture('female-2026-09.txt'), '0003');
    if (!parsed.ok) throw new Error(parsed.message);
    const pdfRows = parsed.rows.map((r) => ({
      ...r,
      description: extractAndMask(r.description).description,
    }));
    const pdfKeys = keysFor(FEMALE, pdfRows);

    const existingKeys = new Set(csvKeys);
    const keyHits = new Set(pdfKeys.filter((k) => existingKeys.has(k)));
    expect(keyHits.size).toBe(17);

    const rest = pdfRows.filter((_, i) => !existingKeys.has(pdfKeys[i]));
    expect(rest.map((r) => r.date)).toEqual(['2026-09-28', '2026-09-22', '2026-09-03']);
    expect(findBalanceDuplicates(rest, candidates, keyHits)).toEqual([true, true, true]);
  });
});

