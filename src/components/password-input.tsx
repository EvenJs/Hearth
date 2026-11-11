'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// 带"显示密码"按钮的密码框。放在 FormControl 里用，props 传给 Input
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} className={cn('h-11 pr-11', className)} {...props} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? '隐藏密码' : '显示密码'}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
