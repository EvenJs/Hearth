'use client';

// 拍小票的流程容器（M6.7-7，tech-stack 11.3）：选图 → 浏览器里压缩 → 识别（能取消）→ 核对界面
// - 电脑（≥ 640px）：弹窗；手机：全屏 Sheet。开哪种在点按钮的那一刻按屏幕宽度决定（和快速录入一样）
// - 入口按当前 reader 显示：image → 选图；没有 reader（none）→ 直接打开空的核对界面，不调 LLM
//   text reader 不做（R20.1b），所以只有这两种
// - 取消识别：丢掉结果，什么都不存（识别本来就不写库）
// 图片只在这次请求的内存里，不保存
import { Camera, ImageUp, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { ReceiptDraft } from '@/server/receipts';
import { scanReceiptAction } from './actions';
import { compressReceiptImage, UnreadableImageError } from './compress-image';
import { ReceiptReview, type ReceiptReviewVariant } from './receipt-review';

const MOBILE_QUERY = '(max-width: 639px)'; // 和 Tailwind 的 sm 对齐

// 'image'：要选图；null：没有 reader，直接手动填
export type ReceiptInputMode = 'image' | null;

type Phase =
  { kind: 'pick' } | { kind: 'reading'; message: string } | { kind: 'review'; draft: ReceiptDraft };

export function useReceiptFlow(opts: {
  inputMode: ReceiptInputMode;
  fixedTransactionId?: string;
}): { start: () => void; node: React.ReactNode } {
  const { inputMode, fixedTransactionId } = opts;
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<ReceiptReviewVariant>('dialog');
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [session, setSession] = useState(0);
  const latest = useRef(0); // 关掉或重新开始后，旧的识别结果丢掉
  const fileInput = useRef<HTMLInputElement>(null);

  async function scan(id: number, image: Blob | null) {
    const form = new FormData();
    if (image) form.append('image', image, 'receipt.jpg');
    const r = await scanReceiptAction(form);
    if (latest.current !== id) return; // 已经取消了
    if (r.ok) {
      setPhase({ kind: 'review', draft: r.draft });
    } else {
      toast.error(r.message);
      if (image) setPhase({ kind: 'pick' });
      else close();
    }
  }

  function start() {
    const id = session + 1;
    latest.current = id;
    setSession(id);
    setVariant(window.matchMedia(MOBILE_QUERY).matches ? 'sheet' : 'dialog');
    setOpen(true);
    if (inputMode === 'image') {
      setPhase({ kind: 'pick' });
      // 在点击的同一个事件里打开选图（手机上可以直接拍照）。用户取消了也还停在"选图"这一步
      fileInput.current?.click();
    } else {
      setPhase({ kind: 'reading', message: '打开中…' });
      void scan(id, null);
    }
  }

  function close() {
    latest.current = 0;
    setOpen(false);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同一张图能再选一次
    if (!file) return;
    const id = latest.current;
    setPhase({ kind: 'reading', message: '压缩图片…' });
    let image: Blob;
    try {
      image = await compressReceiptImage(file);
    } catch (err) {
      if (latest.current !== id) return;
      toast.error(err instanceof UnreadableImageError ? err.message : '这张图处理不了，换一张再试');
      setPhase({ kind: 'pick' });
      return;
    }
    if (latest.current !== id) return;
    setPhase({ kind: 'reading', message: '识别中，可能要十几秒…' });
    await scan(id, image);
  }

  const sheet = variant === 'sheet';

  const body =
    phase.kind === 'review' ? (
      <ReceiptReview
        key={session}
        variant={variant}
        draft={phase.draft}
        fixedTransactionId={fixedTransactionId}
        onClose={close}
      />
    ) : phase.kind === 'reading' ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {phase.message}
        </p>
        <Button variant="outline" size={sheet ? 'lg' : 'default'} onClick={close}>
          取消
        </Button>
      </div>
    ) : (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          拍一张小票，或者从相册选。图片只用来识别，不会保存
        </p>
        <Button
          size="lg"
          className="h-12 w-full max-w-xs text-base"
          onClick={() => fileInput.current?.click()}
        >
          {sheet ? <Camera className="size-5" /> : <ImageUp className="size-5" />}
          {sheet ? '拍照或选图' : '选一张小票照片'}
        </Button>
        <Button variant="ghost" onClick={close}>
          取消
        </Button>
      </div>
    );

  const title = phase.kind === 'review' ? '核对小票' : '拍小票';
  const description =
    phase.kind === 'review'
      ? phase.draft.read.status === 'ok'
        ? '从照片识别，分类是建议，可以改'
        : '手动填，分类可以改'
      : '图片只用来识别，不会保存';

  const node = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={onFile}
      />
      <Dialog open={open && !sheet} onOpenChange={(o) => !o && close()}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl"
          onInteractOutside={(e) => phase.kind === 'review' && e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {!sheet && body}
        </DialogContent>
      </Dialog>
      <Sheet open={open && sheet} onOpenChange={(o) => !o && close()}>
        <SheetContent side="bottom" showCloseButton={false} className="h-dvh gap-0 border-t-0 p-0">
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {sheet &&
            (phase.kind === 'review' ? body : <div className="flex h-full flex-col">{body}</div>)}
        </SheetContent>
      </Sheet>
    </>
  );

  return { start, node };
}
