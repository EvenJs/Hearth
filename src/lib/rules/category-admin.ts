// 设置 → 分类（business-rules.md R19）：新建、修改、归档、取消归档的检查和计划
// 可选范围（R16.3）不在这里，用 split-edit.ts 的 isSelectableCategory；归档后不能选就是靠 isArchived
// 纯函数，不 import 数据库和 Next.js
import type { Category, CategoryKind } from './types';

export const CATEGORY_NAME_MAX = 50; // R19.2
export const OTHER_NAME = 'Other'; // R19.2 新建一级时自动建的二级

// 分类管理要用排序和归档状态，Category 本身没有
export type AdminCategory = Category & { sortOrder: number; isArchived: boolean };

type Fail = { ok: false; message: string };
type Result<T> = { ok: true; value: T } | Fail;

const fail = (message: string): Fail => ({ ok: false, message });

const isSystem = (c: Pick<Category, 'kind' | 'systemKey'>) =>
  c.kind === 'system' || c.systemKey !== null;

// ---------- R19.2 名字 ----------

// R19.2：去首尾空格、多个空格合成一个，不能为空，最长 50（按规范化以后算）
export function normalizeCategoryName(name: string): Result<string> {
  const value = name.trim().replace(/\s+/g, ' ');
  if (value.length === 0) return fail('名字不能为空');
  if (value.length > CATEGORY_NAME_MAX) return fail(`名字最长 ${CATEGORY_NAME_MAX} 个字符`);
  return { ok: true, value };
}

// R19.2：同一个一级下（一级之间也一样）不区分大小写不能重名，归档的也算
// 一级之间包括系统分类和另一种类型的一级（它们都是 parent_id 为空）
// name 要先规范化；selfId：修改时自己不算
export function findNameConflict(
  name: string,
  parentId: string | null,
  categories: readonly AdminCategory[],
  selfId?: string,
): string | null {
  const key = name.toLowerCase();
  const clash = categories.find(
    (c) => c.id !== selfId && c.parentId === parentId && c.nameEn.toLowerCase() === key,
  );
  if (!clash) return null;
  if (clash.isArchived) {
    // 不自动取消归档（2026-10-26 补）
    return `已有归档的分类 ${clash.nameEn}，勾"显示已归档"后取消归档就能用`;
  }
  return `已有分类 ${clash.nameEn}`;
}

// ---------- R19.2 排序 ----------

export type SortOrderPlan = {
  sortOrder: number; // 新分类的 sort_order
  moveOther: { id: string; sortOrder: number } | null; // 新二级时 Other 要改成的值；不用改是 null
};

// R19.2：一级排在同类型最后（同组最大值 + 1，组里没有时 0）；
// 二级排在 Other 前面：取除 Other 以外的兄弟最大值 + 1，Other 挪到它后面，保证 Other 始终最后
// 归档的也算进去，免得取消归档后撞位置
export function newCategorySortOrder(
  categories: readonly AdminCategory[],
  target: { parentId: string | null; kind: CategoryKind },
): SortOrderPlan {
  const maxOf = (list: readonly AdminCategory[]) =>
    list.length === 0 ? -1 : Math.max(...list.map((c) => c.sortOrder));

  if (target.parentId === null) {
    const group = categories.filter((c) => c.parentId === null && c.kind === target.kind);
    return { sortOrder: maxOf(group) + 1, moveOther: null };
  }

  const siblings = categories.filter((c) => c.parentId === target.parentId);
  const others = siblings.filter((c) => c.isOther);
  const sortOrder = maxOf(siblings.filter((c) => !c.isOther)) + 1;
  const other = others[0];
  if (!other || other.sortOrder > sortOrder) return { sortOrder, moveOther: null };
  return { sortOrder, moveOther: { id: other.id, sortOrder: sortOrder + 1 } };
}

// ---------- R19.2 新建 ----------

