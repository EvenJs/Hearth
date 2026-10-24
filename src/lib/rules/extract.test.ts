import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import {
  extractAndMask,
  extractCardLast4,
  extractMaskedTransferSuffix,
  extractTransferAccount,
  maskLongDigits,
} from './extract';

// 期望值来自 business-rules.md R2.1、R2.2、R2.3、docs/tasks/m2.md M2-4 和 fixtures/README.md

const EIGHT_PLUS_DIGITS = /\d{8,}/;

describe('extractCardLast4（R2.1）', () => {
  it('R2.1: ANZ "CARD 1111" → 1111', () => {
    expect(extractCardLast4('VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE')).toBe('1111');
  });

  it('R2.1: CBA "Card xx1234" → 1234', () => {
    expect(
      extractCardLast4('Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026'),
    ).toBe('1234');
  });

  it('R2.1: no card → null', () => {
    expect(extractCardLast4('ACCOUNT SERVICING FEE')).toBeNull();
    expect(extractCardLast4('EFTPOS MELB ASIAN MARKET\\')).toBeNull();
    expect(extractCardLast4('Transfer from xx5678 CommBank app Home')).toBeNull();
  });
});

describe('extractTransferAccount（R2.2）', () => {
  it.each([
    ['TRANSFER 681801  TO  012345400006691', '012345400006691'],
    ['TRANSFER 815033  FROM       400006691', '400006691'],
    ['Transfer from xx5678 CommBank app Home', '5678'],
    ['ANZ M-BANKING FUNDS TFER TRANSFER 100002  TO  012345400000003', '012345400000003'],
    ['ANZ M-BANKING FUNDS TFER TRANSFER 100001  FROM       400000002', '400000002'],
  ])('R2.2: %s → %s', (description, expected) => {
    expect(extractTransferAccount(description)).toBe(expected);
  });

  it('R2.2: PayID transfer has only a name → null', () => {
    expect(
      extractTransferAccount('Transfer To MISS X Y PayID Phone from CommBank App Eat Eat'),
    ).toBeNull();
    expect(
      extractTransferAccount('Fast Transfer From TEST HOLDER to PayID Phone joint'),
    ).toBeNull();
    expect(
      extractTransferAccount('Fast Transfer From ACME TRADING PTY LTD invoice 0925'),
    ).toBeNull();
  });

  it('R2.2: transfer serial number (681801, 815033) is not extracted', () => {
    expect(extractTransferAccount('TRANSFER 681801  TO  012345400006691')).not.toBe('681801');
    expect(extractTransferAccount('TRANSFER 815033')).toBeNull();
  });

  it('R2.2: only when description contains FUNDS TFER or TRANSFER', () => {
    expect(extractTransferAccount('PAYMENT TO 012345400006691')).toBeNull();
    expect(extractTransferAccount('PAYID DEPOSIT REF DINNER SPLIT')).toBeNull();
  });
});

describe('maskLongDigits（R2.3）', () => {
  it.each([
    ['TO  012345400006691', 'TO  ****6691'],
    ['FROM       400006691', 'FROM       ****6691'],
    ['EASI AU 280672605', 'EASI AU ****2605'],
    ['LN REPAY 700006979', 'LN REPAY ****6979'],
  ])('R2.3: %s → %s', (input, expected) => {
    expect(maskLongDigits(input)).toBe(expected);
  });

  it('R2.3: exactly 8 digits are masked, 7 are not', () => {
    expect(maskLongDigits('Wages 01092026')).toBe('Wages ****2026');
    expect(maskLongDigits('REF 1234567')).toBe('REF 1234567');
  });

  it('R2.3: masks every long run in one description', () => {
    expect(
      maskLongDigits('TAX OFFICE PAYMENTS CommBank app BPAY 75556 5512345678901234 Sept'),
    ).toBe('TAX OFFICE PAYMENTS CommBank app BPAY 75556 ****1234 Sept');
    expect(maskLongDigits('A 12345678 B 987654321')).toBe('A ****5678 B ****4321');
  });

  it('R2.3: serial 681801, BPAY code {022288}, store 0559, card last4, CBA xx5678 unchanged', () => {
    const untouched = [
      'ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ',
      'ANZ INTERNET BANKING BPAY SEENE                         {022288}',
      'VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE',
      'Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026',
      'Transfer from xx5678 CommBank app Home',
    ];
    for (const s of untouched) expect(maskLongDigits(s)).toBe(s);

    expect(maskLongDigits('ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  012345400006691')).toBe(
      'ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ****6691',
    );
  });
});

