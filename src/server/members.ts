// 归属人（member）查询。归属人 = 钱用在谁身上（R5），不是谁付的钱
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { member } from '@/db/schema';
import type { HouseholdContext } from './context';

export type Member = {
  id: string;
  name: string;
  kind: 'person' | 'shared' | 'child';
};

// 列出未归档的归属人，按 sort_order 排
export async function listMembers(ctx: HouseholdContext): Promise<Member[]> {
  return db
    .select({ id: member.id, name: member.name, kind: member.kind })
    .from(member)
    .where(and(eq(member.householdId, ctx.householdId), eq(member.isArchived, false)))
    .orderBy(asc(member.sortOrder), asc(member.name));
}

// 归属人属于当前 household 且没归档。写入前用它检查，防止表单被改成别家的 member id
export async function isActiveMember(ctx: HouseholdContext, memberId: string): Promise<boolean> {
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
  return m !== undefined;
}
