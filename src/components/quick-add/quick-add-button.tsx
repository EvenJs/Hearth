'use client';

// 顶栏"记一笔"按钮和弹窗（F3，M6-3）
// 每次打开换一个 key：表单重新挂载，关掉再打开是空的（docs/tech-stack.md 2"页面状态"）
// 数据每次打开都重新取（今天、上次账户、常用分类），取回来之前金额已经能输
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getQuickAddDataAction, type QuickAddData } from './actions';
import { QuickAddForm } from './quick-add-form';

export function QuickAddButton() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [data, setData] = useState<QuickAddData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const latest = useRef(0);

  async function load(id: number) {
    const r = await getQuickAddDataAction();
    if (latest.current !== id) return; // 已经关掉或重新打开了
    if (r.ok) setData(r.data);
    else setLoadError(r.message);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      const id = session + 1;
      latest.current = id;
      setSession(id);
      setData(null);
      setLoadError(null);
      void load(id);
    } else {
      latest.current = 0;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus className="size-4" />
        <span className="hidden sm:inline">记一笔</span>
      </Button>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        // 打开就聚焦金额（表单里的 autoFocus），不让 Radix 抢到第一个按钮上
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById('quick-add-amount')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>记一笔</DialogTitle>
          <DialogDescription>现金和随手记的消费。按 Esc 关闭</DialogDescription>
        </DialogHeader>
        {open && (
          <QuickAddForm
            key={session}
            data={data}
            loadError={loadError}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
