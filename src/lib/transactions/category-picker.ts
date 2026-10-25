// 可折叠的分类下拉（2026-10-24）：一级是一组，点开看二级；系统分类一组放最后
// 改分类时可选范围按 R16.3（不能选内部转账，归档的已经由 listCategoryTree 去掉）；筛选时全部能选
// 纯函数，不 import 数据库和 Next.js

type CategoryKind = 'expense' | 'income' | 'system';

// listCategoryTree 的结构，只取用到的字段
export type PickerTreeNode = {
  id: string;
  nameEn: string;
  kind: CategoryKind;
  systemKey: string | null;
  children: readonly { id: string; nameEn: string }[];
};

export type PickerGroup = {
  id: string;
  name: string;
  kind: CategoryKind;
  systemKey: string | null;
  children: { id: string; name: string }[];
};

export type PickerSections = {
  groups: PickerGroup[]; // expense、income 一级，一级本身也能选
  system: PickerGroup[]; // 系统分类，没有二级
};

export function pickerSections(
  tree: readonly PickerTreeNode[],
  opts: { includeTransfer: boolean },
): PickerSections {
  const groups: PickerGroup[] = [];
  const system: PickerGroup[] = [];
  for (const t of tree) {
    const g: PickerGroup = {
      id: t.id,
      name: t.nameEn,
      kind: t.kind,
      systemKey: t.systemKey,
      children: t.children.map((c) => ({ id: c.id, name: c.nameEn })),
    };
    if (t.kind !== 'system') groups.push(g);
    else if (opts.includeTransfer || t.systemKey !== 'internal_transfer') system.push(g);
  }
  return { groups, system };
}

export type PickerView = PickerSections & { expanded: string[] };

// 没有搜索词：全部列出，只展开当前选中的分类所在的组
// 有搜索词（不区分大小写）：一级名命中 → 整组保留；只有二级命中 → 组里只留命中的二级；命中的组都展开
export function searchPicker(
  sections: PickerSections,
  query: string,
  selectedId: string | null,
): PickerView {
  const q = query.trim().toLowerCase();
  if (q === '') {
    const g = sections.groups.find(
      (x) => x.id === selectedId || x.children.some((c) => c.id === selectedId),
    );
    return { ...sections, expanded: g ? [g.id] : [] };
  }
  const hit = (name: string) => name.toLowerCase().includes(q);
  const groups: PickerGroup[] = [];
  for (const g of sections.groups) {
    if (hit(g.name)) groups.push(g);
    else {
      const children = g.children.filter((c) => hit(c.name));
      if (children.length > 0) groups.push({ ...g, children });
    }
  }
  return {
    groups,
    system: sections.system.filter((s) => hit(s.name)),
    expanded: groups.map((g) => g.id),
  };
}
