import { BellRing } from 'lucide-react';
import Link from 'next/link';
import type { HomeReminder } from '@/lib/rules/conditions';

// R24.9：一行文字，点了跳 /accounts；没有提示时什么都不显示
export function ConditionReminder({ reminder }: { reminder: HomeReminder | null }) {
  if (!reminder) return null;
  return (
    <Link
      href="/accounts"
      className="flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-sm underline-offset-4 hover:bg-muted hover:underline"
    >
      <BellRing className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-words">{reminder.text}</span>
    </Link>
  );
}
