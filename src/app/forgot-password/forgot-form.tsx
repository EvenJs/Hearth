'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useLayoutEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { forgotPasswordAction } from './actions';

const forgotSchema = z.object({
  email: z.string().trim().pipe(z.email('邮箱格式不对')),
});

type ForgotValues = z.infer<typeof forgotSchema>;

export function ForgotForm() {
  // R26.8 不管邮箱存不存在都是同一句（服务端给）；失败是格式不对或 60 秒内又点
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 离开页面时清掉提示（cacheComponents 会保留 state，tech-stack 2）
  useLayoutEffect(() => () => setResult(null), []);

  const form = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit({ email }: ForgotValues) {
    setResult(null);
    try {
      setResult(await forgotPasswordAction(email));
    } catch {
      setResult({ ok: false, message: '没发出去，请稍后再试' });
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <p className="text-sm text-muted-foreground">
          填注册时用的邮箱，我们会发一个重置密码的链接。
        </p>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>邮箱</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="yourname@family.com"
                  className="h-11"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {result && (
          <p
            role={result.ok ? 'status' : 'alert'}
            className={
              result.ok ? 'rounded-md bg-muted px-3 py-2 text-sm' : 'text-sm text-destructive'
            }
          >
            {result.message}
          </p>
        )}

        <Button type="submit" className="h-11 w-full text-base" disabled={submitting}>
          {submitting ? '发送中…' : '发送重置链接'}
        </Button>

        <p className="text-center text-sm">
          <Link
            href="/login"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            返回登录
          </Link>
        </p>
      </form>
    </Form>
  );
}
