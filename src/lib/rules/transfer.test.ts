import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture, type FixturePath } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import { classify } from './classify';
import { extractAndMask } from './extract';
import { cleanMerchant } from './merchant';
import { detectTransfer, findPair, suggestTransfers, type TransferTx } from './transfer';
import type { Account } from './types';

// 期望值来自 business-rules.md R6.1、R6.2、R6.3 和 fixtures/README.md（joint、me、cba female 三个文件）

const h = buildTestHousehold();
const INTERNAL = h.systemCategory('internal_transfer').id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;

const joint = h.account('ANZ Joint');
const male = h.account('ANZ Male');
const female = h.account('CBA Female');
const saver = h.account('CBA Female Saver');

function acct(id: string, numberSuffix: string): Account {
  return {
    id,
    name: id,
    bank: 'anz',
    type: 'everyday',
    defaultMemberId: 'member:Home',
    numberSuffix,
  };
}

describe('detectTransfer（R6.1）', () => {
  const current = acct('acc:current', '1234');

  it.each([
    ['012345400006691', '6691', 'auto'],
    ['400006691', '6691', 'auto'],
    ['400006691', '006691', 'auto'],
    ['400006747', '6691', 'none'],
    ['5678', '5678', 'auto'],
    ['5678', '115678', 'auto'],
    ['5678', '0567', 'none'],
  ] as const)('R6.1: counterpart %s vs household suffix %s → %s', (extracted, suffix, status) => {
    const other = acct('acc:other', suffix);
    expect(detectTransfer({ transferAccount: extracted }, current, [current, other])).toEqual(
      status === 'auto'
        ? { transferStatus: 'auto', transferAccountId: other.id }
        : { transferStatus: 'none', transferAccountId: null },
    );
  });

  it('R6.1: own account suffix is not a transfer', () => {
    expect(detectTransfer({ transferAccount: '012345400000001' }, joint, h.accounts)).toEqual({
      transferStatus: 'none',
      transferAccountId: null,
    });
  });

  it('R6.1: no extracted account (PayID) → none', () => {
    expect(detectTransfer({ transferAccount: null }, female, h.accounts)).toEqual({
      transferStatus: 'none',
      transferAccountId: null,
    });
  });

  it('R6.1: accounts without a suffix (cash) are skipped', () => {
    const cash = { ...acct('acc:cash', '0000'), numberSuffix: null };
    expect(detectTransfer({ transferAccount: '400006691' }, current, [current, cash])).toEqual({
      transferStatus: 'none',
      transferAccountId: null,
    });
  });

  it('R6.1: fixtures: joint #11 → CBA Female, #17 → ANZ Male, #18 external; CBA #4 → Saver; me 03/09 → Joint', () => {
    expect(
      detectTransfer({ transferAccount: '012345400000003' }, joint, h.accounts).transferAccountId,
    ).toBe(female.id);
    expect(
      detectTransfer({ transferAccount: '400000002' }, joint, h.accounts).transferAccountId,
    ).toBe(male.id);
    expect(detectTransfer({ transferAccount: '499999999' }, joint, h.accounts).transferStatus).toBe(
      'none',
    );
    expect(detectTransfer({ transferAccount: '7777' }, female, h.accounts).transferAccountId).toBe(
      saver.id,
    );
    expect(
      detectTransfer({ transferAccount: '012345400000001' }, male, h.accounts).transferAccountId,
    ).toBe(joint.id);
  });
});

// ---------- fixture 管道：解析 → R2 → R3 → R6.1 → R7，得到入库前的交易 ----------

function load(path: FixturePath, account: Account): TransferTx[] {
  const text = readFixture(path);
  const rows = account.bank === 'cba' ? parseCbaCsv(text) : parseAnzCsv(text);
  return rows.map((r, i) => {
    const { description, transferAccount } = extractAndMask(r.description);
    const t = detectTransfer({ transferAccount }, account, h.accounts);
    const c = classify(
      { merchant: cleanMerchant(description), isInternalTransfer: t.transferStatus === 'auto' },
      h.rules,
      h.categories,
    );
    return {
      id: `${account.name}#${i + 1}`,
      accountId: account.id,
      date: r.date,
      amountCents: r.amountCents,
      transferStatus: t.transferStatus,
      transferAccountId: t.transferAccountId,
      transferPairId: null,
      categoryId: c.categoryId,
      categorySource: c.categorySource,
    };
  });
}

