'use client';

// "记一笔"入口和容器（F3，M6-3 / M6-4）
// - 电脑（≥ 640px）：顶栏按钮 → 弹窗
// - 手机（< 640px）：右下角悬浮 + 按钮 → 全屏 Sheet（05-quick-add-mobile）
// 开哪种在点按钮的那一刻按屏幕宽度决定，不在渲染时判断（服务端不知道宽度）
// 每次打开换一个 key：表单重新挂载，关掉再打开是空的（docs/tech-stack.md 2"页面状态"）
// 数据每次打开都重新取（今天、上次账户、常用分类），取回来之前金额已经能输
import { Plus } from 'lucide-react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription } from '@/components/ui/sheet';
import { useReceiptFlow, type ReceiptInputMode } from '@/components/receipt/receipt-flow';
import { getQuickAddDataAction, type QuickAddData } from './actions';
import { QuickAddForm, type QuickAddVariant } from './quick-add-form';

const MOBILE_QUERY = '(max-width: 639px)'; // 和 Tailwind 的 sm 对齐

function focusAmount(e: Event) {
  e.preventDefault();
  document.getElementById('quick-add-amount')?.focus();
}

// receiptInput：当前 reader 收什么（服务器端按 RECEIPT_READER 传进来，M6.7-7）
export function QuickAddButton({ receiptInput }: { receiptInput: ReceiptInputMode }) {
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<QuickAddVariant>('dialog');
  const [session, setSession] = useState(0);
  const [data, setData] = useState<QuickAddData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const latest = useRef(0);
  const keyboardProxy = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const viewport = useVisualViewport(open && variant === 'sheet');
  const receipt = useReceiptFlow({ inputMode: receiptInput });

  async function load(id: number) {
    const r = await getQuickAddDataAction();
    if (latest.current !== id) return; // 已经关掉或重新打开了
    if (r.ok) setData(r.data);
    else setLoadError(r.message);
  }

  function openNow() {
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    // iOS 只在点击的同一个事件里 focus() 才弹键盘，Sheet 要下一轮渲染才挂上。
    // 先同步聚焦屏幕外的输入框把键盘叫出来，Sheet 挂好后焦点移到金额框，键盘不会收回
    if (mobile) keyboardProxy.current?.focus();
    const id = session + 1;
    latest.current = id;
    setVariant(mobile ? 'sheet' : 'dialog');
    setSession(id);
    setData(null);
    setLoadError(null);
    setOpen(true);
    void load(id);
  }

  function onOpenChange(next: boolean) {
    if (next) {
      openNow();
      return;
    }
    setOpen(false);
    latest.current = 0;
  }

  const form = open && (
    <QuickAddForm
      key={session}
      variant={variant}
      data={data}
      loadError={loadError}
      onClose={() => onOpenChange(false)}
      onReceipt={() => {
        // 同一次点击里关掉快速录入、打开选图（手机上才能直接调相机）
        onOpenChange(false);
        receipt.start();
      }}
    />
  );

  return (
    <>
      <Button size="sm" className="hidden sm:inline-flex" onClick={openNow}>
        <Plus className="size-4" />
        记一笔
      </Button>

      {/* 悬浮按钮放到 body 下：顶栏有 backdrop-blur，fixed 的子元素会被它困住 */}
      {mounted &&
        createPortal(
          <>
            <Button
              size="icon"
              aria-label="记一笔"
              onClick={openNow}
              className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 size-14 rounded-full shadow-lg sm:hidden"
            >
              <Plus className="size-7" />
            </Button>
            {/* 叫出键盘用的输入框：不能 display:none，字号 16px 免得 iOS 放大页面 */}
            <input
              ref={keyboardProxy}
              aria-hidden
              tabIndex={-1}
              inputMode="decimal"
              className="pointer-events-none fixed top-0 left-0 size-px text-base opacity-0"
            />
          </>,
          document.body,
        )}

      <Dialog open={open && variant === 'dialog'} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
          onOpenAutoFocus={focusAmount}
        >
          <DialogHeader>
            <DialogTitle>记一笔</DialogTitle>
            <DialogDescription>现金和随手记的消费。按 Esc 关闭</DialogDescription>
          </DialogHeader>
          {variant === 'dialog' && form}
        </DialogContent>
      </Dialog>

      {receipt.node}

      <Sheet open={open && variant === 'sheet'} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          onOpenAutoFocus={focusAmount}
          className="h-dvh gap-0 border-t-0 p-0"
          // 键盘弹出时 iOS 不缩页面：把 Sheet 限制在看得到的那块（visualViewport），顶栏的保存按钮一直在屏幕上
          style={
            viewport ? { top: viewport.top, height: viewport.height, bottom: 'auto' } : undefined
          }
        >
          <SheetDescription className="sr-only">现金和随手记的消费</SheetDescription>
          {variant === 'sheet' && form}
        </SheetContent>
      </Sheet>
    </>
  );
}

// ---------- hooks ----------

const noopSubscribe = () => () => {};

// 客户端挂载后才为 true（createPortal 要 document.body）
function useMounted() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// 看得到的区域（键盘弹出后会变小）。不支持 visualViewport 或没打开时返回 null，用 h-dvh
function useVisualViewport(enabled: boolean): { top: number; height: number } | null {
  const snapshot = useSyncExternalStore(
    (onChange) => {
      const vv = window.visualViewport;
      if (!enabled || !vv) return () => {};
      vv.addEventListener('resize', onChange);
      vv.addEventListener('scroll', onChange);
      return () => {
        vv.removeEventListener('resize', onChange);
        vv.removeEventListener('scroll', onChange);
      };
    },
    () => {
      const vv = window.visualViewport;
      return enabled && vv ? `${vv.offsetTop}:${vv.height}` : '';
    },
    () => '',
  );
  if (!snapshot) return null;
  const [top, height] = snapshot.split(':').map(Number);
  return { top, height };
}
