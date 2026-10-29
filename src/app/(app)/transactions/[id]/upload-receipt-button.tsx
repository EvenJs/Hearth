'use client';

// 交易详情的"上传小票"（M6.7-7，R20.4）：交易已经定了，不找候选、不检查日期，差额按 R20.3 第 4 步
// 只在支出、transfer_status = none、还没挂小票的交易上显示（页面判断）
import { ReceiptText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReceiptFlow, type ReceiptInputMode } from '@/components/receipt/receipt-flow';

export function UploadReceiptButton({
  transactionId,
  inputMode,
}: {
  transactionId: string;
  inputMode: ReceiptInputMode;
}) {
  const flow = useReceiptFlow({ inputMode, fixedTransactionId: transactionId });
  return (
    <>
      <Button variant="outline" size="sm" onClick={flow.start}>
        <ReceiptText className="size-4" />
        上传小票
      </Button>
      {flow.node}
    </>
  );
}
