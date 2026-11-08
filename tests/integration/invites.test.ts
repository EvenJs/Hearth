// M12-3 邀请码的数据层：发码、撤销、列表、用码注册（docs/rules/R26-invite.md R26.1 到 R26.6）
// 期望值来自 fixtures/cases/17-invite.md，现在 = 2026-12-10T10:00:00+11:00。家庭、用户、码按用例直接插表
// 只假 Date（数据库连接不受影响）。发邮件（D-12）、登录验证（E）在 M12-4 测
import { eq, inArray, like } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { auth } from '@/lib/auth';
import { SEED_CATEGORIES, SEED_RULES, SEED_SYSTEM_CATEGORIES } from '@/lib/seed/data';
import type { HouseholdContext } from '@/server/context';
import {
  createInvite,
  listInvites,
  registerWithInvite,
  revokeInvite,
  type RegisterInput,
} from '@/server/invites';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

// A-2：codes 里有值时 generateInviteCode 按顺序吐，用完走真的
// D-11：在 seed 分类规则之后、建 household_user 时故意抛错
const fault = vi.hoisted(() => ({
  codes: [] as string[],
  failSeed: false,
  failLink: false,
}));
vi.mock('@/lib/rules/invite', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rules/invite')>();
  return {
    ...real,
    generateInviteCode: (random: (max: number) => number) =>
      fault.codes.shift() ?? real.generateInviteCode(random),
  };
});
vi.mock('@/server/seed', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/seed')>();
  return {
    ...real,
    seedNewHousehold: async (...args: Parameters<typeof real.seedNewHousehold>) => {
      const result = await real.seedNewHousehold(...args);
      if (fault.failSeed) throw new Error('故意抛错');
      return result;
    },
    linkHouseholdUser: async (...args: Parameters<typeof real.linkHouseholdUser>) => {
      if (fault.failLink) throw new Error('故意抛错');
      return real.linkHouseholdUser(...args);
    },
  };
});

// Melbourne 夏令时 +11:00
const mel = (s: string) => new Date(`${s}+11:00`);
const NOW = mel('2026-12-10T10:00:00');
const PASSWORD = 'test-pass-1234';
const ADMIN_EMAILS = 'admin@example.com';

let t: DbTestHousehold;
let ctx: { admin: HouseholdContext; female: HouseholdContext; other: HouseholdContext };
let h1Members: Record<'Male' | 'Female' | 'Home' | 'Kid', string>;
let h2: { householdId: string; olivia: string; shared: string };
let invites: Record<string, string>; // I1 → id

const USERS = {
  admin: { id: 'u-admin', email: 'admin@example.com', name: '站长' },
  female: { id: 'u-female', email: 'female@example.com', name: '老婆' },
  other: { id: 'u-other', email: 'olivia@example.com', name: 'Olivia' },
} as const;

type InviteDef = {
  code: string;
  purpose: 'join' | 'new_household';
  household: 'H1' | 'H2' | null;
  member: 'Male' | 'Female' | 'Home' | 'Kid' | 'Olivia' | '共同' | null;
  by: keyof typeof USERS;
  createdAt: string;
  used?: { by: keyof typeof USERS; at: string };
  revokedAt?: string;
};

