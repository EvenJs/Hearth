// R26 邀请码的数据访问（M12-3）：发码、列表、撤销、用码注册
// 码的格式、状态、谁能发都用 src/lib/rules/invite.ts 的纯函数，这里只查数据
// 例外：invite 表不全按 household_id 查。列表、撤销按 created_by（R26.3），注册按 code（登录前，没有 ctx）
// 邀请码、密码不打日志
import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/db';
import { account, invite, member, user } from '@/db/schema';
import { auth } from '@/lib/auth';
import {
  canIssue,
  formatInviteCode,
  generateInviteCode,
  inviteExpiresAt,
  inviteStatus,
  normalizeInviteCode,
  parseAdminEmails,
  type InvitePurpose,
  type InviteStatus,
} from '@/lib/rules/invite';
import { sendVerificationAfterSignup } from './auth-email';
import type { HouseholdContext } from './context';
import { linkHouseholdUser, SHARED_MEMBER_NAME, seedNewHousehold } from './seed';

// ---------- 发码（R26.2） ----------

export type CreateInviteInput = { purpose: InvitePurpose; memberId?: string | null };
export type CreateInviteResult =
  { ok: true; id: string; code: string } | { ok: false; message: string };

const MAX_CODE_ATTEMPTS = 5;

const createInviteSchema = z.object({
  purpose: z.enum(['join', 'new_household']),
  memberId: z.string().nullish(),
});

export async function createInvite(
  ctx: HouseholdContext,
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const parsed = createInviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: '输入不对' };
  const { purpose } = parsed.data;

  // R26.2 第 1 条：站长只在发码时判断
  const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, ctx.userId));
  if (!me || !canIssue(purpose, me.email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
    return { ok: false, message: '只有站长能发新建家庭的邀请码' };
  }

  let target: { householdId: string; memberId: string } | null = null;
  if (purpose === 'join') {
    // R26.2 第 2、3 条
    const memberId = parsed.data.memberId;
    if (!memberId) return { ok: false, message: '请选归属人' };
    const wrongMember = { ok: false, message: '归属人不对，刷新页面再试' } as const;
    if (!z.uuid().safeParse(memberId).success) return wrongMember;
    const [m] = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.id, memberId),
          eq(member.householdId, ctx.householdId),
          eq(member.isArchived, false),
        ),
      );
    if (!m) return wrongMember;
    target = { householdId: ctx.householdId, memberId: m.id };
  }

  const createdAt = new Date();
  // R26.1 撞了唯一约束就重新生成，最多 5 次
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateInviteCode((max) => randomInt(max));
    const [row] = await db
      .insert(invite)
      .values({
        code,
        purpose,
        householdId: target?.householdId ?? null,
        memberId: target?.memberId ?? null,
        createdBy: ctx.userId,
        expiresAt: inviteExpiresAt(createdAt),
        createdAt,
      })
      .onConflictDoNothing({ target: invite.code })
      .returning({ id: invite.id });
    if (row) return { ok: true, id: row.id, code };
  }
  return { ok: false, message: '生成邀请码失败，再试一次' };
}

// ---------- 列表（R26.3） ----------

export type InviteListItem = {
  id: string;
  code: string; // 显示用，XXXX-XXXX
  purpose: InvitePurpose;
  memberName: string | null;
  status: InviteStatus;
  expiresAt: Date;
  usedByName: string | null;
  usedAt: Date | null;
  createdAt: Date;
};

// 只列自己发的，新的在前
export async function listInvites(ctx: HouseholdContext): Promise<InviteListItem[]> {
  const usedBy = alias(user, 'used_by_user');
  const rows = await db
    .select({
      id: invite.id,
      code: invite.code,
      purpose: invite.purpose,
      memberName: member.name,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      usedByName: usedBy.name,
      createdAt: invite.createdAt,
    })
    .from(invite)
    .leftJoin(member, eq(member.id, invite.memberId))
    .leftJoin(usedBy, eq(usedBy.id, invite.usedBy))
    .where(eq(invite.createdBy, ctx.userId))
    .orderBy(desc(invite.createdAt), desc(invite.id));

  const now = new Date();
  return rows.map(({ revokedAt, ...r }) => ({
    ...r,
    code: formatInviteCode(r.code),
    status: inviteStatus({ expiresAt: r.expiresAt, usedAt: r.usedAt, revokedAt }, now),
  }));
}

// ---------- 撤销（R26.3） ----------

export type RevokeInviteResult = { ok: true } | { ok: false; message: string };

export async function revokeInvite(ctx: HouseholdContext, id: string): Promise<RevokeInviteResult> {
  const notMine = { ok: false, message: '只能撤销自己发的码' } as const;
  const notUnused = { ok: false, message: '只有没用的码能撤销' } as const;
  if (!z.uuid().safeParse(id).success) return notMine;

  const now = new Date();
  const mine = and(eq(invite.id, id), eq(invite.createdBy, ctx.userId));
  const [row] = await db
    .select({ expiresAt: invite.expiresAt, usedAt: invite.usedAt, revokedAt: invite.revokedAt })
    .from(invite)
    .where(mine);
  if (!row) return notMine;
  if (inviteStatus(row, now) !== 'unused') return notUnused;

  // 读完到改之间可能刚被用掉，条件 UPDATE 再挡一次
  const updated = await db
    .update(invite)
    .set({ revokedAt: now })
    .where(and(mine, isNull(invite.usedAt), isNull(invite.revokedAt), gt(invite.expiresAt, now)))
    .returning({ id: invite.id });
  return updated.length > 0 ? { ok: true } : notUnused;
}

// ---------- 注册（R26.4 到 R26.6） ----------

