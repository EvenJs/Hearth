import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import { assignOccurrences, dedupeKey, normalizeDescription, type DedupeRow } from './dedupe';
import { extractAndMask } from './extract';

// 期望值来自 business-rules.md R4.1、R4.2 和 fixtures/README.md "再导入 joint-2026-09-overlap.csv"

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