// 17-invite.md 邀请码表
const INVITES: Record<string, InviteDef> = {
  I1: {
    code: 'HX7K29QD',
    purpose: 'join',
    household: 'H1',
    member: 'Home',
    by: 'female',
    createdAt: '2026-12-09T10:00:00',
  },
  I2: {
    code: 'M4RT8WZP',
    purpose: 'join',
    household: 'H1',
    member: 'Home',
    by: 'female',
    createdAt: '2026-12-07T10:00:00',
  },
  I3: {
    code: 'N6JF3VBC',
    purpose: 'join',
    household: 'H1',
    member: 'Home',
    by: 'female',
    createdAt: '2026-12-07T10:00:01',
  },
  I4: {
    code: 'P9EA5KXT',
    purpose: 'join',
    household: 'H1',
    member: 'Female',
    by: 'admin',
    createdAt: '2026-12-01T09:00:00',
    used: { by: 'female', at: '2026-12-01T09:30:00' },
  },
  I5: {
    code: 'R2WM7HDS',
    purpose: 'join',
    household: 'H1',
    member: 'Home',
    by: 'female',
    createdAt: '2026-12-09T12:00:00',
    revokedAt: '2026-12-09T12:05:00',
  },
  I6: {
    code: 'T5GQ8NYB',
    purpose: 'new_household',
    household: null,
    member: null,
    by: 'admin',
    createdAt: '2026-12-10T09:00:00',
  },
  I7: {
    code: 'W3CZ6PJH',
    purpose: 'join',
    household: 'H1',
    member: 'Kid',
    by: 'admin',
    createdAt: '2026-12-10T08:00:00',
  },
  I8: {
    code: 'K8VD4RAE',
    purpose: 'join',
    household: 'H1',
    member: 'Home',
    by: 'female',
    createdAt: '2026-12-01T10:00:00',
    revokedAt: '2026-12-02T10:00:00',
  },
  I9: {
    code: 'Q7XB2MFN',
    purpose: 'join',
    household: 'H2',
    member: '共同',
    by: 'other',
    createdAt: '2026-12-09T15:00:00',
  },
};

// 测试里注册出来的用户都是 @example.com，基础用户也是。每条用例前全删
async function deleteExampleUsers(): Promise<void> {
  await db.delete(schema.user).where(like(schema.user.email, '%@example.com'));
}

async function seedBase(): Promise<void> {
  t = await createTestHousehold();
  const h1 = t.ctx.householdId;
  const [kid] = await db
    .insert(schema.member)
    .values({ householdId: h1, name: 'Kid', kind: 'child', sortOrder: 3, isArchived: true })
    .returning({ id: schema.member.id });
  h1Members = {
    Male: t.h.member('Male').id,
    Female: t.h.member('Female').id,
    Home: t.h.member('Home').id,
    Kid: kid.id,
  };

  const [hh2] = await db
    .insert(schema.household)
    .values({ name: '别人家' })
    .returning({ id: schema.household.id });
  const [olivia, shared] = await db
    .insert(schema.member)
    .values([
      { householdId: hh2.id, name: 'Olivia', kind: 'person' as const, sortOrder: 0 },
      { householdId: hh2.id, name: '共同', kind: 'shared' as const, sortOrder: 1 },
    ])
    .returning({ id: schema.member.id });
  h2 = { householdId: hh2.id, olivia: olivia.id, shared: shared.id };

  await db
    .insert(schema.user)
    .values(Object.values(USERS).map((u) => ({ ...u, emailVerified: true })));
  await db.insert(schema.householdUser).values([
    { householdId: h1, userId: USERS.admin.id, memberId: h1Members.Male },
    { householdId: h1, userId: USERS.female.id, memberId: h1Members.Female },
    { householdId: h2.householdId, userId: USERS.other.id, memberId: h2.olivia },
  ]);
  ctx = {
    admin: { userId: USERS.admin.id, householdId: h1, memberId: h1Members.Male },
    female: { userId: USERS.female.id, householdId: h1, memberId: h1Members.Female },
    other: { userId: USERS.other.id, householdId: h2.householdId, memberId: h2.olivia },
  };

  const memberId = (d: InviteDef) => {
    if (d.member === null) return null;
    if (d.member === 'Olivia') return h2.olivia;
    if (d.member === '共同') return h2.shared;
    return h1Members[d.member];
  };
  const rows = await db
    .insert(schema.invite)
    .values(
      Object.values(INVITES).map((d) => {
        const createdAt = mel(d.createdAt);
        return {
          code: d.code,
          purpose: d.purpose,
          householdId: d.household === 'H1' ? h1 : d.household === 'H2' ? h2.householdId : null,
          memberId: memberId(d),
          createdBy: USERS[d.by].id,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 72 * 3600 * 1000),
          usedBy: d.used ? USERS[d.used.by].id : null,
          usedAt: d.used ? mel(d.used.at) : null,
          revokedAt: d.revokedAt ? mel(d.revokedAt) : null,
        };
      }),
    )
    .returning({ id: schema.invite.id, code: schema.invite.code });
  invites = Object.fromEntries(
    Object.entries(INVITES).map(([key, d]) => [key, rows.find((r) => r.code === d.code)!.id]),
  );
}

