import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture, type FixturePath } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { parseCbaCsv } from '../import/cba';
import { classify } from './classify';
import { extractAndMask } from './extract';
import { cleanMerchant } from './merchant';
import { processFile } from '../import/process';
import {
  detectTransfer,
  findPair,
  planTransferRedetect,
  planTransfers,
  resolveSuggestion,
  storedTransferAccountId,
  suggestTransfers,
  type HouseholdTransferTx,
  type RedetectTx,
  type SuggestionTx,
  type TransferTx,
} from './transfer';
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
      {
        merchant: cleanMerchant(description),
        isInternalTransfer: t.transferStatus === 'auto',
      },
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
      splitCount: 1,
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
      counterpart: {
        transferStatus: 'auto',
        categoryId: INTERNAL,
        categorySource: 'system',
      },
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
      counterpart: {
        transferStatus: 'none',
        categoryId: restaurants,
        categorySource: 'manual',
      },
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
      counterpart: {
        transferStatus: 'auto',
        categoryId: INTERNAL,
        categorySource: 'system',
      },
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

  it('R6.2: counterpart with several splits (R15) → pair only, nothing changed, F8 hint', () => {
    expect(findPair(j11(), [{ ...c10(), splitCount: 2 }], INTERNAL)).toEqual({
      counterpartId: 'CBA Female#10',
      counterpart: {
        transferStatus: 'none',
        categoryId: UNCATEGORIZED,
        categorySource: 'system',
      },
      manualCategoryKept: true,
    });
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

describe('storedTransferAccountId（R6.2 用，从脱敏后的描述重跑 R6.1）', () => {
  it('R6.2: ****0003 on joint → CBA Female, ****0002 → ANZ Male', () => {
    expect(
      storedTransferAccountId(
        'ANZ M-BANKING FUNDS TFER TRANSFER 100000  TO  ****0003',
        joint,
        h.accounts,
      ),
    ).toBe(female.id);
    expect(
      storedTransferAccountId(
        'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0002',
        joint,
        h.accounts,
      ),
    ).toBe(male.id);
  });

  it('R6.2: CBA xx7777 → Saver; PayID and external accounts → null', () => {
    expect(
      storedTransferAccountId('Transfer from xx7777 CommBank app Home', female, h.accounts),
    ).toBe(saver.id);
    expect(
      storedTransferAccountId(
        'Fast Transfer From TEST HOLDER to PayID Phone joint',
        female,
        h.accounts,
      ),
    ).toBeNull();
    expect(
      storedTransferAccountId(
        'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****9999',
        joint,
        h.accounts,
      ),
    ).toBeNull();
  });
});

describe('planTransfers（R6.2 整个家庭配对，然后 R6.3 建议）', () => {
  // 照 processFile 的结果当成已入库的交易，id 用 "账户名#行号"
  function file(path: FixturePath, account: Account): HouseholdTransferTx[] {
    const result = processFile(readFixture(path), account, h);
    if (!result.ok) throw new Error(result.message);
    return result.rows.map((r, i) => ({
      id: `${account.name}#${i + 1}`,
      accountId: r.accountId,
      date: r.date,
      amountCents: r.amountCents,
      transferStatus: r.transferStatus,
      transferAccountId: r.transferAccountId,
      transferPairId: null,
      categoryId: r.categoryId,
      categorySource: r.categorySource,
      splitCount: 1,
      cardLast4: r.cardLast4,
      memberId: r.memberId,
      memberSource: r.memberSource,
    }));
  }
  const ids = (txs: HouseholdTransferTx[]) => new Set(txs.map((t) => t.id));

  it('R6.2/R6.3: joint then me → #17 pairs with me 03/09, #7 and PAYID PAYMENT suggested', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint);
    const me = file('anz/me-2026-09.csv', male);
    expect(planTransfers([...joint9, ...me], ids(me), h)).toEqual({
      pairs: [
        {
          aId: 'ANZ Joint#17',
          bId: 'ANZ Male#3',
          counterpartUpdate: null,
          manualCategoryKept: false,
        },
      ],
      suggestions: [{ aId: 'ANZ Joint#7', bId: 'ANZ Male#1' }],
    });
  });

  it('R6.2: joint then cba → old joint #11 pairs with CBA #10, which becomes auto + Internal transfer', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint);
    const cba = file('cba/female-2026-09.csv', female);
    expect(planTransfers([...joint9, ...cba], ids(cba), h)).toEqual({
      pairs: [
        {
          aId: 'ANZ Joint#11',
          bId: 'CBA Female#10',
          counterpartUpdate: {
            transferStatus: 'auto',
            categoryId: INTERNAL,
            categorySource: 'system',
            isPreTax: false,
            memberId: h.member('Female').id,
            memberSource: 'account',
          },
          manualCategoryKept: false,
        },
      ],
      suggestions: [],
    });
  });

  it('R6.3: suggestions only start from new transactions (rejected old pair is not suggested again)', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint);
    const me = file('anz/me-2026-09.csv', male);
    const cba = file('cba/female-2026-09.csv', female);
    expect(planTransfers([...joint9, ...me, ...cba], ids(cba), h).suggestions).toEqual([]);
  });

  it('R5.1: a manual member on the counterpart is kept when it becomes a transfer', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint);
    const cba = file('cba/female-2026-09.csv', female).map((t) =>
      t.id === 'CBA Female#10'
        ? {
            ...t,
            memberId: h.member('Home').id,
            memberSource: 'manual' as const,
          }
        : t,
    );
    const [pair] = planTransfers([...joint9, ...cba], ids(cba), h).pairs;
    expect(pair.counterpartUpdate).toMatchObject({
      memberId: h.member('Home').id,
      memberSource: 'manual',
    });
  });

  it('R6.2: counterpart with several splits is paired but not changed', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint);
    const cba = file('cba/female-2026-09.csv', female).map((t) =>
      t.id === 'CBA Female#10' ? { ...t, splitCount: 2 } : t,
    );
    expect(planTransfers([...joint9, ...cba], ids(cba), h).pairs).toEqual([
      {
        aId: 'ANZ Joint#11',
        bId: 'CBA Female#10',
        counterpartUpdate: null,
        manualCategoryKept: true,
      },
    ]);
  });

  it('R6.2: a pair found earlier is not paired again from the other side; already paired are skipped', () => {
    const joint9 = file('anz/joint-2026-09.csv', joint).map((t) =>
      t.id === 'ANZ Joint#17' ? { ...t, transferPairId: 'somewhere' } : t,
    );
    const me = file('anz/me-2026-09.csv', male);
    expect(planTransfers([...joint9, ...me], ids(me), h).pairs).toEqual([]);
  });
});

