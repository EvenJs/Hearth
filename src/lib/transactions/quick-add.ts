// F3 快速录入弹窗的表单逻辑（M6-3）：分类 chips、"更多…"的可选范围、猜分类、切换支出 / 收入、
// "自动（X）"、状态提示、保存并再记一笔
// 字段怎么写入数据库由 src/lib/rules/manual.ts 定，这里只管表单上的状态怎么变
// 纯函数，不 import 数据库和 Next.js
import { bySystemKey } from '@/lib/rules/classify';
import {
  guessCategory,
  isAllowedForKind,
  type EntryKind,
  type ManualInput,
} from '@/lib/rules/manual';
import { resolveMember, type MemberContext, type MemberResult } from '@/lib/rules/member';
import { initialStatus } from '@/lib/rules/pending';
import type { TransactionStatus } from '@/lib/rules/pending';
import type { EditCategory } from '@/lib/rules/split-edit';
import type { Account, CategoryRule } from '@/lib/rules/types';
import type { PickerSections } from './category-picker';

// ---------- 表单状态 ----------

// 分类的三种来源（R17.3）：
// - 猜的：guessed = true，用户没点过
// - 用户点过：touched = true（包括点了以后又取消成未分类）
// - 都不是：没选，描述变了会继续猜
export type CategoryChoice = {
  categoryId: string | null; // null = 未分类
  guessed: boolean;
  touched: boolean;
};

export const NO_CATEGORY: CategoryChoice = { categoryId: null, guessed: false, touched: false };

export type QuickAddValues = {
  amount: string;
  kind: EntryKind;
  description: string;
  accountId: string | null; // 没有上次账户时为空，让用户选（R17.2）
  date: string; // YYYY-MM-DD
  category: CategoryChoice;
  memberId: string | null; // null = 自动
};

// R17.1 / R17.2：支出、今天、上次账户，其余空的
export function emptyValues(opts: { lastAccountId: string | null; today: string }): QuickAddValues {
  return {
    amount: '',
    kind: 'expense',
    description: '',
    accountId: opts.lastAccountId,
    date: opts.today,
    category: NO_CATEGORY,
    memberId: null,
  };
}

// R17.4 保存并再记一笔：留账户、日期、支出 / 收入；清金额、描述、分类，归属人回到自动
export function nextEntryValues(prev: QuickAddValues): QuickAddValues {
  return {
    ...prev,
    amount: '',
    description: '',
    category: NO_CATEGORY,
    memberId: null,
  };
}

// 表单值 → createManualTransaction 的输入。没选账户在前端拦下来，不发请求
export function toManualInput(
  v: QuickAddValues,
): { ok: true; input: ManualInput } | { ok: false; errors: { accountId: string } } {
  if (!v.accountId) return { ok: false, errors: { accountId: '请选账户' } };
  return {
    ok: true,
    input: {
      amount: v.amount,
      kind: v.kind,
      description: v.description,
      accountId: v.accountId,
      date: v.date,
      categoryId: v.category.categoryId,
      categoryGuessed: v.category.guessed,
      memberId: v.memberId,
    },
  };
}

// ---------- 分类 ----------

// R17.1 "更多…"下拉的可选范围：R16.3 再按切换过滤
// 支出 → expense 一级（带能选的二级）加现金支出、银行费用；收入 → income 一级
// 一级本身能不能选和二级一样判断；一级不能选时整组不出现
export function quickAddSections(
  categories: readonly EditCategory[],
  kind: EntryKind,
): PickerSections {
  const allowed = (c: EditCategory) => isAllowedForKind(c, kind, categories);
  const sections: PickerSections = { groups: [], system: [] };
  for (const top of categories) {
    if (top.parentId !== null || !allowed(top)) continue;
    const group = {
      id: top.id,
      name: top.nameEn,
      kind: top.kind,
      systemKey: top.systemKey,
      children: categories
        .filter((c) => c.parentId === top.id && allowed(c))
        .map((c) => ({ id: c.id, name: c.nameEn })),
    };
    if (top.kind === 'system') sections.system.push(group);
    else sections.groups.push(group);
  }
  return sections;
}

// R17.2 常用分类 chips。选中的分类不在常用里（猜的、从"更多…"选的）时放在最前面，让人看到选中了什么
export function quickAddChips(frequent: readonly string[], selectedId: string | null): string[] {
  if (selectedId === null || frequent.includes(selectedId)) return [...frequent];
  return [selectedId, ...frequent];
}

// R17.2 描述改变（失焦或停顿）时猜分类。用户点过分类就不动
export function guessOnDescription(
  choice: CategoryChoice,
  description: string,
  kind: EntryKind,
  rules: readonly CategoryRule[],
  categories: readonly EditCategory[],
): CategoryChoice {
  if (choice.touched) return choice;
  const guess = guessCategory(description, kind, rules, categories);
  return guess ? { categoryId: guess.categoryId, guessed: true, touched: false } : NO_CATEGORY;
}

// 点 chip 或在"更多…"里选：再点一次选中的 → 取消成未分类。两种都算用户点过
export function pickCategory(choice: CategoryChoice, categoryId: string | null): CategoryChoice {
  if (categoryId === choice.categoryId) {
    return { categoryId: null, guessed: false, touched: true };
  }
  return { categoryId, guessed: false, touched: true };
}

// 切换支出 / 收入（2026-10-26 定）：
// - 分类和新切换类型一致 → 不动
// - 类型对不上 → 清掉，算没点过，按描述重新猜
// - 没选分类：没点过 → 重新猜；自己取消的 → 不动
export function changeKind(
  choice: CategoryChoice,
  kind: EntryKind,
  description: string,
  rules: readonly CategoryRule[],
  categories: readonly EditCategory[],
): CategoryChoice {
  if (choice.categoryId === null) {
    return choice.touched
      ? choice
      : guessOnDescription(NO_CATEGORY, description, kind, rules, categories);
  }
  const current = categories.find((c) => c.id === choice.categoryId);
  if (current && isAllowedForKind(current, kind, categories)) return choice;
  return guessOnDescription(NO_CATEGORY, description, kind, rules, categories);
}

// ---------- 归属人、状态 ----------

// R17.3："自动"旁边显示的人。按 R5 算，手动录入没有卡号；没选分类按未分类算。没选账户 → null
export function autoMember(
  accountId: string | null,
  categoryId: string | null,
  ctx: MemberContext,
): MemberResult | null {
  if (!accountId || !ctx.accounts.some((a) => a.id === accountId)) return null;
  return resolveMember(
    {
      accountId,
      cardLast4: null,
      categoryId: categoryId ?? bySystemKey(ctx.categories, 'uncategorized').id,
    },
    ctx,
  );
}

// R8.1 按账户显示的状态提示
export function statusHint(account: Pick<Account, 'bank'>): {
  status: TransactionStatus;
  message: string;
} {
  const status = initialStatus(account);
  return status === 'confirmed'
    ? { status, message: '现金 / ANZ Plus 账户，保存后直接确认' }
    : { status, message: 'ANZ / CBA 账户会先记为待确认，导入时自动匹配' };
}
