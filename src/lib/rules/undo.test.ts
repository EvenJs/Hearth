import { describe, expect, it } from 'vitest';
import { processFile } from '@/lib/import/process';
import { readFixture, type FixturePath } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import type { Account, CategorySource, MemberSource, TransferStatus } from './types';
import { planUndo, type UndoBatchTx, type UndoCounterpart } from './undo';

// 期望值来自 business-rules.md R12.1 和 fixtures/README.md "撤销导入用例"

const h = buildTestHousehold();
const INTERNAL = h.systemCategory('internal_transfer').id;
const UNCATEGORIZED = h.systemCategory('uncategorized');
const RESTAURANTS = h.category('Entertainment & eat-out / Restaurants').id;
const joint = h.account('ANZ Joint');
const male = h.account('ANZ Male');
const female = h.account('CBA Female');
const member = (name: string) => h.member(name).id;

const config = { accounts: h.accounts, categories: h.categories, cards: h.cards };

// ---------- fixture 管道：processFile 的结果当成数据库里的交易，id = "账户名#行号" ----------

type Tx = UndoCounterpart & UndoBatchTx;

function load(path: FixturePath, account: Account): Tx[] {
  const result = processFile(readFixture(path), account, h);
  if (!result.ok) throw new Error(result.message);
  return result.rows.map((r, i) => ({
    id: `${account.name}#${i + 1}`,
    accountId: r.accountId,
    rawDescription: r.rawDescription,
    cardLast4: r.cardLast4,
    transferStatus: r.transferStatus,
    transferPairId: null,
    primarySplit: {
      categoryId: r.categoryId,
      categorySource: r.categorySource,
      memberId: r.memberId,
      memberSource: r.memberSource,
    },
    wasPending: false,
    splits: [{ categorySource: r.categorySource, memberSource: r.memberSource, note: null }],
  }));
}

function find(txs: Tx[], id: string): Tx {
  const t = txs.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
}

// 把两笔配成一对，按需改状态和主拆分分类
function pair(
  txs: Tx[],
  aId: string,
  bId: string,
  status?: TransferStatus,
  category?: { categoryId: string; categorySource: CategorySource },
): void {
  for (const [id, other] of [
    [aId, bId],
    [bId, aId],
  ]) {
    const t = find(txs, id);
    t.transferPairId = other;
    if (status) t.transferStatus = status;
    if (category) {
      t.primarySplit = { ...t.primarySplit, ...category };
      t.splits = [{ ...t.splits[0], categorySource: category.categorySource }];
    }
  }
}

const reset = (id: string, memberId: string, memberSource: MemberSource, kase: string) => ({
  id,
  case: kase,
  action: 'reset',
  transferStatus: 'none',
  primarySplit: {
    categoryId: UNCATEGORIZED.id,
    categorySource: 'system',
    isPreTax: UNCATEGORIZED.isPreTaxDefault,
    memberId,
    memberSource,
  },
});

// joint → overlap → me 之后的家庭（overlap 不影响配对，省略）
function afterMe() {
  const jointTxs = load('anz/joint-2026-09.csv', joint);
  const meTxs = load('anz/me-2026-09.csv', male);
  const all = [...jointTxs, ...meTxs];
  pair(all, 'ANZ Joint#17', 'ANZ Male#3'); // R6.2，两边都是 auto
  pair(all, 'ANZ Joint#7', 'ANZ Male#1', 'suggested'); // R6.3
  return { all, jointTxs, meTxs };
}