describe('resolveSuggestion（R6.3 确认和拒绝）', () => {
  // fixtures/README.md "R6.3 确认和拒绝"：me 导入完成后
  // Joint #7 PAYID DEPOSIT +80.00，Uncategorised，Home（account）
  // ANZ Male PAYID PAYMENT -80.00，Uncategorised，Male（account）
  const ctx = {
    categories: h.categories,
    cards: h.cards,
    accounts: h.accounts,
  };
  const jointSeven = (): SuggestionTx => ({
    id: 'tx:joint7',
    accountId: joint.id,
    cardLast4: null,
    transferStatus: 'suggested',
    transferPairId: 'tx:payid',
    splits: [
      {
        id: 'split:joint7',
        categoryId: UNCATEGORIZED,
        categorySource: 'system',
        memberId: h.member('Home').id,
        memberSource: 'account',
        isPreTax: false,
      },
    ],
  });
  const payid = (): SuggestionTx => ({
    id: 'tx:payid',
    accountId: male.id,
    cardLast4: null,
    transferStatus: 'suggested',
    transferPairId: 'tx:joint7',
    splits: [
      {
        id: 'split:payid',
        categoryId: UNCATEGORIZED,
        categorySource: 'system',
        memberId: h.member('Male').id,
        memberSource: 'account',
        isPreTax: false,
      },
    ],
  });

  it('R6.3 confirm: both sides confirmed, Internal transfer, category_source manual, pair kept, member unchanged', () => {
    expect(resolveSuggestion(jointSeven(), payid(), 'confirm', ctx)).toEqual({
      ok: true,
      a: {
        transactionId: 'tx:joint7',
        transferStatus: 'confirmed',
        transferPairId: 'tx:payid',
        splits: [
          {
            id: 'split:joint7',
            categoryId: INTERNAL,
            categorySource: 'manual',
            memberId: h.member('Home').id,
            memberSource: 'account',
            isPreTax: false,
          },
        ],
      },
      b: {
        transactionId: 'tx:payid',
        transferStatus: 'confirmed',
        transferPairId: 'tx:joint7',
        splits: [
          {
            id: 'split:payid',
            categoryId: INTERNAL,
            categorySource: 'manual',
            memberId: h.member('Male').id,
            memberSource: 'account',
            isPreTax: false,
          },
        ],
      },
    });
  });

  it('R6.3 reject: both sides none, pair cleared, category stays Uncategorised (no split changes)', () => {
    expect(resolveSuggestion(jointSeven(), payid(), 'reject', ctx)).toEqual({
      ok: true,
      a: {
        transactionId: 'tx:joint7',
        transferStatus: 'none',
        transferPairId: null,
        splits: [],
      },
      b: {
        transactionId: 'tx:payid',
        transferStatus: 'none',
        transferPairId: null,
        splits: [],
      },
    });
  });

  it('R6.3: works from either side (b, a)', () => {
    const r = resolveSuggestion(payid(), jointSeven(), 'confirm', ctx);
    expect(r.ok && r.a.transactionId).toBe('tx:payid');
    expect(r.ok && r.b.transferPairId).toBe('tx:payid');
  });

  it('R6.3 + R16.2: a suggested row whose category was changed is confirmed to Internal transfer; member by R5.1', () => {
    // 先把 #7 手动改成 Restaurants（R16.2 允许，仍是 suggested），归属人没改过
    const a = jointSeven();
    a.splits = [
      {
        ...a.splits[0],
        categoryId: h.category('Entertainment & eat-out / Restaurants').id,
        categorySource: 'manual',
      },
    ];
    const r = resolveSuggestion(a, payid(), 'confirm', ctx);
    expect(r.ok && r.a.splits[0]).toMatchObject({
      categoryId: INTERNAL,
      categorySource: 'manual',
      memberId: h.member('Home').id,
      memberSource: 'account',
    });
  });

  it('R6.3: error when a side is not suggested', () => {
    const b = { ...payid(), transferStatus: 'none' as const };
    expect(resolveSuggestion(jointSeven(), b, 'confirm', ctx).ok).toBe(false);
    expect(resolveSuggestion(jointSeven(), b, 'reject', ctx).ok).toBe(false);
  });

  it('R6.3: error when the two are not paired with each other', () => {
    const b = { ...payid(), transferPairId: 'tx:other' };
    expect(resolveSuggestion(jointSeven(), b, 'confirm', ctx).ok).toBe(false);
  });
});

