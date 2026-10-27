// 可折叠的分类下拉（2026-10-24）：一级是一组，点开看二级；系统分类一组放最后
// 改分类时可选范围按 R16.3（不能选内部转账、归档的）；筛选时全部能选，归档的也能（R19.4）
// 纯函数，不 import 数据库和 Next.js

type CategoryKind = 'expense' | 'income' | 'system';

// listCategoryTree 的结构，只取用到的字段
export type PickerTreeNode = {
  id: string;
  nameEn: string;
  kind: CategoryKind;
  systemKey: string | null;
  isArchived?: boolean; // 一级归档了，二级也是 true（listCategoryTree 已经标好）
  children: readonly { id: string; nameEn: string; isArchived?: boolean }[];
};

// archived 只在归档的时候有（true），显示时灰色、名字后面加"（已归档）"
export type PickerChild = { id: string; name: string; archived?: true };

export type PickerGroup = {
  id: string;
  name: string;
  kind: CategoryKind;
  systemKey: string | null;
  archived?: true;
  children: PickerChild[];
};

export type PickerSections = {
  groups: PickerGroup[]; // expense、income 一级，一级本身也能选
  system: PickerGroup[]; // 系统分类，没有二级
};

// includeArchived（F8 筛选，R19.4）：归档的一级排在所有一级后面，归档的二级排在组里最后
// 不带时归档的一级（连同二级）和归档的二级都去掉（R16.3）
export function pickerSections(
  tree: readonly PickerTreeNode[],
  opts: { includeTransfer: boolean; includeArchived?: boolean },
): PickerSections {
  const live: PickerGroup[] = [];
  const archived: PickerGroup[] = [];
  const system: PickerGroup[] = [];
  for (const t of tree) {
    if (t.isArchived && !opts.includeArchived) continue;
    const children: PickerChild[] = [];
    const archivedChildren: PickerChild[] = [];
    for (const c of t.children) {
      if (!c.isArchived) children.push({ id: c.id, name: c.nameEn });
      else if (opts.includeArchived)
        archivedChildren.push({ id: c.id, name: c.nameEn, archived: true });
    }
    const g: PickerGroup = {
      id: t.id,
      name: t.nameEn,
      kind: t.kind,
      systemKey: t.systemKey,
      ...(t.isArchived ? { archived: true as const } : {}),
      children: [...children, ...archivedChildren],
    };
    if (t.kind === 'system') {
      if (opts.includeTransfer || t.systemKey !== 'internal_transfer') system.push(g);
    } else if (t.isArchived) archived.push(g);
    else live.push(g);
  }
  return { groups: [...live, ...archived], system };
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
