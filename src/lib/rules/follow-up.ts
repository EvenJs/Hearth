// F8 改完分类、归属人之后的追问（business-rules.md R16.9、R16.10）
// 都按 R13 建议的关键词找"同商家"的交易。纯函数，不 import 数据库和 Next.js
import { suggestKeyword } from './keyword';
import { changeMember, type EditSplit } from './split-edit';
import type { CategoryKind, TransferStatus } from './types';

// merchant 包含关键词，不区分大小写
function containsKeyword(merchant: string, keyword: string): boolean {
  return merchant.toUpperCase().includes(keyword.toUpperCase());
}

// ---------- R16.9 ----------

export type RuleOffer = 'dialog' | 'toast' | 'none';

export type RuleOfferInput = {
  transactionId: string;
  merchant: string; // R3 清洗后的
  isPrimary: boolean; // 改的是主拆分
  changed: boolean; // 分类真的变了
  newKind: CategoryKind;
};

// R16.9：前三条（分类变了、新分类是 expense 或 income、主拆分）不满足 → none
// 第四条：本家庭除了这笔以外，有 merchant 包含建议关键词的交易 → dialog；没有 → toast 里给"存成规则"按钮
// householdTxs 是本家庭的交易（可以包含这笔自己），不管它们现在是什么分类
export function shouldOfferRule(
  input: RuleOfferInput,
  householdTxs: readonly { id: string; merchant: string }[],
): RuleOffer {
  if (!input.changed || !input.isPrimary || input.newKind === 'system') return 'none';
  const keyword = suggestKeyword(input.merchant);
  const similar = householdTxs.some(
    (t) => t.id !== input.transactionId && containsKeyword(t.merchant, keyword),
  );
  return similar ? 'dialog' : 'toast';
}

// ---------- R16.10 ----------

export type PropagationTx = {
  id: string;
  merchant: string;
  transferStatus: TransferStatus;
  splits: readonly EditSplit[];
};

export type MemberPropagation = {
  keyword: string; // 弹窗文案里的 X
  updates: { transactionId: string; split: EditSplit }[]; // N = updates.length，0 不弹
};

// R16.10：行内改了 changed 主拆分的归属人后，同商家（merchant 包含建议关键词）一起改的交易
// 只算只有主拆分、归属人不是 newMemberId、member_source 不是 manual、不是 auto / confirmed 转账的
// 改成 newMemberId，member_source = manual（R16.4）
export function planMemberPropagation(
  changed: { id: string; merchant: string },
  newMemberId: string,
  others: readonly PropagationTx[],
): MemberPropagation {
  const keyword = suggestKeyword(changed.merchant);
  const updates: MemberPropagation['updates'] = [];
  for (const t of others) {
    if (t.id === changed.id || !containsKeyword(t.merchant, keyword)) continue;
    if (t.transferStatus === 'auto' || t.transferStatus === 'confirmed') continue;
    if (t.splits.length !== 1) continue;
    const [split] = t.splits;
    if (split.memberSource === 'manual' || split.memberId === newMemberId) continue;
    updates.push({ transactionId: t.id, split: changeMember(split, newMemberId) });
  }
  return { keyword, updates };
}