const byId = (txs: TransferTx[], id: string) => {
  const t = txs.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

describe('findPair（R6.2）', () => {
  const jointTxs = load('anz/joint-2026-09.csv', joint);
  const femaleTxs = load('cba/female-2026-09.csv', female);
  const meTxs = load('anz/me-2026-09.csv', male);

  it('R6.2: joint #11 (auto) pairs with CBA #10 (Uncategorised), which becomes auto + internal transfer', () => {
    const j11 = byId(jointTxs, 'ANZ Joint#11');
    const c10 = byId(femaleTxs, 'CBA Female#10');
    expect(j11.transferStatus).toBe('auto');
    expect(c10.categoryId).toBe(UNCATEGORIZED);
    expect(c10.transferStatus).toBe('none');

    expect(findPair(j11, femaleTxs, INTERNAL)).toEqual({
      counterpartId: 'CBA Female#10',
      counterpart: { transferStatus: 'auto', categoryId: INTERNAL, categorySource: 'system' },
      manualCategoryKept: false,
    });
  });

  it('R6.2: counterpart with a manual category is paired but its category is not changed', () => {
    const j11 = byId(jointTxs, 'ANZ Joint#11');
    const restaurants = h.category('Entertainment & eat-out / Restaurants').id;
    const candidates = femaleTxs.map((t) =>
      t.id === 'CBA Female#10'
        ? { ...t, categoryId: restaurants, categorySource: 'manual' as const }
        : t,
    );
    expect(findPair(j11, candidates, INTERNAL)).toEqual({
      counterpartId: 'CBA Female#10',
      counterpart: { transferStatus: 'none', categoryId: restaurants, categorySource: 'manual' },
      manualCategoryKept: true,
    });
  });

  it('R6.2: joint #17 pairs with me 03/09; counterpart already auto stays as is', () => {
    const j17 = byId(jointTxs, 'ANZ Joint#17');
    const me0309 = byId(meTxs, 'ANZ Male#3');
    expect(me0309).toMatchObject({
      date: '2026-09-03',
      amountCents: -200000,
      transferStatus: 'auto',
    });

    expect(findPair(j17, meTxs, INTERNAL)).toEqual({
      counterpartId: 'ANZ Male#3',
      counterpart: { transferStatus: 'auto', categoryId: INTERNAL, categorySource: 'system' },
      manualCategoryKept: false,
    });
    // 反过来找也是同一对
    expect(findPair(me0309, jointTxs, INTERNAL)?.counterpartId).toBe('ANZ Joint#17');
  });

  it('R6.2: counterpart account not imported yet (CBA #4 → Saver) → no pair', () => {
    expect(findPair(byId(femaleTxs, 'CBA Female#4'), [], INTERNAL)).toBeNull();
  });

  const j11 = () => byId(jointTxs, 'ANZ Joint#11');
  const c10 = () => byId(femaleTxs, 'CBA Female#10');

  it('R6.2: amount must be exactly opposite', () => {
    expect(findPair(j11(), [{ ...c10(), amountCents: 50001 }], INTERNAL)).toBeNull();
    expect(findPair(j11(), [{ ...c10(), amountCents: -50000 }], INTERNAL)).toBeNull();
  });

  it('R6.2: date difference ≤ 2 days, both directions, across month ends', () => {
    expect(findPair(j11(), [{ ...c10(), date: '2026-09-17' }], INTERNAL)).not.toBeNull();
    expect(findPair(j11(), [{ ...c10(), date: '2026-09-13' }], INTERNAL)).not.toBeNull();
    expect(findPair(j11(), [{ ...c10(), date: '2026-09-18' }], INTERNAL)).toBeNull();
    expect(findPair(j11(), [{ ...c10(), date: '2026-09-12' }], INTERNAL)).toBeNull();
    const endOfMonth = { ...j11(), date: '2026-09-30' };
    expect(findPair(endOfMonth, [{ ...c10(), date: '2026-10-02' }], INTERNAL)).not.toBeNull();
    expect(findPair(endOfMonth, [{ ...c10(), date: '2026-10-03' }], INTERNAL)).toBeNull();
  });

  it('R6.2: counterpart already paired is skipped', () => {
    expect(findPair(j11(), [{ ...c10(), transferPairId: 'someone' }], INTERNAL)).toBeNull();
  });

  it('R6.2: only looks in the R6.1 counterpart account', () => {
    expect(findPair(j11(), [{ ...c10(), accountId: male.id }], INTERNAL)).toBeNull();
  });

  it('R6.2: more than one candidate → no pair', () => {
    expect(
      findPair(j11(), [c10(), { ...c10(), id: 'CBA Female#10b', date: '2026-09-14' }], INTERNAL),
    ).toBeNull();
  });

  it('R6.2: tx that is not auto or already paired → no pair', () => {
    expect(findPair({ ...j11(), transferStatus: 'none' }, femaleTxs, INTERNAL)).toBeNull();
    expect(findPair({ ...j11(), transferPairId: 'x' }, femaleTxs, INTERNAL)).toBeNull();
  });
});

describe('suggestTransfers（R6.3）', () => {
  // 三个文件都导入、R6.2 配对之后：joint #11 ↔ CBA #10 已经是转账，不再参与
  function household(): TransferTx[] {
    const txs = [
      ...load('anz/joint-2026-09.csv', joint),
      ...load('anz/me-2026-09.csv', male),
      ...load('cba/female-2026-09.csv', female),
    ];
    return txs.map((t) => {
      if (t.id === 'ANZ Joint#11') return { ...t, transferPairId: 'CBA Female#10' };
      if (t.id === 'CBA Female#10')
        return {
          ...t,
          transferStatus: 'auto' as const,
          categoryId: INTERNAL,
          categorySource: 'system' as const,
          transferPairId: 'ANZ Joint#11',
        };
      if (t.id === 'ANZ Joint#17') return { ...t, transferPairId: 'ANZ Male#3' };
      if (t.id === 'ANZ Male#3') return { ...t, transferPairId: 'ANZ Joint#17' };
      return t;
    });
  }

  it('R6.3: joint #7 (+80.00 22/09) and me PAYID PAYMENT (-80.00 21/09) are the only suggestion', () => {
    expect(suggestTransfers(household(), UNCATEGORIZED)).toEqual([
      { aId: 'ANZ Joint#7', bId: 'ANZ Male#1' },
    ]);
  });

  it('R6.3: more than one candidate → no suggestion', () => {
    const txs = household();
    const extra: TransferTx = {
      ...byId(txs, 'ANZ Male#1'),
      id: 'CBA Female#extra',
      accountId: female.id,
    };
    expect(suggestTransfers([...txs, extra], UNCATEGORIZED)).toEqual([]);
  });

  it('R6.3: candidate must also be uncategorised', () => {
    const txs = household().map((t) =>
      t.id === 'ANZ Male#1'
        ? {
            ...t,
            categoryId: h.category('Groceries / Supermarket').id,
            categorySource: 'rule' as const,
          }
        : t,
    );
    expect(suggestTransfers(txs, UNCATEGORIZED)).toEqual([]);
  });

  it('R6.3: same account does not count', () => {
    const txs = household().map((t) => (t.id === 'ANZ Male#1' ? { ...t, accountId: joint.id } : t));
    expect(suggestTransfers(txs, UNCATEGORIZED)).toEqual([]);
  });

  it('R6.3: already suggested / paired transactions are skipped', () => {
    const txs = household().map((t) =>
      t.id === 'ANZ Joint#7'
        ? { ...t, transferStatus: 'suggested' as const, transferPairId: 'x' }
        : t,
    );
    expect(suggestTransfers(txs, UNCATEGORIZED)).toEqual([]);
  });

  it('R6.3: date difference > 2 days → no suggestion', () => {
    const txs = household().map((t) => (t.id === 'ANZ Male#1' ? { ...t, date: '2026-09-19' } : t));
    expect(suggestTransfers(txs, UNCATEGORIZED)).toEqual([]);
  });
});

describe('suggestTransfers 只从本次新插入的交易出发（R6.3）', () => {
  // joint → overlap → me 导入完，R6.2 已经把 #17 和 me 03/09 配上
  function afterMe(): TransferTx[] {
    return [...load('anz/joint-2026-09.csv', joint), ...load('anz/me-2026-09.csv', male)].map(
      (t) => {
        if (t.id === 'ANZ Joint#17') return { ...t, transferPairId: 'ANZ Male#3' };
        if (t.id === 'ANZ Male#3') return { ...t, transferPairId: 'ANZ Joint#17' };
        return t;
      },
    );
  }
  const idsOf = (txs: TransferTx[], accountId: string) =>
    new Set(txs.filter((t) => t.accountId === accountId).map((t) => t.id));

  it('R6.3: importing me (new) suggests joint #7 (old) ↔ PAYID PAYMENT (new)', () => {
    const txs = afterMe();
    expect(suggestTransfers(txs, UNCATEGORIZED, idsOf(txs, male.id))).toEqual([
      { aId: 'ANZ Joint#7', bId: 'ANZ Male#1' },
    ]);
  });

  it('R6.3: works the same when the new side comes first in the input', () => {
    const txs = afterMe().reverse();
    expect(suggestTransfers(txs, UNCATEGORIZED, new Set(['ANZ Joint#7']))).toEqual([
      { aId: 'ANZ Male#1', bId: 'ANZ Joint#7' },
    ]);
  });

  it('R6.3: rejected pair (both old) is not suggested again when cba is imported', () => {
    // 拒绝后两边回到 none、未分类、没配对，和导入时一样
    const before = afterMe();
    const cba = load('cba/female-2026-09.csv', female).map((t) => {
      if (t.id === 'CBA Female#10')
        return {
          ...t,
          transferStatus: 'auto' as const,
          categoryId: INTERNAL,
          categorySource: 'system' as const,
          transferPairId: 'ANZ Joint#11',
        };
      return t;
    });
    const txs = [
      ...before.map((t) =>
        t.id === 'ANZ Joint#11' ? { ...t, transferPairId: 'CBA Female#10' } : t,
      ),
      ...cba,
    ];
    expect(byId(txs, 'ANZ Joint#7')).toMatchObject({
      transferStatus: 'none',
      transferPairId: null,
    });
    expect(suggestTransfers(txs, UNCATEGORIZED, idsOf(txs, female.id))).toEqual([]);
  });

  it('R6.3: no new transaction at all → nothing suggested', () => {
    expect(suggestTransfers(afterMe(), UNCATEGORIZED, new Set())).toEqual([]);
  });

  it('R6.3: "only each other" is checked across the whole household, including old transactions', () => {
    // 旧交易 C 也是 -80.00、日期接近 → #7 有 PAYID PAYMENT 和 C 两个候选，不建议
    const txs = afterMe();
    const c: TransferTx = {
      ...byId(txs, 'ANZ Male#1'),
      id: 'CBA Female#old',
      accountId: female.id,
      date: '2026-09-22',
    };
    expect(suggestTransfers([...txs, c], UNCATEGORIZED, new Set(['ANZ Male#1']))).toEqual([]);
  });

  it('R6.3: old candidates still count as candidates for a new transaction', () => {
    // 新的 PAYID PAYMENT 只有旧的 #7 一个候选（#7 也只有它）→ 建议
    const txs = afterMe();
    expect(suggestTransfers(txs, UNCATEGORIZED, new Set(['ANZ Male#1']))).toEqual([
      { aId: 'ANZ Joint#7', bId: 'ANZ Male#1' },
    ]);
  });
});