export type NewCategoryInput = {
  nameEn: string; // 用户输入的，还没规范化
  parentId: string | null; // null = 新建一级
  kind?: CategoryKind; // 一级必填；二级跟一级，传了也不用
  defaultMemberId?: string | null;
  isPreTaxDefault?: boolean;
};

export type NewCategoryRow = {
  parentId: string | null;
  nameEn: string;
  kind: CategoryKind;
  defaultMemberId: string | null;
  isPreTaxDefault: boolean;
  isOther: boolean;
  sortOrder: number;
};

export type NewCategoryPlan = {
  category: NewCategoryRow;
  // 新建一级时一起建的 Other（parentId 等插入一级后再填）
  other: Omit<NewCategoryRow, 'parentId'> | null;
  moveOther: SortOrderPlan['moveOther'];
};

// R19.2：名字、类型、税前、只能两级、重名，都过了才返回要插入的行
export function checkNewCategory(
  input: NewCategoryInput,
  categories: readonly AdminCategory[],
): Result<NewCategoryPlan> {
  const name = normalizeCategoryName(input.nameEn);
  if (!name.ok) return name;

  let kind: CategoryKind;
  if (input.parentId === null) {
    if (input.kind !== 'expense' && input.kind !== 'income') {
      return fail('一级分类要选类型：支出或收入');
    }
    kind = input.kind;
    if (input.isPreTaxDefault) return fail('一级分类不能勾税前，只有收入的二级能勾');
  } else {
    const parent = categories.find((c) => c.id === input.parentId);
    if (!parent) return fail('找不到一级分类');
    if (parent.parentId !== null) return fail('只能建两级，二级下面不能再建');
    if (isSystem(parent)) return fail('系统分类下面不能建二级');
    kind = parent.kind; // R19.2：二级跟一级
    if (input.isPreTaxDefault && kind !== 'income') return fail('只有收入的二级能勾税前');
  }

  const conflict = findNameConflict(name.value, input.parentId, categories);
  if (conflict) return fail(conflict);

  const { sortOrder, moveOther } = newCategorySortOrder(categories, {
    parentId: input.parentId,
    kind,
  });

  const category: NewCategoryRow = {
    parentId: input.parentId,
    nameEn: name.value,
    kind,
    defaultMemberId: input.defaultMemberId ?? null,
    isPreTaxDefault: input.isPreTaxDefault ?? false,
    isOther: false,
    sortOrder,
  };

  const other =
    input.parentId === null
      ? {
          nameEn: OTHER_NAME,
          kind,
          defaultMemberId: null, // 为空时继承一级（R5）
          isPreTaxDefault: false,
          isOther: true,
          sortOrder: 0,
        }
      : null;

  return { ok: true, value: { category, other, moveOther } };
}

// ---------- R19.3 修改 ----------

// 表单可能把整条都传回来，kind、parentId 和原来一样不算改
export type CategoryEditInput = {
  nameEn?: string;
  defaultMemberId?: string | null;
  isPreTaxDefault?: boolean;
  kind?: CategoryKind;
  parentId?: string | null;
};

export type CategoryEditPatch = {
  nameEn?: string; // 已规范化
  defaultMemberId?: string | null;
  isPreTaxDefault?: boolean;
};

