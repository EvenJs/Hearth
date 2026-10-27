import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture } from '../../../tests/helpers/fixtures';
import { processFile } from '../import/process';
import { planMemberPropagation, shouldOfferRule, type PropagationTx } from './follow-up';

// 期望值来自 business-rules.md R16.9、R16.10 和 fixtures/README.md（joint #4、#5、#13 到 #15）

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');
const MALE = h.member('Male').id;
const FEMALE = h.member('Female').id;

// 只导入 joint 时的交易，id 用 "#行号"，只有主拆分
const result = processFile(readFixture('anz/joint-2026-09.csv'), joint, h);
if (!result.ok) throw new Error(result.message);
const rows: PropagationTx[] = result.rows.map((r, i) => ({
  id: `#${i + 1}`,
  merchant: r.merchant,
  transferStatus: r.transferStatus,
  splits: [
    {
      id: `split:#${i + 1}`,
      categoryId: r.categoryId,
      categorySource: r.categorySource,
      memberId: r.memberId,
      memberSource: r.memberSource,
      isPreTax: r.isPreTax,
    },
  ],
}));
const row = (n: number) => rows[n - 1];

describe('shouldOfferRule（R16.9）', () => {
  // 改了 #n 的主拆分，新分类是 expense
  const input = (n: number, over: Partial<Parameters<typeof shouldOfferRule>[0]> = {}) => ({
    transactionId: row(n).id,
    merchant: row(n).merchant,
    isPrimary: true,
    changed: true,
    newKind: 'expense' as const,
    ...over,
  });

  it('R16.9: #14 MELB ASIAN MARKET changed to another groceries category → dialog (#13 has the same merchant)', () => {
    expect(shouldOfferRule(input(14), rows)).toBe('dialog');
  });

  it('R16.9: #15 UNKNOWN SHOP PTY LTD MELBOURNE → only itself, toast with a "save as rule" button', () => {
    expect(shouldOfferRule(input(15), rows)).toBe('toast');
  });

  it('R16.9: changed to Uncategorised (or cash, bank fee) → nothing', () => {
    expect(shouldOfferRule(input(14, { newKind: 'system' }), rows)).toBe('none');
    expect(shouldOfferRule(input(15, { newKind: 'system' }), rows)).toBe('none');
  });

  it('R16.9: income category also offers', () => {
    expect(shouldOfferRule(input(14, { newKind: 'income' }), rows)).toBe('dialog');
  });

  it('R16.9: category did not change → nothing', () => {
    expect(shouldOfferRule(input(14, { changed: false }), rows)).toBe('none');
  });

  it('R16.9: not the primary split → nothing', () => {
    expect(shouldOfferRule(input(14, { isPrimary: false }), rows)).toBe('none');
  });

  it('R16.9: similar = merchant contains the suggested keyword (R13), case-insensitive, any category', () => {
    // COLES 0559 MELBOURNE → 关键词 COLES；另一家门店也算类似
    const coles = { id: 'tx:coles', merchant: 'coles 1234 richmond' };
    expect(shouldOfferRule(input(19), rows)).toBe('toast');
    expect(shouldOfferRule(input(19), [...rows, coles])).toBe('dialog');
  });

  it('R16.9: the transaction itself does not count as similar', () => {
    expect(shouldOfferRule(input(14), [row(14)])).toBe('toast');
  });
});

describe('planMemberPropagation（R16.10）', () => {
  it('R16.10: #4 GONG CHA changed to Female → #5 (Male, card) goes along, Female (manual)', () => {
    expect(planMemberPropagation(row(4), FEMALE, rows)).toEqual({
      keyword: 'GONG CHA & HO/SPENCER ST MELBOURNE',
      updates: [
        {
          transactionId: '#5',
          split: { ...row(5).splits[0], memberId: FEMALE, memberSource: 'manual' },
        },
      ],
    });
  });

  it('R16.10: #5 already Female (manual) → not returned', () => {
    const five = {
      ...row(5),
      splits: [{ ...row(5).splits[0], memberId: FEMALE, memberSource: 'manual' as const }],
    };
    expect(planMemberPropagation(row(4), FEMALE, [row(4), five]).updates).toEqual([]);
  });

  it('R16.10: manual member set before (another person) is not touched', () => {
    const five = {
      ...row(5),
      splits: [{ ...row(5).splits[0], memberId: MALE, memberSource: 'manual' as const }],
    };
    expect(planMemberPropagation(row(4), FEMALE, [row(4), five]).updates).toEqual([]);
  });

  it('R16.10: member already the new person (not manual) → not returned', () => {
    const five = {
      ...row(5),
      splits: [{ ...row(5).splits[0], memberId: FEMALE, memberSource: 'card' as const }],
    };
    expect(planMemberPropagation(row(4), FEMALE, [row(4), five]).updates).toEqual([]);
  });

  it('R16.10: transfer rows (auto, confirmed) are not returned; suggested are', () => {
    const t = (id: string, transferStatus: PropagationTx['transferStatus']) => ({
      ...row(5),
      id,
      transferStatus,
    });
    const plan = planMemberPropagation(row(4), FEMALE, [
      row(4),
      t('tx:auto', 'auto'),
      t('tx:confirmed', 'confirmed'),
      t('tx:suggested', 'suggested'),
    ]);
    expect(plan.updates.map((u) => u.transactionId)).toEqual(['tx:suggested']);
  });

  it('R16.10: transactions with more than one split are not returned', () => {
    const five = row(5);
    const split = { ...five, splits: [five.splits[0], { ...five.splits[0], id: 'split:2' }] };
    expect(planMemberPropagation(row(4), FEMALE, [row(4), split]).updates).toEqual([]);
  });

  it('R16.10: merchant contains the suggested keyword (R13), case-insensitive; the changed one itself excluded', () => {
    // COLES 0559 MELBOURNE → COLES
    const other = { ...row(19), id: 'tx:coles', merchant: 'Coles 1234 Richmond' };
    const plan = planMemberPropagation(row(19), FEMALE, [row(19), other, row(14)]);
    expect(plan.keyword).toBe('COLES');
    expect(plan.updates.map((u) => u.transactionId)).toEqual(['tx:coles']);
  });

  it('R16.10: no other transaction for the merchant → empty (no dialog)', () => {
    expect(planMemberPropagation(row(15), FEMALE, rows).updates).toEqual([]);
  });
});
