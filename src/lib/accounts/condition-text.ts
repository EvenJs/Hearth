// R24.1 条件的一行说明，金额和笔数填进去。设置页（配置）和账户总览（进度、历史）共用
import { DEPOSIT_FILTER_LABELS, type MonthlyCondition } from '@/lib/rules/conditions';
import { formatAud } from '@/lib/rules/money';

export function conditionText(c: MonthlyCondition): string {
  switch (c.type) {
    case 'min_deposit':
    case 'linked_min_deposit': {
      const prefix = c.type === 'min_deposit' ? '当月存入' : '关联账户当月存入';
      const filter = c.depositFilter === 'any' ? '' : `（${DEPOSIT_FILTER_LABELS[c.depositFilter]}）`;
      return `${prefix}至少 ${formatAud(c.amountCents)}${filter}`;
    }
    case 'linked_card_count':
      return `关联账户当月刷卡至少 ${c.cardCount} 笔`;
    case 'no_withdrawal':
      return '当月不取款';
    case 'balance_growth':
      return '月末余额比上月末高';
    case 'other':
      return `其他：${c.description}`;
  }
}