export type RegisterInput = { email: string; name: string; password: string; code: string };
export type RegisterField = 'email' | 'name' | 'password' | 'code' | 'form';
export type RegisterResult =
  | { ok: true; userId: string; email: string; emailSent: boolean; message: string }
  | { ok: false; field: RegisterField; message: string };

// R26.4 字段整理
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('邮箱格式不对')),
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, '请填名字').max(30, '名字最多 30 个字')),
  password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
  code: z.string(),
});

const fail = (field: RegisterField, message: string) => ({ ok: false, field, message }) as const;
const CODE_NOT_FOUND = fail('code', '邀请码不对，检查一下有没有输错');
const EMAIL_TAKEN = fail('email', '这个邮箱已经注册了，去登录');
const TRY_AGAIN = fail('form', '注册没成功，再试一次');

// R26.4 第 3 到 5 条，顺序和 R26.3 的状态一样
const STATUS_ERROR: Record<Exclude<InviteStatus, 'unused'>, ReturnType<typeof fail>> = {
  revoked: fail('code', '这个邀请码已经撤销了，找发码的人要个新的'),
  used: fail('code', '这个邀请码已经用过了'),
  expired: fail('code', '这个邀请码过期了，找发码的人要个新的'),
};

type InviteRow = {
  id: string;
  purpose: InvitePurpose;
  householdId: string | null;
  memberId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

async function findInvite(code: string): Promise<InviteRow | undefined> {
  const [row] = await db
    .select({
      id: invite.id,
      purpose: invite.purpose,
      householdId: invite.householdId,
      memberId: invite.memberId,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
    })
    .from(invite)
    .where(eq(invite.code, code));
  return row;
}

// 事务里码标不上（刚被用、刚撤销、刚过期）时抛这个，回滚后在事务外重新读码给提示
class InviteTakenError extends Error {}

// 两个人同时用同一个邮箱：后一个撞 user.email 唯一约束。drizzle 把驱动错误包在 cause 里
function isEmailUniqueViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'user_email_unique';
}

// 登录前调用，不拿 HouseholdContext。提交以后发验证邮件，注册完不自动登录
// 方案 a（M12-0）：不走 Better Auth 注册接口，user、account 直接用我们的事务插，和码一起回滚
// 只从 auth.$context 拿密码 hash 和 id 生成（半内部 API，升级 better-auth 后要重测，同 scripts/create-user.ts）
export async function registerWithInvite(input: RegisterInput): Promise<RegisterResult> {
  // R26.4 第 1 条
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return fail(
      field === 'email' || field === 'name' || field === 'password' ? field : 'form',
      issue?.message ?? '输入不对',
    );
  }
  const { email, name, password } = parsed.data;

  // R26.4 第 2 到 5 条：码先校验
  const code = normalizeInviteCode(parsed.data.code);
  if (!code) return CODE_NOT_FOUND;
  const found = await findInvite(code);
  if (!found) return CODE_NOT_FOUND;
  const status = inviteStatus(found, new Date());
  if (status !== 'unused') return STATUS_ERROR[status];

  // R26.4 第 6 条
  if (found.purpose === 'new_household' && name === SHARED_MEMBER_NAME) {
    return fail('name', `名字不能叫"${SHARED_MEMBER_NAME}"`);
  }

  // R26.4 第 7 条：邮箱后校验，码不动
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email));
  if (existing) return EMAIL_TAKEN;

  // hash 慢，放事务外
  const authCtx = await auth.$context;
  const hash = await authCtx.password.hash(password);
  const userId = authCtx.generateId({ model: 'user' });
  const accountId = authCtx.generateId({ model: 'account' });
  if (!userId || !accountId)
    throw new Error('Better Auth 没有生成 id，检查 advanced.database.generateId');

  try {
    await db.transaction(async (tx) => {
      const now = new Date();
      // R26.5 第 1 步：credential 账号的 account_id 就是 user.id，和 Better Auth 注册流程一致
      await tx.insert(user).values({ id: userId, email, name, emailVerified: false });
      await tx.insert(account).values({
        id: accountId,
        userId,
        providerId: 'credential',
        accountId: userId,
        password: hash,
      });

      // R26.5 第 2 步：条件 UPDATE，两个人同时用一个码只有一个改到 1 行
      const marked = await tx
        .update(invite)
        .set({ usedAt: now, usedBy: userId })
        .where(
          and(
            eq(invite.id, found.id),
            isNull(invite.usedAt),
            isNull(invite.revokedAt),
            gt(invite.expiresAt, now),
          ),
        )
        .returning({ id: invite.id });
      if (marked.length === 0) throw new InviteTakenError();

      // R26.5 第 3 步。join 的归属人归档了照样用
      if (found.purpose === 'join') {
        await linkHouseholdUser(tx, {
          householdId: found.householdId!,
          userId,
          memberId: found.memberId!,
        });
      } else {
        await seedNewHousehold(tx, { userId, name });
      }
    });
  } catch (error) {
    if (isEmailUniqueViolation(error)) return EMAIL_TAKEN;
    if (error instanceof InviteTakenError) {
      const again = await findInvite(code);
      const latest = again ? inviteStatus(again, new Date()) : 'unused';
      return latest === 'unused' ? TRY_AGAIN : STATUS_ERROR[latest];
    }
    // 不打输入（码、密码），只记错误本身
    console.error('registerWithInvite 失败', error);
    return TRY_AGAIN;
  }

  // R26.5 提交以后：邮件发不出去账号也不回滚
  const emailSent = await sendVerificationAfterSignup(email);
  return {
    ok: true,
    userId,
    email,
    emailSent,
    message: emailSent
      ? `验证邮件已经发到 ${email}，点邮件里的链接再登录`
      : '注册成功了，但验证邮件没发出去，请联系站长',
  };
}
