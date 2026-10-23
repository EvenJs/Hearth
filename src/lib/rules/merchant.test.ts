import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import { extractAndMask } from './extract';
import { cleanMerchant } from './merchant';

// 期望值来自 business-rules.md R3 表格和 fixtures/README.md 的 merchant 列

describe('cleanMerchant（R3）', () => {
  it.each([
    // ANZ
    ['VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE', 'COLES 0559 MELBOURNE'],
    ['EFTPOS MELB ASIAN MARKET\\', 'MELB ASIAN MARKET'],
    ['EFTPOS SECRET KITCHEN     \\MELBOURNE         AU', 'SECRET KITCHEN MELBOURNE'],
    ['EFTPOS 794PIN* CHARGEFOX PTY LTD\\NORTH MELBOUR\\', 'CHARGEFOX PTY LTD NORTH MELBOUR'],
    ['ANZ INTERNET BANKING BPAY SEENE                         {022288}', 'BPAY SEENE'],
    ['ANZ M-BANKING FUNDS TFER TRANSFER 681801  TO  ****6691', 'TRANSFER TO ****6691'],
    ['EFTPOS ZLR*POCHANA MELBOURNE \\MELBOURNE AU', 'POCHANA MELBOURNE MELBOURNE'],
    ['VISA DEBIT PURCHASE CARD 2222 SQ *KUMO MELBOURNE', 'KUMO MELBOURNE'],
    ['NON-ANZ ATM CBA\\HAWTHORN VIC AU', 'ATM CBA HAWTHORN'],
    ['ACCOUNT SERVICING FEE', 'ACCOUNT SERVICING FEE'],
    // CBA
    ['Myer Pty Ltd Docklands VI AUS Card xx1234 Value Date: 17/09/2026', 'MYER PTY LTD DOCKLANDS'],
    ['myki tap Transport VIC VIC VI AUS Card xx1234 Value Date: 29/08/2026', 'MYKI TAP TRANSPORT'],
    ['ZLR*Tower Sushi & Gourm Melbourne AU', 'TOWER SUSHI & GOURM MELBOURNE'],
    ['MCDONALDS VIC MARKET MELBOURNE VICAU', 'MCDONALDS VIC MARKET MELBOURNE'],
    ['seene CommBank app BPAY 959502 ****9999', 'BPAY SEENE'],
    ['DEFT PAYMENTS CommBank app BPAY 96503 ****7890 INV No 0012345', 'BPAY DEFT PAYMENTS'],
    [
      'Transfer To TEST FRIEND PayID Phone from CommBank App Eat Eat',
      'TRANSFER TO TEST FRIEND EAT EAT',
    ],
    [
      'Fast Transfer From OTHER FRIEND to PayID Phone dinner',
      'FAST TRANSFER FROM OTHER FRIEND DINNER',
    ],
    ['Transfer from xx7777 CommBank app Home', 'TRANSFER FROM XX7777 HOME'],
    ['LIGHTNING BROADBAND Value Date: 11/09/2026', 'LIGHTNING BROADBAND'],
  ])('R3: %s → %s', (masked, merchant) => {
    expect(cleanMerchant(masked)).toBe(merchant);
  });

  it('R3 step 8: keeps at least one word when everything is a region word', () => {
    expect(cleanMerchant('VIC AU')).toBe('VIC');
    expect(cleanMerchant('AUS')).toBe('AUS');
  });

  it('R3 step 2: ANZ prefixes are only removed at the start', () => {
    expect(cleanMerchant('REFUND EFTPOS SHOP')).toBe('REFUND EFTPOS SHOP');
  });
});

describe('R3 on fixtures', () => {
  // fixtures/README.md "期望结果：joint-2026-09.csv" merchant 列，#5 "同上" = #4
  const JOINT_MERCHANTS = [
    'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED',
    'ACCOUNT SERVICING FEE',
    'BPAY SEENE',
    'GONG CHA & HO/SPENCER ST MELBOURNE',
    'GONG CHA & HO/SPENCER ST MELBOURNE',
    'ATM CBA HAWTHORN',
    'PAYID DEPOSIT REF DINNER SPLIT',
    'POCHANA MELBOURNE MELBOURNE',
    'CROWN ASIAN SPENCER DOCKLANDS',
    'MEDICARE BENEFIT',
    'TRANSFER TO ****0003',
    'CHARGEFOX PTY LTD NORTH MELBOUR',
    'MELB ASIAN MARKET',
    'MELB ASIAN MARKET',
    'UNKNOWN SHOP PTY LTD MELBOURNE',
    'EASI AU ****2605',
    'TRANSFER FROM ****0002',
    'TRANSFER FROM ****9999',
    'COLES 0559 MELBOURNE',
  ];

  // fixtures/README.md "期望结果：导入 cba/female-2026-09.csv" merchant 列，#13 "同上" = #12
  const FEMALE_MERCHANTS = [
    'CREDIT INTEREST',
    'BPAY TAX OFFICE PAYMENTS',
    'FAST TRANSFER FROM ACME TRADING PTY LTD INVOICE 0925',
    'TRANSFER FROM XX7777 HOME',
    'BPAY DEFT PAYMENTS',
    'CBA YELLO HLPCKG CSHBK',
    'DIRECT CREDIT 002221 MCARE BENEFITS ****6789 ABCD',
    'CROWN ASIAN SPENCER DOCKLANDS',
    'DIRECT DEBIT 000793 BUPA AUSTRALIA ****4000',
    'FAST TRANSFER FROM TEST HOLDER JOINT',
    'KIS HAIR MELBOURNE',
    'TOWER SUSHI & GOURM MELBOURNE',
    'TOWER SUSHI & GOURM MELBOURNE',
    'LIGHTNING BROADBAND',
    'FAST TRANSFER FROM OTHER FRIEND DINNER',
    'TRANSFER TO TEST FRIEND EAT EAT',
    'OVERLAY COFFEE MELBOURNE',
    'BPAY SEENE',
    'LOAN REPAYMENT LN REPAY ****6789',
    'SALARY EXAMPLE SCHOOL WAGES ****2026',
  ];

  it('R3: joint-2026-09.csv 19 merchants match fixtures/README.md', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    const merchants = rows.map((r) => cleanMerchant(extractAndMask(r.description).description));
    expect(merchants).toEqual(JOINT_MERCHANTS);
  });

  it('R3: cba/female-2026-09.csv 20 merchants match fixtures/README.md', () => {
    const rows = parseCbaCsv(readFixture('cba/female-2026-09.csv'));
    const merchants = rows.map((r) => cleanMerchant(extractAndMask(r.description).description));
    expect(merchants).toEqual(FEMALE_MERCHANTS);
  });
});