describe('planTransferRedetect（R6.4 保存带尾号的账户时重新识别旧转账）', () => {
  const plus = h.account('ANZ Plus Male');
  const ctx = { categories: h.categories, cards: h.cards };
  const GROCERIES = h.category('Groceries / Supermarket').id;

  // 照 processFile 的结果当成已入库的交易（只有主拆分），id 用 "账户名#行号"
  function storedRows(path: FixturePath, account: Account, accounts: readonly Account[]) {
    const result = processFile(readFixture(path), account, { ...h, accounts });
    if (!result.ok) throw new Error(result.message);
    return result.rows.map((r, i): RedetectTx => ({
      id: `${account.name}#${i + 1}`,
      accountId: r.accountId,
      rawDescription: r.rawDescription,
      cardLast4: r.cardLast4,
      transferStatus: r.transferStatus,
      transferPairId: null,
      splits: [
        {
          id: `split:${account.name}#${i + 1}`,
          categoryId: r.categoryId,
          categorySource: r.categorySource,
          memberId: r.memberId,
          memberSource: r.memberSource,
          isPreTax: r.isPreTax,
        },
      ],
    }));
  }

  // 一笔只有主拆分的旧交易，默认是 ANZ Male 里转去 ANZ Plus 的 Uncategorised
  function tx(over: Partial<RedetectTx> & { split?: Partial<RedetectTx['splits'][number]> } = {}) {
    const { split, ...rest } = over;
    return {
      id: 'tx:1',
      accountId: male.id,
      rawDescription: 'TRANSFER TO 012345-****0004 #123456',
      cardLast4: null,
      transferStatus: 'none',
      transferPairId: null,
      splits: [
        {
          id: 'split:1',
          categoryId: UNCATEGORIZED,
          categorySource: 'system',
          memberId: h.member('Male').id,
          memberSource: 'account',
          isPreTax: false,
          ...split,
        },
      ],
      ...rest,
    } satisfies RedetectTx;
  }

  describe('R6.4 例子 1：CBA Female 后来才填尾号', () => {
    const noSuffix = h.accounts.map((a) => (a.id === female.id ? { ...a, numberSuffix: null } : a));
    const femaleNoSuffix = noSuffix.find((a) => a.id === female.id)!;
    const rows = storedRows('anz/joint-2026-09.csv', joint, noSuffix);

    it('R6.4: without the suffix #11 was imported as Uncategorised, Home (account)', () => {
      expect(rows[10]).toMatchObject({ transferStatus: 'none' });
      expect(rows[10].splits[0]).toMatchObject({
        categoryId: UNCATEGORIZED,
        memberId: h.member('Home').id,
        memberSource: 'account',
      });
    });

    it('R6.4: saving CBA Female with an empty suffix → nothing to change', () => {
      expect(planTransferRedetect(femaleNoSuffix, rows, noSuffix, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });

    it('R6.4: saving CBA Female with 0003 → #11 becomes auto, Internal transfer, Home (account); #18 (****9999) not included', () => {
      // householdAccounts 里还是保存前的旧值（没有尾号），以传进来的 account 为准
      const plan = planTransferRedetect(
        { ...femaleNoSuffix, numberSuffix: '0003' },
        rows,
        noSuffix,
        ctx,
      );
      expect(plan).toEqual({
        updates: [
          {
            transactionId: 'ANZ Joint#11',
            transferStatus: 'auto',
            split: {
              id: 'split:ANZ Joint#11',
              categoryId: INTERNAL,
              categorySource: 'system',
              memberId: h.member('Home').id,
              memberSource: 'account',
              isPreTax: false,
            },
          },
        ],
        keptCount: 0,
      });
      expect(plan.updates.map((u) => u.transactionId)).not.toContain('ANZ Joint#18');
    });
  });

  it('R6.4 例子 2: TRANSFER TO 012345-****0004 #123456 on ANZ Male matches ANZ Plus Male (0004)', () => {
    expect(planTransferRedetect(plus, [tx()], h.accounts, ctx)).toEqual({
      updates: [
        {
          transactionId: 'tx:1',
          transferStatus: 'auto',
          split: {
            id: 'split:1',
            categoryId: INTERNAL,
            categorySource: 'system',
            memberId: h.member('Male').id,
            memberSource: 'account',
            isPreTax: false,
          },
        },
      ],
      keptCount: 0,
    });
  });

  describe('R6.4 表格', () => {
    it('R6.4: only the primary split, category_source = rule → auto, Internal transfer, member by R5.1', () => {
      // 规则分到 Groceries（默认 Home，category）→ 内部转账没有分类默认，走账户默认 Male
      const t = tx({
        split: {
          categoryId: GROCERIES,
          categorySource: 'rule',
          memberId: h.member('Home').id,
          memberSource: 'category',
        },
      });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx).updates[0]).toEqual({
        transactionId: 'tx:1',
        transferStatus: 'auto',
        split: {
          id: 'split:1',
          categoryId: INTERNAL,
          categorySource: 'system',
          memberId: h.member('Male').id,
          memberSource: 'account',
          isPreTax: false,
        },
      });
    });

    it('R6.4: only the primary split, Uncategorised → auto, Internal transfer', () => {
      const plan = planTransferRedetect(plus, [tx()], h.accounts, ctx);
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].split).toMatchObject({
        categoryId: INTERNAL,
        categorySource: 'system',
      });
    });

    it('R6.4 + R5.1: manual member is kept when the category changes', () => {
      const t = tx({ split: { memberId: h.member('Home').id, memberSource: 'manual' } });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx).updates[0].split).toMatchObject({
        memberId: h.member('Home').id,
        memberSource: 'manual',
      });
    });

    it('R6.4: manual category → not changed, counted', () => {
      const t = tx({ split: { categoryId: GROCERIES, categorySource: 'manual' } });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 1,
      });
    });

    it('R6.4: more than one split → not changed, counted', () => {
      const t = tx();
      const second = {
        ...t.splits[0],
        id: 'split:2',
        categoryId: GROCERIES,
        categorySource: 'manual' as const,
      };
      expect(
        planTransferRedetect(plus, [{ ...t, splits: [t.splits[0], second] }], h.accounts, ctx),
      ).toEqual({ updates: [], keptCount: 1 });
    });

    it('R6.4: suggested (R6.3) is not a candidate → not changed, not counted', () => {
      const t = tx({ transferStatus: 'suggested', transferPairId: 'tx:other' });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });
  });

  describe('R6.4 候选和匹配', () => {
    it('R6.4: already a transfer (auto, confirmed) is not a candidate', () => {
      const auto = tx({ id: 'tx:a', transferStatus: 'auto' });
      const confirmed = tx({ id: 'tx:c', transferStatus: 'confirmed', transferPairId: 'tx:x' });
      expect(planTransferRedetect(plus, [auto, confirmed], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });

    it('R6.4: none but paired (R6.2 kept a manual category, R16.7) is not a candidate', () => {
      const t = tx({
        transferPairId: 'tx:other',
        split: { categoryId: GROCERIES, categorySource: 'manual' },
      });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });

    it('R6.4: transactions on the saved account itself are not candidates', () => {
      const t = tx({ accountId: plus.id });
      expect(planTransferRedetect(plus, [t], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });

    it('R6.4: matches a different household account → not changed, not counted', () => {
      // ****0002 是 ANZ Male，不是这次保存的 ANZ Plus
      const t = tx({
        accountId: joint.id,
        rawDescription: 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0002',
      });
      const manual = tx({
        id: 'tx:m',
        accountId: joint.id,
        rawDescription: t.rawDescription,
        split: { categorySource: 'manual' },
      });
      expect(planTransferRedetect(plus, [t, manual], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });

    it('R6.4: matches two household accounts (5678 vs 115678 and 225678) → not a transfer, not counted', () => {
      const a = { ...plus, numberSuffix: '115678' };
      const b: Account = { ...saver, id: 'account:other', numberSuffix: '225678' };
      const accounts = [...h.accounts, b];
      const t = tx({ rawDescription: 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  TO  ****5678' });
      const manual = tx({
        id: 'tx:m',
        rawDescription: t.rawDescription,
        split: { categorySource: 'manual' },
      });
      expect(planTransferRedetect(a, [t, manual], accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
      // 只有一个账户对得上时照常认
      expect(planTransferRedetect(a, [t], h.accounts, ctx).updates).toHaveLength(1);
    });

    it('R6.4: PayID transfer (no account) and non-transfer descriptions are not matched', () => {
      const payid = tx({ rawDescription: 'Fast Transfer From TEST HOLDER to PayID Phone joint' });
      const easi = tx({ id: 'tx:e', rawDescription: 'EASI AU ****0004' });
      expect(planTransferRedetect(plus, [payid, easi], h.accounts, ctx)).toEqual({
        updates: [],
        keptCount: 0,
      });
    });
  });
});
