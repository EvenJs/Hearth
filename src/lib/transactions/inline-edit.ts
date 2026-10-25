// F8 行内修改（M4-8）：分类下拉的选项（R16.3）、转账行只读（R16.2）
// 什么时候弹"存成规则"（R16.9）在 src/lib/rules/follow-up.ts
// 纯函数，不 import 数据库和 Next.js
import type { TransferStatus } from '@/lib/rules/types';

type CategoryKind = 'expense' | 'income' | 'system';

// listCategoryTree 的结构（已经去掉了归档的），只取这里用到的字段
export type CategoryTreeNode = {
  id: string;
  nameEn: string;
  kind: CategoryKind;
  systemKey: string | null;
  children: readonly { id: string; nameEn: string }[];
};

export type CategoryOption = { id: string; label: string; kind: CategoryKind };
export type CategoryOptionGroup = { label: string; options: CategoryOption[] };

// R16.3：每个 expense、income 一级是一组，一级本身排在它的二级前面，也能选
// 系统分类（未分类、现金支出、银行费用）放最后一组；内部转账不能选
export function categoryOptionGroups(tree: readonly CategoryTreeNode[]): CategoryOptionGroup[] {
  const groups: CategoryOptionGroup[] = [];
  const system: CategoryOption[] = [];
  for (const top of tree) {
    if (top.kind === 'system') {
      if (top.systemKey === 'internal_transfer') continue;
      system.push({ id: top.id, label: top.nameEn, kind: 'system' });
      continue;
    }
    groups.push({
      label: top.nameEn,
      options: [
        { id: top.id, label: top.nameEn, kind: top.kind },
        ...top.children.map((c) => ({
          id: c.id,
          label: `${top.nameEn} / ${c.nameEn}`,
          kind: top.kind,
        })),
      ],
    });
  }
  if (system.length > 0) groups.push({ label: '系统', options: system });
  return groups;
}

// R16.2：auto、confirmed 转账的分类只读，归属人还能改
export function isCategoryLocked(transferStatus: TransferStatus): boolean {
  return transferStatus === 'auto' || transferStatus === 'confirmed';
}
