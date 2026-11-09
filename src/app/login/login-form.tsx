'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PasswordInput } from '@/components/password-input';
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
import { authClient } from '@/lib/auth-client';
import { resendVerificationAction } from './actions';

const loginSchema = z.object({
  email: z.email('请输入正确的邮箱'),
  password: z.string().min(1, '请输入密码'),
});

type LoginValues = z.infer<typeof loginSchema>;

// 从 URL 带进来的提示：重置密码成功、验证链接过期
export type LoginNotice = { kind: 'info' | 'error'; message: string } | null;

const NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

// 不区分邮箱错还是密码错，统一一句提示
function toErrorMessage({ status, code }: { status: number; code?: string }) {
  // R26.7 密码对但邮箱没验证，下面显示"重发验证邮件"
  if (code === NOT_VERIFIED) return '邮箱还没验证，去邮箱点验证链接';
  if (status === 429) return '尝试次数太多，请稍后再试';
  if (status === 400 || status === 401 || status === 403) return '邮箱或密码不正确';
  return '登录失败，请稍后再试';
}

export function LoginForm({ notice }: { notice: LoginNotice }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  // 验证链接过期进来的，直接给重发按钮
  const [canResend, setCanResend] = useState(notice?.kind === 'error');
  const [resendResult, setResendResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [resending, setResending] = useState(false);

  // 离开页面时清掉提示（cacheComponents 会保留 state，tech-stack 2）
  useLayoutEffect(
    () => () => {
      setFormError(null);
      setResendResult(null);
    },
    [],
  );

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginValues) {
    setFormError(null);
    setResendResult(null);
    const { error } = await authClient.signIn.email(values);
    if (error) {
      setFormError(toErrorMessage(error));
      setCanResend(error.code === NOT_VERIFIED);
      return;
    }
    // 先清空表单，避免密码留在保留下来的页面状态里
    form.reset();
    router.replace('/');
    router.refresh();
  }

  // R26.7 用表单里填的邮箱重发，60 秒一次，提示由服务端给
  async function onResend() {
    const email = form.getValues('email');
    if (!email.trim()) {
      form.setError('email', { message: '先填邮箱' });
      return;
    }
    setResending(true);
    try {
      setResendResult(await resendVerificationAction(email));
    } catch {
      setResendResult({ ok: false, message: '没发出去，请稍后再试' });
    } finally {
      setResending(false);
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        {notice && (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={
              notice.kind === 'error'
                ? 'text-sm text-destructive'
                : 'rounded-md bg-muted px-3 py-2 text-sm'
            }
          >
            {notice.message}
          </p>
        )}

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>邮箱</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="username"
                  placeholder="yourname@family.com"
                  className="h-11"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>密码</FormLabel>
                <Link
                  href="/forgot-password"
                  className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  忘记密码
                </Link>
              </div>
              <FormControl>
                <PasswordInput autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        {canResend && (
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" onClick={onResend} disabled={resending}>
              {resending ? '发送中…' : '重发验证邮件'}
            </Button>
            {resendResult && (
              <p
                role={resendResult.ok ? 'status' : 'alert'}
                className={
                  resendResult.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'
                }
              >
                {resendResult.message}
              </p>
            )}
          </div>
        )}

        <Button type="submit" className="h-11 w-full text-base" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </Button>
      </form>
    </Form>
  );
}
