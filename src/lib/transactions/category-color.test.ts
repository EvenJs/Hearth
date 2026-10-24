import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS, categoryColor } from './category-color';

// 分类 tag 的颜色（design/README 第 3 节，2026-10-24）
// 每个一级一个色系；二级用所属一级的色系；未分类琥珀色、系统分类灰色，不和一级的颜色重复

const top = (id: string, nameEn: string, kind: 'expense' | 'income' = 'expense') => ({
  topId: id,
  topName: nameEn,
  kind,
  systemKey: null,
});

describe('categoryColor', () => {
  it('seed 的 6 个支出一级各有固定颜色，互不相同', () => {
    const names = [
      'Home & utilities',
      'Insurance & financial',
      'Groceries',
      'Personal & medical',
      'Entertainment & eat-out',
      'Transport & auto',
    ];
    const colors = names.map((n) => categoryColor(top(`id-${n}`, n)));
    expect(new Set(colors).size).toBe(6);
    // 固定的，不随 id 变
    expect(categoryColor(top('another-id', 'Groceries'))).toBe(colors[2]);
  });

  it('收入是绿色', () => {
    expect(categoryColor(top('x', 'Income', 'income'))).toBe('green');
  });

  it('未分类琥珀色，其他系统分类灰色', () => {
    expect(
      categoryColor({
        topId: 'u',
        topName: 'Uncategorised',
        kind: 'system',
        systemKey: 'uncategorized',
      }),
    ).toBe('uncategorized');
    for (const key of ['internal_transfer', 'cash_withdrawal', 'bank_fee'] as const) {
      expect(categoryColor({ topId: key, topName: key, kind: 'system', systemKey: key })).toBe(
        'system',
      );
    }
  });

  it('一级的颜色不用琥珀色（未分类）和蓝色（建议转账）', () => {
    expect(CATEGORY_COLORS).not.toContain('amber');
    expect(CATEGORY_COLORS).not.toContain('blue');
  });

  it('自己新建的一级：按 id 固定挑一个，同一个 id 每次一样', () => {
    const a = categoryColor(top('5a1c0e7e-0000-4000-8000-000000000001', 'Kids'));
    expect(CATEGORY_COLORS).toContain(a);
    expect(categoryColor(top('5a1c0e7e-0000-4000-8000-000000000001', 'Kids renamed'))).toBe(a);
  });
});
