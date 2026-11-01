'use client';

// 交易详情小票明细里一件正数商品的类型下拉（R21.6）：选了就保存，只改 parsed_json 并学习，拆分不动
// 旧小票没类型时显示"未分"（不是选项）。负数行没有下拉，由 receipt-section 显示"跟上一件"
import { useOptimistic, useTransition } from 'react';
import { toast } from 'sonner';
import { setReceiptItemTypeAction } from '@/components/receipt/actions';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ITEM_TYPES, type ItemType } from '@/lib/rules/item-type';

export function ReceiptItemTypeSelect({
  receiptId,
  index,
  name,
  type,
}: {
  receiptId: string;
  index: number;
  name: string;
  type: ItemType | null;
}) {
  const [pending, startTransition] = useTransition();
  // 保存完 revalidatePath 带回新的 type；失败时自动回到原来的
  const [shown, setShown] = useOptimistic(type);

  function change(next: ItemType) {
    if (next === shown) return;
    startTransition(async () => {
      setShown(next);
      const r = await setReceiptItemTypeAction(receiptId, index, next);
      if (r.ok) toast.success('已改类型，拆分没变');
      else toast.error(r.message);
    });
  }

  return (
    <Select
      value={shown ?? undefined}
      onValueChange={(v) => change(v as ItemType)}
      disabled={pending}
    >
      {/* 手机上高一点好点；shadcn 的高度写在 data-[size] 上，要用同一个变体才盖得住 */}
      <SelectTrigger
        aria-label={`${name} 的类型`}
        className="w-28 data-[size=default]:h-10 sm:w-full sm:data-[size=default]:h-8"
      >
        <SelectValue placeholder="未分" />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {ITEM_TYPES.map((t) => (
          <SelectItem key={t.key} value={t.key}>
            {t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
