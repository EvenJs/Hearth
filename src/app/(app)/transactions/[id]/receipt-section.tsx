import { ReceiptText } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ITEM_TYPES } from '@/lib/rules/item-type';
import type { ReceiptPaymentMethod } from '@/lib/rules/receipt';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { TransactionReceipt, TransactionReceiptItem } from '@/server/receipts';
import { formatTxDate } from '../format';
import { DeleteReceiptButton } from './delete-receipt-button';
import { ReceiptItemTypeSelect } from './receipt-item-type-select';

// F8 交易详情的"小票"一块（R20.7，M6.7-8，设计图 README 第 1 节"04 里的一块"）
// 显示保存时核对过的小票：店名、日期、总额、商品（名字、金额、类型、分类）、整单折扣
// 改拆分不改小票（R20.7 / R15），所以这里的分类可能和现在的拆分不一样
// 商品类型能改（R21.6）：只改小票里的类型并学习，拆分不动。旧小票没类型显示"未分"
// 电脑上一行四列（商品、类型、分类、金额），窄屏第二行左边分类、右边类型

const TYPE_LABEL = new Map<string, string>(ITEM_TYPES.map((t) => [t.key, t.label]));
const COLUMNS = 'sm:grid-cols-[minmax(0,1fr)_8rem_16rem_7rem]';

const PAYMENT_LABEL: Record<ReceiptPaymentMethod, string> = {
  card: '刷卡',
  cash: '现金',
  unknown: '付款方式不确定',
};

export function ReceiptSection({ receipt, today }: { receipt: TransactionReceipt; today: string }) {
  const itemsCents = receipt.items.reduce((s, i) => s + i.amountCents, 0);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText className="size-4" />
          小票
        </CardTitle>
        <CardDescription className="break-words">
          {receipt.merchant || '（没有店名）'} · {formatTxDate(receipt.receiptDate, today)} ·{' '}
          {PAYMENT_LABEL[receipt.payment]}
        </CardDescription>
        <CardAction>
          <DeleteReceiptButton receiptId={receipt.id} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-md border">
          <div
            className={cn(
              'hidden gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid',
              COLUMNS,
            )}
          >
            <span>商品</span>
            <span>类型</span>
            <span>分类</span>
            <span className="text-right">金额</span>
          </div>
          <ul className="divide-y text-sm">
            {receipt.items.map((item, i) => (
              <li
                key={i}
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2',
                  COLUMNS,
                )}
              >
                <span className="min-w-0 break-words">{item.name}</span>
                <span className="col-start-2 row-start-2 flex justify-end sm:col-start-2 sm:row-start-1 sm:block">
                  {item.amountCents < 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {i > 0 && '跟上一件 · '}
                      {item.type ? TYPE_LABEL.get(item.type) : '未分'}
                    </span>
                  ) : (
                    <ReceiptItemTypeSelect
                      receiptId={receipt.id}
                      index={i}
                      name={item.name}
                      type={item.type}
                    />
                  )}
                </span>
                <span className="col-start-1 row-start-2 min-w-0 text-xs sm:col-start-3 sm:row-start-1 sm:text-sm">
                  <ItemCategory item={item} />
                </span>
                <Amount
                  cents={item.amountCents}
                  className="col-start-2 row-start-1 sm:col-start-4"
                />
              </li>
            ))}
            {receipt.discounts.map((d, i) => (
              <li
                key={`d${i}`}
                className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2', COLUMNS)}
              >
                <span className="min-w-0 break-words">{d.label}</span>
                <span className="hidden text-muted-foreground sm:col-span-2 sm:block">
                  整单折扣，按比例分到各分类和类型
                </span>
                <Amount cents={d.amountCents} />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1 border-t bg-muted/40 px-3 py-2 text-sm">
            {receipt.discounts.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                商品 {formatAud(itemsCents)}
              </span>
            )}
            <span>
              总额 <strong className="tabular-nums">{formatAud(receipt.totalCents)}</strong>
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          这是保存时核对过的小票。之后改拆分不会改这里；改商品类型只改小票，拆分不变；删除小票只删这张小票，拆分不变。
        </p>
      </CardContent>
    </Card>
  );
}

// 分类：存的那个（`一级 / 二级`）；没存的是保存时跟主分类或跟上一件（R20.3 第 1 步）
function ItemCategory({ item }: { item: TransactionReceiptItem }) {
  if (item.categoryLabel !== null) {
    return <span className="break-words">{item.categoryLabel}</span>;
  }
  return (
    <span className="text-muted-foreground">
      {item.follow === 'previous' ? '跟上一件' : '跟主分类'}
    </span>
  );
}

function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span
      className={cn(
        'text-right font-mono tabular-nums',
        cents < 0 && 'text-destructive',
        className,
      )}
    >
      {formatAud(cents)}
    </span>
  );
}
