import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INVITE_ALPHABET,
  canIssue,
  formatInviteCode,
  generateInviteCode,
  inviteExpiresAt,
  inviteStatus,
  normalizeInviteCode,
  parseAdminEmails,
  type InviteState,
} from './invite';

// 期望值来自 docs/rules/R26-invite.md R26.1 到 R26.3
// 和 fixtures/cases/17-invite.md 场景 A 到 C（现在 = 2026-12-10T10:00:00+11:00）

const NOW = new Date('2026-12-10T10:00:00+11:00');

// 按顺序吐出固定下标的随机数来源
const fixedRandom = (indexes: number[]) => {
  let i = 0;
  return (max: number) => {
    expect(max).toBe(31);
    return indexes[i++];
  };
};

const t = (melbourne: string) => new Date(`${melbourne}+11:00`);

const invite = (createdAt: string, over: Partial<InviteState> = {}): InviteState => ({
  expiresAt: inviteExpiresAt(t(createdAt)),
  usedAt: null,
  revokedAt: null,
  ...over,
});

// 17 号用例的邀请码表
const I1 = invite('2026-12-09T10:00:00');
const I2 = invite('2026-12-07T10:00:00');
const I3 = invite('2026-12-07T10:00:01');
const I4 = invite('2026-12-01T09:00:00', { usedAt: t('2026-12-01T09:30:00') });
const I5 = invite('2026-12-09T12:00:00', { revokedAt: t('2026-12-09T12:05:00') });
const I6 = invite('2026-12-10T09:00:00');
const I7 = invite('2026-12-10T08:00:00');
const I8 = invite('2026-12-01T10:00:00', { revokedAt: t('2026-12-02T10:00:00') });
const I9 = invite('2026-12-09T15:00:00');