describe('planUndo（R12.1）', () => {
  it('R12.1 U2: undo me → #7 suggested is reset; #17 re-runs R6.1 on ****0002 and stays auto; no prompt', () => {
    const { jointTxs, meTxs } = afterMe();
    expect(find(jointTxs, 'ANZ Joint#17').rawDescription).toContain('****0002');

    expect(planUndo({ batchTxs: meTxs, counterparts: jointTxs, ...config })).toEqual({
      counterparts: [
        reset('ANZ Joint#7', member('Home'), 'account', 'suggested'),
        { id: 'ANZ Joint#17', case: 'auto_still_detected', action: 'unpair' },
      ],
      prompt: { manualEditedCount: 0, confirmedPendingCount: 0, needsConfirm: false },
    });
  });

  it('R12.1 U3: undo cba after the two manual edits → prompt 2 manual; joint #11 (****0003) stays auto', () => {
    const { all } = afterMe();
    const cbaTxs = load('cba/female-2026-09.csv', female);
    const txs = [...all, ...cbaTxs];
    pair(txs, 'ANZ Joint#11', 'CBA Female#10', 'auto', {
      categoryId: INTERNAL,
      categorySource: 'system',
    });
    for (const [id, cat] of [
      ['CBA Female#3', h.category('Income / Contract income (B2B)').id],
      ['CBA Female#15', RESTAURANTS],
    ] as const) {
      const t = find(txs, id);
      t.primarySplit = { ...t.primarySplit, categoryId: cat, categorySource: 'manual' };
      t.splits = [{ ...t.splits[0], categorySource: 'manual' }];
    }

    expect(planUndo({ batchTxs: cbaTxs, counterparts: all, ...config })).toEqual({
      counterparts: [{ id: 'ANZ Joint#11', case: 'auto_still_detected', action: 'unpair' }],
      prompt: { manualEditedCount: 2, confirmedPendingCount: 0, needsConfirm: true },
    });
  });

  it('R12.1 U4: joint → cba, undo joint → CBA #10 (PayID) cannot be re-detected → reset, Female (account)', () => {
    const jointTxs = load('anz/joint-2026-09.csv', joint);
    const cbaTxs = load('cba/female-2026-09.csv', female);
    pair([...jointTxs, ...cbaTxs], 'ANZ Joint#11', 'CBA Female#10', 'auto', {
      categoryId: INTERNAL,
      categorySource: 'system',
    });

    expect(planUndo({ batchTxs: jointTxs, counterparts: cbaTxs, ...config })).toEqual({
      counterparts: [reset('CBA Female#10', member('Female'), 'account', 'auto_not_detected')],
      prompt: { manualEditedCount: 0, confirmedPendingCount: 0, needsConfirm: false },
    });
  });

  it('R12.1 U5: confirmed suggestion, undo me → #7 confirmed is reset; prompt 1 manual (PAYID PAYMENT)', () => {
    const { all, jointTxs, meTxs } = afterMe();
    pair(all, 'ANZ Joint#7', 'ANZ Male#1', 'confirmed', {
      categoryId: INTERNAL,
      categorySource: 'manual',
    });

    expect(planUndo({ batchTxs: meTxs, counterparts: jointTxs, ...config })).toEqual({
      counterparts: [
        reset('ANZ Joint#7', member('Home'), 'account', 'confirmed'),
        { id: 'ANZ Joint#17', case: 'auto_still_detected', action: 'unpair' },
      ],
      prompt: { manualEditedCount: 1, confirmedPendingCount: 0, needsConfirm: true },
    });
  });

  it('R12.1: counterpart with transfer_status none (R6.2 kept its manual category) → only unpair', () => {
    const jointTxs = load('anz/joint-2026-09.csv', joint);
    const cbaTxs = load('cba/female-2026-09.csv', female);
    pair([...jointTxs, ...cbaTxs], 'ANZ Joint#11', 'CBA Female#10');
    const c10 = find(cbaTxs, 'CBA Female#10');
    c10.primarySplit = { ...c10.primarySplit, categoryId: RESTAURANTS, categorySource: 'manual' };
    expect(c10.transferStatus).toBe('none');

    expect(planUndo({ batchTxs: jointTxs, counterparts: cbaTxs, ...config }).counterparts).toEqual([
      { id: 'CBA Female#10', case: 'none', action: 'unpair' },
    ]);
  });

  it('R12.1 + R5.1: reset keeps a manual member', () => {
    const { jointTxs, meTxs } = afterMe();
    const j7 = find(jointTxs, 'ANZ Joint#7');
    j7.primarySplit = { ...j7.primarySplit, memberId: member('Female'), memberSource: 'manual' };

    expect(
      planUndo({ batchTxs: meTxs, counterparts: jointTxs, ...config }).counterparts[0],
    ).toEqual(reset('ANZ Joint#7', member('Female'), 'manual', 'suggested'));
  });

  it('R12.1 U6: P1, P2 confirmed by the batch → prompt 2 confirmed pendings; their manual splits are not counted as edits', () => {
    const jointTxs = load('anz/joint-2026-09.csv', joint);
    // #8、#9 是被确认的 P1、P2，拆分是用户手动录入的
    for (const id of ['ANZ Joint#8', 'ANZ Joint#9']) {
      const t = find(jointTxs, id);
      t.wasPending = true;
      t.splits = [{ categorySource: 'manual', memberSource: 'manual', note: null }];
    }

    expect(planUndo({ batchTxs: jointTxs, counterparts: [], ...config }).prompt).toEqual({
      manualEditedCount: 0,
      confirmedPendingCount: 2,
      needsConfirm: true,
    });
  });

  it('R12.1: prompt counts manual member, several splits and notes as manual edits (once per transaction)', () => {
    const meTxs = load('anz/me-2026-09.csv', male);
    const [a, b, c, d] = meTxs;
    a.splits = [{ ...a.splits[0], memberSource: 'manual' }];
    b.splits = [b.splits[0], { categorySource: 'rule', memberSource: 'category', note: null }];
    c.splits = [{ ...c.splits[0], note: '给老婆' }];
    d.splits = [{ categorySource: 'manual', memberSource: 'manual', note: 'x' }];

    expect(planUndo({ batchTxs: meTxs, counterparts: [], ...config }).prompt).toEqual({
      manualEditedCount: 4,
      confirmedPendingCount: 0,
      needsConfirm: true,
    });
  });

  it('R12.1: empty note does not count as a manual edit', () => {
    const meTxs = load('anz/me-2026-09.csv', male);
    meTxs[0].splits = [{ ...meTxs[0].splits[0], note: '' }];
    expect(
      planUndo({ batchTxs: meTxs, counterparts: [], ...config }).prompt.manualEditedCount,
    ).toBe(0);
  });

  it('R12.1 + R8.3: a restored pending (P10) paired with CBA #10 → CBA #10 is handled too', () => {
    const jointTxs = load('anz/joint-2026-09.csv', joint);
    const cbaTxs = load('cba/female-2026-09.csv', female);
    pair([...jointTxs, ...cbaTxs], 'ANZ Joint#11', 'CBA Female#10', 'auto', {
      categoryId: INTERNAL,
      categorySource: 'system',
    });
    const p10 = find(jointTxs, 'ANZ Joint#11');
    p10.wasPending = true;
    p10.splits = [{ categorySource: 'system', memberSource: 'manual', note: '给老婆' }];

    expect(planUndo({ batchTxs: jointTxs, counterparts: cbaTxs, ...config })).toEqual({
      counterparts: [reset('CBA Female#10', member('Female'), 'account', 'auto_not_detected')],
      prompt: { manualEditedCount: 0, confirmedPendingCount: 1, needsConfirm: true },
    });
  });

  it('R12.1: missing counterpart → throws', () => {
    const { meTxs } = afterMe();
    expect(() => planUndo({ batchTxs: meTxs, counterparts: [], ...config })).toThrow();
  });
});