describe('extractAndMask（R2：先提取，再脱敏）', () => {
  it('R2: extracts the full account before masking it away', () => {
    expect(extractAndMask('ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  012345400006691')).toEqual(
      {
        description: 'ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ****6691',
        cardLast4: null,
        transferAccount: '012345400006691',
      },
    );
  });

  it('R2: card purchase with a 9-digit number', () => {
    expect(extractAndMask('VISA DEBIT PURCHASE CARD 2222 EASI AU 280672605')).toEqual({
      description: 'VISA DEBIT PURCHASE CARD 2222 EASI AU ****2605',
      cardLast4: '2222',
      transferAccount: null,
    });
  });
});

describe('R2 on fixtures', () => {
  it('R2.3: joint-2026-09.csv 19 rows have no 8+ digit run after masking', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    expect(rows).toHaveLength(19);
    const masked = rows.map((r) => extractAndMask(r.description).description);
    for (const d of masked) expect(d).not.toMatch(EIGHT_PLUS_DIGITS);

    // fixtures/README.md 主表 #11、#16（编号和文件行顺序一致）
    expect(masked[11 - 1]).toBe('ANZ M-BANKING FUNDS TFER TRANSFER 100002  TO  ****0003');
    expect(masked[16 - 1]).toBe('VISA DEBIT PURCHASE CARD 2222 EASI AU ****2605');
  });

  it('R2.1: joint-2026-09.csv card numbers', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    const cards = rows.map((r) => extractAndMask(r.description).cardLast4).filter(Boolean);
    expect(cards).toEqual(['1111', '1111', '2222', '3333', '2222', '1111']);
  });

  it('R2.3: cba/female-2026-09.csv 20 rows have no 8+ digit run after masking', () => {
    const rows = parseCbaCsv(readFixture('cba/female-2026-09.csv'));
    expect(rows).toHaveLength(20);
    const masked = rows.map((r) => extractAndMask(r.description).description);
    for (const d of masked) expect(d).not.toMatch(EIGHT_PLUS_DIGITS);

    // fixtures/README.md CBA "入库检查"
    const joined = masked.join('\n');
    for (const secret of [
      '5512345678901234',
      '12345678901234567890',
      '111122223333444000',
      '123456789',
      '01092026',
    ]) {
      expect(joined).not.toContain(secret);
    }
  });

  it('R2.1/R2.2: cba/female-2026-09.csv cards and transfer accounts', () => {
    const rows = parseCbaCsv(readFixture('cba/female-2026-09.csv'));
    const results = rows.map((r) => extractAndMask(r.description));
    expect(results.map((r) => r.cardLast4).filter(Boolean)).toEqual(['5555', '4444', '5555']);
    // 只有 #4 "Transfer from xx7777" 有账号，PayID 转账（#10、#15、#16）都是 null
    expect(results.map((r) => r.transferAccount)).toEqual(
      results.map((_, i) => (i === 3 ? '7777' : null)),
    );
  });
});

describe('extractMaskedTransferSuffix（R12.1 用脱敏后的描述重跑 R6.1）', () => {
  it.each([
    ['TRANSFER 681801  TO  ****6691', '6691'],
    ['TRANSFER 815033  FROM       ****6691', '6691'],
    ['ANZ FUNDS TFER TO ****1234', '1234'],
    // CBA 的 xx 尾号脱敏时不受影响，照常能取
    ['Transfer from xx5678 CommBank app Home', '5678'],
  ])('R12.1: %s → %s', (masked, expected) => {
    expect(extractMaskedTransferSuffix(masked)).toBe(expected);
  });

  it.each([
    // PayID 转账只有人名
    'Transfer To MISS X Y PayID Phone from CommBank App Eat Eat',
    'Fast Transfer From TEST HOLDER JOINT',
    // 不含 FUNDS TFER / TRANSFER 的不取
    'EASI AU ****2605',
    'LOAN REPAYMENT LN REPAY ****6789',
    // 流水号不是账号
    'TRANSFER 681801',
  ])('R12.1: %s → null', (masked) => {
    expect(extractMaskedTransferSuffix(masked)).toBeNull();
  });

  it('R12.1: fixtures joint #11 → 0003, #17 → 0002, #18 → 9999 (from the stored, masked description)', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    const stored = (n: number) => extractAndMask(rows[n - 1].description).description;
    expect(extractMaskedTransferSuffix(stored(11))).toBe('0003');
    expect(extractMaskedTransferSuffix(stored(17))).toBe('0002');
    expect(extractMaskedTransferSuffix(stored(18))).toBe('9999');
  });
});