describe('R26.1 码的格式和生成', () => {
  it('R26.1: alphabet is 31 chars without 0 O 1 I L', () => {
    expect(INVITE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    expect(INVITE_ALPHABET).toHaveLength(31);
    for (const c of '0O1IL') expect(INVITE_ALPHABET).not.toContain(c);
  });

  it.each([
    [[0, 1, 2, 3, 4, 5, 6, 7], 'ABCDEFGH', 'ABCD-EFGH'],
    [[30, 30, 30, 30, 30, 30, 30, 30], '99999999', '9999-9999'],
    [[7, 20, 28, 9, 23, 30, 13, 3], 'HX7K29QD', 'HX7K-29QD'],
    [[8, 22, 10, 25, 12, 26, 27, 29], 'JZM4P568', 'JZM4-P568'],
  ])('R26.1: random indexes %j generate %s, shown as %s', (indexes, stored, shown) => {
    const code = generateInviteCode(fixedRandom(indexes));
    expect(code).toBe(stored);
    expect(formatInviteCode(code)).toBe(shown);
  });

  it('R26.1: 1000 codes from crypto.randomInt are 8 chars in the alphabet', () => {
    for (let n = 0; n < 1000; n++) {
      const code = generateInviteCode(randomInt);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('R26.1: random source out of range throws', () => {
    expect(() => generateInviteCode(() => 31)).toThrow();
    expect(() => generateInviteCode(() => -1)).toThrow();
    expect(() => generateInviteCode(() => 1.5)).toThrow();
  });

  it('R26.1: expires 72 hours after created_at', () => {
    expect(inviteExpiresAt(t('2026-12-10T10:00:00'))).toEqual(t('2026-12-13T10:00:00'));
  });

  it('R26.1: 72 hours by absolute time across DST change', () => {
    // Melbourne 2027-04-04 03:00 夏令时结束
    const created = new Date('2027-04-03T10:00:00+11:00');
    expect(inviteExpiresAt(created)).toEqual(new Date('2027-04-06T09:00:00+10:00'));
  });
});

describe('R26.1 输入整理', () => {
  it.each([
    ['HX7K-29QD', 'HX7K29QD'],
    ['hx7k-29qd', 'HX7K29QD'],
    ['  hx7k 29qd  ', 'HX7K29QD'],
    ['HX7K--29QD', 'HX7K29QD'],
    ['Hx7k-\t29Qd', 'HX7K29QD'],
    ['HX7K\n29QD', 'HX7K29QD'],
    ['ZZZZ-ZZZZ', 'ZZZZZZZZ'],
  ])('R26.1: %j normalizes to %s', (input, expected) => {
    expect(normalizeInviteCode(input)).toBe(expected);
  });

  it.each([
    ['HX7K_29QD', '下划线不去'],
    ['HX7K-29Q', '7 位'],
    ['HX7K-29QDA', '9 位'],
    ['HX7K-29Q0', '有 0，不纠正成 O'],
    ['HX7K-29QO', '有 O'],
    ['HX7K-29Q1', '有 1'],
    ['', '空字符串'],
  ])('R26.1: %j is bad format → null (%s)', (input) => {
    expect(normalizeInviteCode(input)).toBeNull();
  });
});

describe('R26.2 谁能发', () => {
  it.each([
    ['admin@example.com', 'admin@example.com', true],
    [' Admin@Example.com , ,ops@example.com', 'admin@example.com', true],
    [' Admin@Example.com , ,ops@example.com', 'ops@example.com', true],
    ['admin@example.com', 'ADMIN@EXAMPLE.COM', true],
    ['admin@example.com', 'female@example.com', false],
    ['admin@example.com', 'admin@example.com.au', false],
    ['admin@example.com.au', 'admin@example.com', false],
    [undefined, 'admin@example.com', false],
    ['', 'admin@example.com', false],
    [' , ', 'admin@example.com', false],
  ])('R26.2: ADMIN_EMAILS %j, user %s → admin %s', (env, email, isAdmin) => {
    const admins = parseAdminEmails(env);
    expect(canIssue('new_household', email, admins)).toBe(isAdmin);
    expect(canIssue('join', email, admins)).toBe(true);
  });

  it('R26.2: parseAdminEmails trims, lowercases, drops empty items', () => {
    expect(parseAdminEmails(' Admin@Example.com , ,ops@example.com')).toEqual([
      'admin@example.com',
      'ops@example.com',
    ]);
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails(' , ')).toEqual([]);
  });

  it.each([
    ['admin@example.com', 'admin@example.com', ['join', 'new_household']],
    ['admin@example.com', 'female@example.com', ['join']],
    [undefined, 'admin@example.com', ['join']],
  ] as const)('R26.2: ADMIN_EMAILS %j, user %s can pick %j', (env, email, purposes) => {
    const admins = parseAdminEmails(env);
    const allowed = (['join', 'new_household'] as const).filter((p) => canIssue(p, email, admins));
    expect(allowed).toEqual(purposes);
  });
});

describe('R26.3 码的状态', () => {
  it.each([
    ['I1', I1, 'unused'],
    ['I2 刚好 3 天整', I2, 'expired'],
    ['I3 差 1 秒', I3, 'unused'],
    ['I4 已用也过了 expires_at', I4, 'used'],
    ['I5', I5, 'revoked'],
    ['I6', I6, 'unused'],
    ['I7', I7, 'unused'],
    ['I8 撤销也过期', I8, 'revoked'],
    ['I9', I9, 'unused'],
  ] as const)('R26.3: %s at base now is %s', (_name, inv, status) => {
    expect(inviteStatus(inv, NOW)).toBe(status);
  });

  it.each([
    ['I1', I1, '2026-12-12T09:59:59', 'unused'],
    ['I1', I1, '2026-12-12T10:00:00', 'expired'],
    ['I1', I1, '2026-12-12T10:00:01', 'expired'],
    ['I3', I3, '2026-12-10T10:00:00', 'unused'],
    ['I3', I3, '2026-12-10T10:00:01', 'expired'],
    ['I2', I2, '2026-12-10T09:59:59', 'unused'],
  ] as const)('R26.3: %s at %s is %s', (_name, inv, now, status) => {
    expect(inviteStatus(inv, t(now))).toBe(status);
  });

  it('R26.3: revoked wins over used', () => {
    expect(
      inviteStatus(invite('2026-12-09T10:00:00', { usedAt: NOW, revokedAt: NOW }), NOW),
    ).toBe('revoked');
  });
});
