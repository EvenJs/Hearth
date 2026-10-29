'use client';

// F8 顶部的"N 张小票没挂上交易"（R20.7，M6.7-8，设计图 README 第 1 节：03 顶部提示条，点开是列表弹窗）
// 撤销导入、删除交易以后小票会脱开。N 是全部数据，不跟着当前筛选变
// 列表里每张点"挂到交易"进核对界面"挂到哪笔交易"那一步（receipt-attach.tsx），重新按 R20.4 匹配或 R20.5 新建
// 挂上以后服务器 revalidate，列表和 N 跟着变；都挂上了提示条消失
import { ChevronRight, ReceiptText } from 'lucide-react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { ReceiptAttachStep } from '@/components/receipt/receipt-attach';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatAud } from '@/lib/rules/money';
import { todayInMelbourne } from '@/lib/rules/periods';
import type { UnattachedReceipt } from '@/server/receipts';
import { formatTxDate } from './format';

export function UnattachedReceiptsBanner({ receipts }: { receipts: UnattachedReceipt[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const today = useMemo(() => todayInMelbourne(), []);

  // 弹窗是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(
    () => () => {
      setOpen(false);
      setSelected(null);
    },
    [],
  );

  if (receipts.length === 0) return null;
  // 选中的那张已经不在列表里（别处挂上了）→ 回到列表
  const current = selected !== null && receipts.some((r) => r.id === selected) ? selected : null;

  function close() {
    setOpen(false);
    setSelected(null);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sky-100 px-4 py-2.5 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-100">
        <ReceiptText className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <strong className="tabular-nums">{receipts.length}</strong> 张小票没挂上交易
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-medium underline underline-offset-2"
        >
          查看
        </button>
      </div>

      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{current ? '挂到哪笔交易' : '没挂上的小票'}</DialogTitle>
            <DialogDescription>
              {current
                ? '商品和拆分按保存时核对过的结果，选好交易后挂上'
                : '撤销导入或删掉交易以后，小票会脱开。重新导入后可以再挂上'}
            </DialogDescription>
          </DialogHeader>

          {current ? (
            <ReceiptAttachStep
              key={current}
              receiptId={current}
              onBack={() => setSelected(null)}
              onDone={() => setSelected(null)}
            />
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {receipts.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 break-words">{r.merchant || '小票'}</span>
                      <span className="shrink-0 tabular-nums">{formatAud(r.totalCents)}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTxDate(r.receiptDate, today)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setSelected(r.id)}
                  >
                    挂到交易
                    <ChevronRight className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
