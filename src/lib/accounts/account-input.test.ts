import { describe, expect, it } from 'vitest';
import { accountPurpose, accountType, bank } from '@/db/schema';
import { ACCOUNT_PURPOSES } from '@/lib/rules/balance';
import { ACCOUNT_TYPES, BANKS, accountInputSchema } from './account-input';

const MEMBER_ID = '6f1c2a3e-9b4d-4c5e-8f7a-1b2c3d4e5f60';

const valid = {
  name: 'ANZ Joint',
  bank: 'anz',
  type: 'joint',
  defaultMemberId: MEMBER_ID,
  numberSuffix: '0001',
};

function errorsOf(input: unknown) {
  const r = accountInputSchema.safeParse(input);
  if (r.success) return null;
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('enums', () => {
  it('BANKS and ACCOUNT_TYPES match the database enums', () => {
    expect([...BANKS]).toEqual(bank.enumValues);
    expect([...ACCOUNT_TYPES]).toEqual(accountType.enumValues);
  });

  it('R23.4: ACCOUNT_PURPOSES match the database enum', () => {
    expect([...ACCOUNT_PURPOSES]).toEqual(accountPurpose.enumValues);
  });
});

describe('accountInputSchema', () => {
  it('accepts the 5 accounts in fixtures/README.md', () => {
    const fixtures = [
      { name: 'ANZ Joint', bank: 'anz', type: 'joint', numberSuffix: '0001' },
      { name: 'ANZ Male', bank: 'anz', type: 'everyday', numberSuffix: '0002' },
      { name: 'CBA Female', bank: 'cba', type: 'everyday', numberSuffix: '0003' },
      { name: 'CBA Female Saver', bank: 'cba', type: 'savings', numberSuffix: '7777' },
      { name: 'ANZ Plus Male', bank: 'anz_plus', type: 'savings', numberSuffix: '0004' },
    ];
    for (const f of fixtures) {
      expect(accountInputSchema.parse({ ...f, defaultMemberId: MEMBER_ID })).toEqual({
        ...f,
        defaultMemberId: MEMBER_ID,
      });
    }
  });

  it('accepts the 4 accounts added in fixtures 18 (BOQ, Westpac)', () => {
    const fixtures = [
      { name: 'BOQ Everyday Male', bank: 'boq', type: 'everyday', numberSuffix: '0007', statementName: 'Everyday Account' },
      { name: 'BOQ Future Saver Male', bank: 'boq', type: 'savings', numberSuffix: '0008', statementName: 'Future Saver' },
      { name: 'Westpac Choice Male', bank: 'westpac', type: 'everyday', numberSuffix: '005', statementName: 'Westpac Choice' },
      { name: 'Westpac Life Male', bank: 'westpac', type: 'savings', numberSuffix: '006', statementName: 'Westpac Life' },
    ];
    for (const f of fixtures) {
      expect(accountInputSchema.parse({ ...f, defaultMemberId: MEMBER_ID })).toEqual({
        ...f,
        defaultMemberId: MEMBER_ID,
      });
    }
  });

  it('trims the name and requires it', () => {
    expect(accountInputSchema.parse({ ...valid, name: '  ANZ Joint  ' }).name).toBe('ANZ Joint');
    expect(errorsOf({ ...valid, name: '' })).toEqual([{ path: 'name', message: '名称必填' }]);
    expect(errorsOf({ ...valid, name: '   ' })).toEqual([{ path: 'name', message: '名称必填' }]);
  });

  it('empty suffix becomes null', () => {
    expect(accountInputSchema.parse({ ...valid, numberSuffix: '' }).numberSuffix).toBeNull();
    expect(accountInputSchema.parse({ ...valid, numberSuffix: '   ' }).numberSuffix).toBeNull();
  });

  it('suffix accepts 4 to 6 digits', () => {
    expect(accountInputSchema.parse({ ...valid, numberSuffix: '1234' }).numberSuffix).toBe('1234');
    expect(accountInputSchema.parse({ ...valid, numberSuffix: '123456' }).numberSuffix).toBe(
      '123456',
    );
    expect(accountInputSchema.parse({ ...valid, numberSuffix: ' 6691 ' }).numberSuffix).toBe(
      '6691',
    );
  });

  it.each(['123', '12a4', '1234567', '12 34', '１２３４', '-1234'])(
    'suffix %j is rejected',
    (numberSuffix) => {
      expect(errorsOf({ ...valid, numberSuffix })).toEqual([
        { path: 'numberSuffix', message: '尾号是 4 到 6 位数字' },
      ]);
    },
  );

  it('R1G: westpac suffix accepts 3 to 5 digits', () => {
    const westpac = { ...valid, name: 'Westpac Choice', bank: 'westpac', type: 'everyday' };
    for (const numberSuffix of ['005', '0005', '20005']) {
      expect(accountInputSchema.parse({ ...westpac, numberSuffix }).numberSuffix).toBe(numberSuffix);
    }
  });

  // R1G：Westpac 账号只有 6 位，填 6 位就是完整账号
  it.each(['12', '120005', '1234567', '12a'])('R1G: westpac suffix %j is rejected', (numberSuffix) => {
    const westpac = { ...valid, name: 'Westpac Choice', bank: 'westpac', type: 'everyday' };
    expect(errorsOf({ ...westpac, numberSuffix })).toEqual([
      { path: 'numberSuffix', message: 'Westpac 尾号是 3 到 5 位数字（账号只有 6 位，不能填满）' },
    ]);
  });

  it('R6.1: statement name is trimmed, empty becomes null, not passed stays undefined', () => {
    expect(accountInputSchema.parse(valid).statementName).toBeUndefined();
    expect(accountInputSchema.parse({ ...valid, statementName: '  Westpac Life ' }).statementName).toBe(
      'Westpac Life',
    );
    expect(accountInputSchema.parse({ ...valid, statementName: '   ' }).statementName).toBeNull();
    expect(accountInputSchema.parse({ ...valid, statementName: null }).statementName).toBeNull();
    expect(errorsOf({ ...valid, statementName: 'x'.repeat(51) })?.[0].path).toBe('statementName');
  });

  it('cash account (type = cash) cannot have a suffix', () => {
    const cash = { ...valid, name: '现金（我）', bank: 'cash', type: 'cash' };
    expect(errorsOf({ ...cash, numberSuffix: '1234' })).toEqual([
      { path: 'numberSuffix', message: '现金账户不填尾号' },
    ]);
    expect(accountInputSchema.parse({ ...cash, numberSuffix: '' }).numberSuffix).toBeNull();
  });

  it('rejects unknown bank, type and non-uuid member', () => {
    expect(errorsOf({ ...valid, bank: 'nab' })?.[0].path).toBe('bank');
    expect(errorsOf({ ...valid, type: 'loan' })?.[0].path).toBe('type');
    expect(errorsOf({ ...valid, defaultMemberId: 'Male' })?.[0].path).toBe('defaultMemberId');
  });

  it('R23.4: purpose, linked account and opening balance are optional', () => {
    const parsed = accountInputSchema.parse(valid);
    expect(parsed.purpose).toBeUndefined();
    expect(parsed.linkedAccountId).toBeUndefined();
    expect(parsed.openingBalanceCents).toBeUndefined();
    expect(
      accountInputSchema.parse({
        ...valid,
        purpose: 'bills',
        linkedAccountId: null,
        openingBalanceCents: -45000,
      }),
    ).toMatchObject({ purpose: 'bills', linkedAccountId: null, openingBalanceCents: -45000 });
  });

  it('R23.4: rejects unknown purpose, non-uuid link and non-integer opening balance', () => {
    expect(errorsOf({ ...valid, purpose: 'travel' })?.[0].path).toBe('purpose');
    expect(errorsOf({ ...valid, linkedAccountId: 'ANZ Male' })?.[0].path).toBe('linkedAccountId');
    expect(errorsOf({ ...valid, openingBalanceCents: 12.5 })?.[0].path).toBe(
      'openingBalanceCents',
    );
  });
});
