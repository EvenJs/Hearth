'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useTransition } from 'react';
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
import { authClient } from '@/lib/auth-client';

// R26.8 新密码 8 到 128 位，填两遍要一样
const resetSchema = z
  .object({
    password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: '两次密码不一样',
  });

type ResetValues = z.infer<typeof resetSchema>;

function Expired() {
  return (
    <div className="flex flex-col gap-5">
      <p role="alert" className="text-sm text-destructive">
        链接过期了，重新申请
      </p>
      <Button asChild className="h-11 w-full text-base">
        <Link href="/forgot-password">重新申请</Link>
      </Button>
    </div>
  );
}

// 走 /api/auth/reset-password（和登录一样带 Better Auth 自带的限流），不单独写 Server Action
// 成功后这个用户所有 session 退出（auth.ts revokeSessionsOnPasswordReset），跳登录页
export function ResetForm({ token }: { token: string | null }) {
  return token === null ? <Expired /> : <NewPasswordForm token={token} />;
}

function NewPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [expired, setExpired] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 改成功后等登录页出来，这段时间表单保持填好的样子（M13-2）
  const [navigating, startTransition] = useTransition();

  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  // 离开页面时清掉密码和提示（cacheComponents 会保留 state，tech-stack 2）
  useLayoutEffect(
    () => () => {
      setFormError(null);
      form.reset();
    },
    [form],
  );

  if (expired) return <Expired />;

  async function onSubmit({ password }: ResetValues) {
    setFormError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    if (error) {
      if (error.code === 'INVALID_TOKEN') setExpired(true);
      else if (error.status === 429) setFormError('尝试次数太多，请稍后再试');
      else setFormError('没改成功，请稍后再试');
      return;
    }
    // 不在这里清表单，否则跳转完成前会露出空表单。密码在离开页面时清（上面的 cleanup）
    startTransition(() => router.replace('/login?reset=1'));
  }

  const busy = form.formState.isSubmitting || navigating;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        {/* 提交和跳转期间整组禁用 */}
        <fieldset disabled={busy} className="contents">
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>新密码</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>确认新密码</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        <Button type="submit" className="h-11 w-full text-base" loading={busy}>
          改密码
        </Button>
      </form>
    </Form>
  );
}