// R19.3：能改名字、默认归属人、税前（收入的二级）；类型、所属一级不能改；
// Other 不能改名；系统分类都不能改
// categories：传了就检查改名后的重名（R19.2 的规则），不传只做 R19.3 的检查
export function checkCategoryEdit(
  category: AdminCategory,
  edit: CategoryEditInput,
  categories?: readonly AdminCategory[],
): Result<CategoryEditPatch> {
  if (isSystem(category)) return fail('系统分类不能改');
  if (edit.kind !== undefined && edit.kind !== category.kind) return fail('类型不能改');
  if (edit.parentId !== undefined && edit.parentId !== category.parentId) {
    return fail('不能改所属一级，二级不能挪到别的一级下');
  }

  const patch: CategoryEditPatch = {};

  if (edit.nameEn !== undefined) {
    const name = normalizeCategoryName(edit.nameEn);
    if (!name.ok) return name;
    if (category.isOther && name.value !== category.nameEn) return fail('Other 不能改名');
    if (categories) {
      const conflict = findNameConflict(name.value, category.parentId, categories, category.id);
      if (conflict) return fail(conflict);
    }
    patch.nameEn = name.value;
  }

  if (edit.defaultMemberId !== undefined) patch.defaultMemberId = edit.defaultMemberId;

  if (edit.isPreTaxDefault !== undefined) {
    if (edit.isPreTaxDefault && (category.parentId === null || category.kind !== 'income')) {
      return fail('只有收入的二级能勾税前');
    }
    patch.isPreTaxDefault = edit.isPreTaxDefault;
  }

  return { ok: true, value: patch };
}

// ---------- R19.4 归档 ----------

export type ArchiveFailReason = 'not_found' | 'system' | 'other' | 'already_archived' | 'has_rules';

export type ArchivePlan =
  | { ok: true; ids: string[] } // 要设 is_archived = true 的 id，一级在第一个
  | {
      ok: false;
      reason: ArchiveFailReason;
      message: string;
      ruleCount?: number; // has_rules 时
      ruleFilterTopId?: string; // has_rules 时规则页链接带的一级筛选（R18.1 只能按一级筛）
    };

// R19.4：系统分类、Other 不能单独归档；归档一级带上所有二级；
// 有规则指向它（一级包括它的二级）就不能归档
// ruleCounts：分类 id → 指向它的规则条数，没有的可以不放
export function planArchive(
  categoryId: string,
  categories: readonly AdminCategory[],
  ruleCounts: ReadonlyMap<string, number>,
): ArchivePlan {
  const target = categories.find((c) => c.id === categoryId);
  if (!target) return { ok: false, reason: 'not_found', message: '找不到这个分类' };
  if (isSystem(target)) return { ok: false, reason: 'system', message: '系统分类不能归档' };
  if (target.isOther) {
    return { ok: false, reason: 'other', message: 'Other 不能单独归档，归档一级时会一起归档' };
  }
  if (target.isArchived) {
    return { ok: false, reason: 'already_archived', message: '这个分类已经归档了' };
  }

  const ids =
    target.parentId === null
      ? [target.id, ...categories.filter((c) => c.parentId === target.id).map((c) => c.id)]
      : [target.id];

  const ruleCount = ids.reduce((sum, id) => sum + (ruleCounts.get(id) ?? 0), 0);
  if (ruleCount > 0) {
    return {
      ok: false,
      reason: 'has_rules',
      message: `有 ${ruleCount} 条规则指向这个分类，先去规则页改掉或删掉`,
      ruleCount,
      ruleFilterTopId: target.parentId ?? target.id,
    };
  }

  return { ok: true, ids };
}

// 要设 is_archived = false 的 id，一级在第一个
export type UnarchivePlan = { ok: true; ids: string[] } | Fail;

// R19.4：二级的一级还在归档中时不能单独取消；一级取消归档时所有二级都恢复，
// 包括一级归档前就单独归档过的（表里不记归档顺序，2026-10-26 补）
export function planUnarchive(
  categoryId: string,
  categories: readonly AdminCategory[],
): UnarchivePlan {
  const target = categories.find((c) => c.id === categoryId);
  if (!target) return fail('找不到这个分类');
  if (!target.isArchived) return fail('这个分类没有归档');

  if (target.parentId !== null) {
    const parent = categories.find((c) => c.id === target.parentId);
    if (parent?.isArchived) {
      return fail(`一级 ${parent.nameEn} 还在归档中，先取消归档一级`);
    }
    return { ok: true, ids: [target.id] };
  }

  return {
    ok: true,
    ids: [target.id, ...categories.filter((c) => c.parentId === target.id).map((c) => c.id)],
  };
}
