import { describe, expect, it } from 'vitest';
import { pickerSections, searchPicker, type PickerTreeNode } from './category-picker';

// 可折叠的分类下拉：可选范围按 R16.3（改分类时不能选内部转账），筛选时全部能选

const tree: PickerTreeNode[] = [
  {
    id: 'groceries',
    nameEn: 'Groceries',
    kind: 'expense',
    systemKey: null,
    children: [
      { id: 'supermarket', nameEn: 'Supermarket' },
      { id: 'butcher', nameEn: 'Butcher' },
    ],
  },
  {
    id: 'income',
    nameEn: 'Income',
    kind: 'income',
    systemKey: null,
    children: [{ id: 'salary', nameEn: 'Salary' }],
  },
  {
    id: 'transfer',
    nameEn: 'Internal transfer',
    kind: 'system',
    systemKey: 'internal_transfer',
    children: [],
  },
  {
    id: 'uncat',
    nameEn: 'Uncategorised',
    kind: 'system',
    systemKey: 'uncategorized',
    children: [],
  },
  { id: 'fee', nameEn: 'Bank fees', kind: 'system', systemKey: 'bank_fee', children: [] },
];

describe('pickerSections', () => {
  it('R16.3: 改分类时，expense / income 一级各一组（带二级），系统分类一组放最后，没有内部转账', () => {
    const s = pickerSections(tree, { includeTransfer: false });
    expect(s.groups.map((g) => g.id)).toEqual(['groceries', 'income']);
    expect(s.groups[0]).toMatchObject({
      name: 'Groceries',
      kind: 'expense',
      children: [
        { id: 'supermarket', name: 'Supermarket' },
        { id: 'butcher', name: 'Butcher' },
      ],
    });
    expect(s.system.map((x) => x.id)).toEqual(['uncat', 'fee']);
  });

  it('筛选时内部转账也能选', () => {
    const s = pickerSections(tree, { includeTransfer: true });
    expect(s.system.map((x) => x.id)).toEqual(['transfer', 'uncat', 'fee']);
  });
});

describe('pickerSections 和归档（R19.4、R16.3）', () => {
  // listCategoryTree(ctx, { includeArchived: true }) 的结构：一级归档了，二级也标归档
  const withArchived: PickerTreeNode[] = [
    {
      id: 'old',
      nameEn: 'Old stuff',
      kind: 'expense',
      systemKey: null,
      isArchived: true,
      children: [{ id: 'old-other', nameEn: 'Other', isArchived: true }],
    },
    {
      id: 'ent',
      nameEn: 'Entertainment & eat-out',
      kind: 'expense',
      systemKey: null,
      isArchived: false,
      children: [
        { id: 'coffee', nameEn: 'Coffee & tea', isArchived: true },
        { id: 'restaurants', nameEn: 'Restaurants', isArchived: false },
        { id: 'ent-other', nameEn: 'Other', isArchived: false },
      ],
    },
    ...tree,
  ];

  it('R19.4: 筛选带上归档的：归档的一级排在所有一级后面，归档的二级排在组里最后，都标 archived', () => {
    const s = pickerSections(withArchived, { includeTransfer: true, includeArchived: true });
    expect(s.groups.map((g) => g.id)).toEqual(['ent', 'groceries', 'income', 'old']);
    expect(s.groups[0].children).toEqual([
      { id: 'restaurants', name: 'Restaurants' },
      { id: 'ent-other', name: 'Other' },
      { id: 'coffee', name: 'Coffee & tea', archived: true },
    ]);
    expect(s.groups[3]).toMatchObject({
      id: 'old',
      archived: true,
      children: [{ id: 'old-other', name: 'Other', archived: true }],
    });
    expect(s.groups[1].archived).toBeUndefined();
  });

  it('R16.3: 不带 includeArchived 时，归档的一级（连同二级）和归档的二级都去掉', () => {
    const s = pickerSections(withArchived, { includeTransfer: false });
    expect(s.groups.map((g) => g.id)).toEqual(['ent', 'groceries', 'income']);
    expect(s.groups[0].children.map((c) => c.id)).toEqual(['restaurants', 'ent-other']);
  });
});

describe('searchPicker', () => {
  const sections = pickerSections(tree, { includeTransfer: false });

  it('没有搜索词：原样返回，只展开当前选中的分类所在的组', () => {
    expect(searchPicker(sections, '', 'butcher')).toEqual({ ...sections, expanded: ['groceries'] });
    expect(searchPicker(sections, '  ', 'salary').expanded).toEqual(['income']);
    // 选的是一级本身也展开它
    expect(searchPicker(sections, '', 'groceries').expanded).toEqual(['groceries']);
    expect(searchPicker(sections, '', 'uncat').expanded).toEqual([]);
    expect(searchPicker(sections, '', null).expanded).toEqual([]);
  });

  it('搜二级名：只留下有命中的组，组里只留命中的二级，并展开', () => {
    const r = searchPicker(sections, 'super', null);
    expect(r.groups.map((g) => g.id)).toEqual(['groceries']);
    expect(r.groups[0].children.map((c) => c.id)).toEqual(['supermarket']);
    expect(r.expanded).toEqual(['groceries']);
    expect(r.system).toEqual([]);
  });

  it('搜一级名：这一组的二级全部保留', () => {
    const r = searchPicker(sections, 'GROC', null);
    expect(r.groups[0].children.map((c) => c.id)).toEqual(['supermarket', 'butcher']);
    expect(r.expanded).toEqual(['groceries']);
  });

  it('不区分大小写，也能搜到系统分类', () => {
    const r = searchPicker(sections, 'bank', null);
    expect(r.groups).toEqual([]);
    expect(r.system.map((x) => x.id)).toEqual(['fee']);
  });

  it('什么都没搜到时全空', () => {
    const r = searchPicker(sections, 'zzz', null);
    expect(r.groups).toEqual([]);
    expect(r.system).toEqual([]);
  });
});