async function getInvite(key: string) {
  const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, invites[key]));
  return row;
}

async function findUser(email: string) {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return row;
}

async function linkOf(userId: string) {
  const [row] = await db
    .select()
    .from(schema.householdUser)
    .where(eq(schema.householdUser.userId, userId));
  return row;
}

const register = (input: Partial<RegisterInput> & { code: string }) =>
  registerWithInvite({ email: 'new@example.com', name: '小红', password: PASSWORD, ...input });

const countHouseholds = () => db.$count(schema.household);
const countLinks = (householdId: string) =>
  db.$count(schema.householdUser, eq(schema.householdUser.householdId, householdId));

describeDb('邀请码数据层（R26）', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('ADMIN_EMAILS', ADMIN_EMAILS);
    fault.codes = [];
    fault.failSeed = false;
    fault.failLink = false;
    await resetBusinessTables();
    await deleteExampleUsers();
    await seedBase();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ---------- 场景 A-2 ----------

  it('R26.1: code collision retries with a new code', async () => {
    fault.codes = ['HX7K29QD', 'ABCDEFGH'];
    const r = await createInvite(ctx.female, { purpose: 'join', memberId: h1Members.Home });
    expect(r).toMatchObject({ ok: true, code: 'ABCDEFGH' });
  });

  it('R26.1: five collisions in a row fail without inserting', async () => {
    fault.codes = Array(5).fill('HX7K29QD');
    const before = await db.$count(schema.invite);
    const r = await createInvite(ctx.female, { purpose: 'join', memberId: h1Members.Home });
    expect(r).toEqual({ ok: false, message: '生成邀请码失败，再试一次' });
    expect(await db.$count(schema.invite)).toBe(before);
  });

  // ---------- 场景 B-3 ----------

  it('R26.2: admin issues new_household with null household and member, expires in 72 hours', async () => {
    const r = await createInvite(ctx.admin, { purpose: 'new_household' });
    if (!r.ok) throw new Error(r.message);
    const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, r.id));
    expect(row).toMatchObject({
      purpose: 'new_household',
      householdId: null,
      memberId: null,
      createdBy: USERS.admin.id,
      expiresAt: mel('2026-12-13T10:00:00'),
    });
    expect(row.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it('R26.2: join invites go to the issuer household, any member kind, already-linked members allowed', async () => {
    for (const [c, m] of [
      [ctx.admin, 'Male'],
      [ctx.female, 'Home'],
      [ctx.female, 'Male'],
    ] as const) {
      const r = await createInvite(c, { purpose: 'join', memberId: h1Members[m] });
      if (!r.ok) throw new Error(r.message);
      const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, r.id));
      expect(row).toMatchObject({ householdId: t.ctx.householdId, memberId: h1Members[m] });
    }
  });

  it('R26.2: non-admin cannot issue new_household', async () => {
    const before = await db.$count(schema.invite);
    expect(await createInvite(ctx.female, { purpose: 'new_household' })).toEqual({
      ok: false,
      message: '只有站长能发新建家庭的邀请码',
    });
    expect(await db.$count(schema.invite)).toBe(before);
  });

  it('R26.2: nobody is admin when ADMIN_EMAILS is not set', async () => {
    vi.stubEnv('ADMIN_EMAILS', undefined);
    expect(await createInvite(ctx.admin, { purpose: 'new_household' })).toEqual({
      ok: false,
      message: '只有站长能发新建家庭的邀请码',
    });
  });

  it('R26.2: join needs a member of this household that is not archived', async () => {
    expect(await createInvite(ctx.female, { purpose: 'join' })).toEqual({
      ok: false,
      message: '请选归属人',
    });
    for (const memberId of [h1Members.Kid, h2.olivia]) {
      expect(await createInvite(ctx.female, { purpose: 'join', memberId })).toEqual({
        ok: false,
        message: '归属人不对，刷新页面再试',
      });
    }
  });

  // ---------- 场景 C-2 ----------

  it('R26.3: issuer revokes own unused invite', async () => {
    expect(await revokeInvite(ctx.female, invites.I1)).toEqual({ ok: true });
    expect((await getInvite('I1')).revokedAt).toEqual(NOW);
    expect(await revokeInvite(ctx.admin, invites.I6)).toEqual({ ok: true });
  });

  it('R26.3: only own invites can be revoked', async () => {
    const notMine = { ok: false, message: '只能撤销自己发的码' };
    expect(await revokeInvite(ctx.admin, invites.I1)).toEqual(notMine);
    expect(await revokeInvite(ctx.other, invites.I1)).toEqual(notMine);
    expect(await revokeInvite(ctx.female, '00000000-0000-4000-8000-000000000000')).toEqual(notMine);
    expect((await getInvite('I1')).revokedAt).toBeNull();
  });

  it('R26.3: used, expired and revoked invites cannot be revoked', async () => {
    const notUnused = { ok: false, message: '只有没用的码能撤销' };
    expect(await revokeInvite(ctx.admin, invites.I4)).toEqual(notUnused);
    expect(await revokeInvite(ctx.female, invites.I2)).toEqual(notUnused);
    expect(await revokeInvite(ctx.female, invites.I5)).toEqual(notUnused);
    expect((await getInvite('I5')).revokedAt).toEqual(mel('2026-12-09T12:05:00'));
  });

  // ---------- 场景 C-3 ----------

  it('R26.3: list shows only own invites, newest first, with status and who used it', async () => {
    const female = await listInvites(ctx.female);
    expect(female.map((i) => i.code)).toEqual([
      'R2WM-7HDS',
      'HX7K-29QD',
      'N6JF-3VBC',
      'M4RT-8WZP',
      'K8VD-4RAE',
    ]);
    expect(female.map((i) => i.status)).toEqual([
      'revoked',
      'unused',
      'unused',
      'expired',
      'revoked',
    ]);
    expect(female[1].memberName).toBe('Home');

    const admin = await listInvites(ctx.admin);
    expect(admin.map((i) => i.code)).toEqual(['T5GQ-8NYB', 'W3CZ-6PJH', 'P9EA-5KXT']);
    expect(admin[2]).toMatchObject({
      status: 'used',
      usedByName: '老婆',
      usedAt: mel('2026-12-01T09:30:00'),
    });
    expect(admin[0]).toMatchObject({ purpose: 'new_household', memberName: null });

    expect((await listInvites(ctx.other)).map((i) => i.code)).toEqual(['Q7XB-2MFN']);
  });

  // ---------- 场景 D-1 ----------

  it('R26.5: join registers into the invite household and member', async () => {
    const memberCount = await db.$count(
      schema.member,
      eq(schema.member.householdId, t.ctx.householdId),
    );
    const h1Categories = await db.$count(
      schema.category,
      eq(schema.category.householdId, t.ctx.householdId),
    );
    const households = await countHouseholds();

    const r = await registerWithInvite({
      email: ' Kid@Example.com ',
      name: '小明',
      password: PASSWORD,
      code: '  hx7k 29qd  ',
    });
    expect(r).toMatchObject({ ok: true, email: 'kid@example.com' });

    const u = await findUser('kid@example.com');
    expect(u).toMatchObject({ name: '小明', emailVerified: false });
    const [cred] = await db.select().from(schema.account).where(eq(schema.account.userId, u.id));
    expect(cred).toMatchObject({ providerId: 'credential', accountId: u.id });
    expect(cred.password).toBeTruthy();
    expect(cred.password).not.toContain(PASSWORD);

    expect(await linkOf(u.id)).toMatchObject({
      householdId: t.ctx.householdId,
      memberId: t.h.member('Home').id,
    });
    expect(await getInvite('I1')).toMatchObject({ usedBy: u.id, usedAt: NOW });
    expect(await db.$count(schema.member, eq(schema.member.householdId, t.ctx.householdId))).toBe(
      memberCount,
    );
    expect(
      await db.$count(schema.category, eq(schema.category.householdId, t.ctx.householdId)),
    ).toBe(h1Categories);
    expect(await countHouseholds()).toBe(households);
  });

  it('R26.5: registered password works with Better Auth sign-in', async () => {
    vi.useRealTimers(); // session 过期时间按真的现在算
    await register({ email: 'kid@example.com', code: 'HX7K-29QD' });
    const res = await auth.api.signInEmail({
      body: { email: 'kid@example.com', password: PASSWORD },
    });
    expect(res.user.email).toBe('kid@example.com');
  });

  // ---------- 场景 D-2 ----------

  it('R26.6: new_household creates household, two members, catalog and default member mapping', async () => {
    const r = await registerWithInvite({
      email: 'friend@example.com',
      name: '  Alex   Chen ',
      password: PASSWORD,
      code: 'T5GQ-8NYB',
    });
    if (!r.ok) throw new Error(r.message);
    const u = await findUser('friend@example.com');
    expect(u.name).toBe('Alex Chen');

    const link = await linkOf(u.id);
    const h3 = link.householdId;
    expect(h3).not.toBe(t.ctx.householdId);
    const [hh] = await db.select().from(schema.household).where(eq(schema.household.id, h3));
    expect(hh.name).toBe('Alex Chen的家');

    const members = await db
      .select({
        id: schema.member.id,
        name: schema.member.name,
        kind: schema.member.kind,
        sortOrder: schema.member.sortOrder,
      })
      .from(schema.member)
      .where(eq(schema.member.householdId, h3))
      .orderBy(schema.member.sortOrder);
    expect(members.map(({ id: _id, ...m }) => m)).toEqual([
      { name: 'Alex Chen', kind: 'person', sortOrder: 0 },
      { name: '共同', kind: 'shared', sortOrder: 1 },
    ]);
    const [alex, shared] = members;
    expect(link.memberId).toBe(alex.id);

    const categories = await db
      .select()
      .from(schema.category)
      .where(eq(schema.category.householdId, h3));
    const expectedCategoryCount =
      SEED_CATEGORIES.length +
      SEED_CATEGORIES.reduce((n, c) => n + c.children.length, 0) +
      SEED_SYSTEM_CATEGORIES.length;
    expect(categories).toHaveLength(expectedCategoryCount);

    const sharedTops = ['Home & utilities', 'Insurance & financial', 'Groceries'];
    for (const c of categories.filter((c) => c.parentId === null)) {
      expect([c.nameEn, c.defaultMemberId]).toEqual([
        c.nameEn,
        sharedTops.includes(c.nameEn) ? shared.id : null,
      ]);
    }

    const rules = await db
      .select()
      .from(schema.categoryRule)
      .where(eq(schema.categoryRule.householdId, h3));
    expect(rules).toHaveLength(SEED_RULES.length);
    const ids = new Set(categories.map((c) => c.id));
    expect(rules.every((rule) => ids.has(rule.categoryId))).toBe(true);

    for (const table of [
      schema.financialAccount,
      schema.card,
      schema.budget,
      schema.goal,
      schema.taxProfile,
      schema.accountCondition,
    ]) {
      expect(await db.$count(table, eq(table.householdId, h3))).toBe(0);
    }
    expect(await getInvite('I6')).toMatchObject({ usedBy: u.id });
  });

  // ---------- 场景 D-4、D-5 ----------

  it('R26.4: email already registered keeps the invite unused', async () => {
    const r = await register({ email: 'Female@Example.com ', code: 'HX7K-29QD' });
    expect(r).toMatchObject({ ok: false, message: '这个邮箱已经注册了，去登录' });
    expect((await getInvite('I1')).usedAt).toBeNull();

    expect(await register({ email: 'kid@example.com', code: 'HX7K-29QD' })).toMatchObject({
      ok: true,
    });
  });

  it('R26.4: invite is checked before email', async () => {
    expect(await register({ email: 'female@example.com', code: 'ZZZZ-ZZZZ' })).toMatchObject({
      message: '邀请码不对，检查一下有没有输错',
    });
    expect(await register({ email: 'female@example.com', code: 'M4RT-8WZP' })).toMatchObject({
      message: '这个邀请码过期了，找发码的人要个新的',
    });
  });

  // ---------- 场景 D-6 ----------

  it('R26.4: invalid, expired, used and revoked invites create no user and leave the invite alone', async () => {
    const cases: [string, string][] = [
      ['ZZZZ-ZZZZ', '邀请码不对，检查一下有没有输错'],
      ['HX7K-29Q0', '邀请码不对，检查一下有没有输错'],
      ['M4RT-8WZP', '这个邀请码过期了，找发码的人要个新的'],
      ['P9EA-5KXT', '这个邀请码已经用过了'],
      ['R2WM-7HDS', '这个邀请码已经撤销了，找发码的人要个新的'],
      ['K8VD-4RAE', '这个邀请码已经撤销了，找发码的人要个新的'],
    ];
    const before = await db.select().from(schema.invite);
    for (const [code, message] of cases) {
      expect(await register({ code })).toMatchObject({ ok: false, message });
    }
    expect(await findUser('new@example.com')).toBeUndefined();
    expect(await db.select().from(schema.invite)).toEqual(before);
  });

  it('R26.3: invite one second before expiry still registers', async () => {
    expect(await register({ code: 'N6JF-3VBC' })).toMatchObject({ ok: true });
    const u = await findUser('new@example.com');
    expect(await linkOf(u.id)).toMatchObject({
      householdId: t.ctx.householdId,
      memberId: h1Members.Home,
    });
  });

  // ---------- 场景 D-7 ----------

  it('R26.5: join with an archived member still works and keeps it archived', async () => {
    expect(await register({ code: 'W3CZ-6PJH' })).toMatchObject({ ok: true });
    const u = await findUser('new@example.com');
    expect((await linkOf(u.id)).memberId).toBe(h1Members.Kid);
    const [kid] = await db.select().from(schema.member).where(eq(schema.member.id, h1Members.Kid));
    expect(kid.isArchived).toBe(true);
  });

  // ---------- 场景 D-8 ----------

  it('R26.4: field validation errors create no user and leave the invite alone', async () => {
    const cases: [Partial<RegisterInput>, string, string][] = [
      [{ email: 'not-an-email' }, 'email', '邮箱格式不对'],
      [{ name: '   ' }, 'name', '请填名字'],
      [{ name: '一'.repeat(31) }, 'name', '名字最多 30 个字'],
      [{ password: '1234567' }, 'password', '密码至少 8 位'],
      [{ password: 'a'.repeat(129) }, 'password', '密码最多 128 位'],
      [{ email: 'not-an-email', code: 'ZZZZ-ZZZZ' }, 'email', '邮箱格式不对'],
    ];
    for (const [input, field, message] of cases) {
      expect(await register({ code: 'HX7K-29QD', ...input })).toEqual({
        ok: false,
        field,
        message,
      });
    }
    expect(await db.$count(schema.user, eq(schema.user.email, 'new@example.com'))).toBe(0);
    expect((await getInvite('I1')).usedAt).toBeNull();
  });

  it('R26.4: name of 30 characters and password of 8 are accepted', async () => {
    expect(await register({ name: '一'.repeat(30), code: 'HX7K-29QD' })).toMatchObject({
      ok: true,
    });
    expect(
      await register({ email: 'b@example.com', password: '12345678', code: 'N6JF-3VBC' }),
    ).toMatchObject({ ok: true });
  });

  // ---------- 场景 D-9 ----------

  it('R26.4: new_household name cannot be 共同, join can', async () => {
    expect(await register({ name: ' 共同 ', code: 'T5GQ-8NYB' })).toEqual({
      ok: false,
      field: 'name',
      message: '名字不能叫"共同"',
    });
    expect((await getInvite('I6')).usedAt).toBeNull();
    expect(await register({ name: '共同', code: 'HX7K-29QD' })).toMatchObject({ ok: true });
  });

  // ---------- 场景 D-10 ----------

  it('R26.5: two concurrent registrations with one join invite, only one succeeds', async () => {
    const before = await countLinks(t.ctx.householdId);
    const results = await Promise.all([
      register({ email: 'a@example.com', code: 'HX7K-29QD' }),
      register({ email: 'b@example.com', code: 'HX7K-29QD' }),
    ]);
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ message: '这个邀请码已经用过了' });

    const winner = ok[0].ok ? ok[0].userId : '';
    expect((await getInvite('I1')).usedBy).toBe(winner);
    const loserEmail =
      winner === (await findUser('a@example.com'))?.id ? 'b@example.com' : 'a@example.com';
    expect(await findUser(loserEmail)).toBeUndefined();
    expect(await countLinks(t.ctx.householdId)).toBe(before + 1);
  });

  it('R26.5: two concurrent registrations with one new_household invite create one household', async () => {
    const households = await countHouseholds();
    const results = await Promise.all([
      register({ email: 'a@example.com', name: 'A', code: 'T5GQ-8NYB' }),
      register({ email: 'b@example.com', name: 'B', code: 'T5GQ-8NYB' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await countHouseholds()).toBe(households + 1);
    expect(await db.$count(schema.member, inArray(schema.member.name, ['A', 'B']))).toBe(1);
  });

  // ---------- 场景 D-11 ----------

  it('R26.5: failure while seeding the new household rolls everything back', async () => {
    fault.failSeed = true;
    const households = await countHouseholds();
    const members = await db.$count(schema.member);
    const categories = await db.$count(schema.category);
    expect(
      await register({ email: 'friend@example.com', name: 'Alex', code: 'T5GQ-8NYB' }),
    ).toEqual({
      ok: false,
      field: 'form',
      message: '注册没成功，再试一次',
    });
    expect(await findUser('friend@example.com')).toBeUndefined();
    expect(await countHouseholds()).toBe(households);
    expect(await db.$count(schema.member)).toBe(members);
    expect(await db.$count(schema.category)).toBe(categories);
    expect((await getInvite('I6')).usedAt).toBeNull();
  });

  it('R26.5: failure while linking household_user rolls back user and invite', async () => {
    fault.failLink = true;
    expect(await register({ code: 'HX7K-29QD' })).toMatchObject({
      ok: false,
      message: '注册没成功，再试一次',
    });
    expect(await findUser('new@example.com')).toBeUndefined();
    expect((await getInvite('I1')).usedAt).toBeNull();
  });

  it('R26.5: two concurrent registrations with the same email, the loser keeps its invite', async () => {
    const results = await Promise.all([
      register({ email: 'same@example.com', code: 'HX7K-29QD' }),
      register({ email: 'same@example.com', code: 'N6JF-3VBC' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ message: '这个邮箱已经注册了，去登录' });

    const u = await findUser('same@example.com');
    const used = await db
      .select({ code: schema.invite.code, usedBy: schema.invite.usedBy })
      .from(schema.invite)
      .where(inArray(schema.invite.id, [invites.I1, invites.I3]));
    expect(used.filter((i) => i.usedBy !== null)).toEqual([
      expect.objectContaining({ usedBy: u.id }),
    ]);
  });
});
