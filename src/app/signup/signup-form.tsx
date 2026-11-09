'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
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
import { signupAction } from './actions';

// R26.4 第 1 条的字段提示。服务端 registerWithInvite 会再整理、再校验一次
const signupSchema = z
  .object({
    email: z.string().trim().pipe(z.email('邮箱格式不对')),
    name: z
      .string()
      .transform((v) => v.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(1, '请填名字').max(30, '名字最多 30 个字')),
    password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
    confirmPassword: z.string(),
    // 码的整理和"邀请码不对"都在服务端（R26.1、R26.4 第 2 条），空的也交给服务端提示
    code: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: '两次密码不一样',
  });

type SignupInput = z.input<typeof signupSchema>;
type SignupValues = z.output<typeof signupSchema>;

// R26.4 第 7 条。registerWithInvite 只给文字，这条要换成带登录链接的
const EMAIL_TAKEN = '这个邮箱已经注册了，去登录';

export function SignupForm({ initialCode }: { initialCode: string }) {
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  // 注册成功后的提示（验证邮件发没发出去）。不自动登录（R26.5）
  const [done, setDone] = useState<string | null>(null);

  const form = useForm<SignupInput, unknown, SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: '', name: '', password: '', confirmPassword: '', code: initialCode },
  });

  // 离开页面时清掉成功和失败提示（cacheComponents 会保留 state，tech-stack 2）。填到一半的表单保留
  useLayoutEffect(
    () => () => {
      setDone(null);
      setFormError(null);
      setEmailTaken(false);
    },
    [],
  );

  async function onSubmit({ email, name, password, code }: SignupValues) {
    setFormError(null);
    setEmailTaken(false);
    let result;
    try {
      // 确认密码只在前端比，不传给服务端
      result = await signupAction({ email, name, password, code });
    } catch {
      setFormError('注册没成功，再试一次');
      return;
    }
    if (result.ok) {
      // 清空表单，密码不留在保留下来的页面状态里
      form.reset({ email: '', name: '', password: '', confirmPassword: '', code: '' });
      setDone(result.message);
      return;
    }
    if (result.field === 'form') {
      setFormError(result.message);
      return;
    }
    if (result.field === 'email' && result.message === EMAIL_TAKEN) setEmailTaken(true);
    form.setError(result.field, { message: result.message }, { shouldFocus: true });
  }

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {done}
        </p>
        <Button asChild className="h-11 w-full text-base">
          <Link href="/login">去登录</Link>
        </Button>
      </div>
    );
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>邀请码</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="XXXX-XXXX"
                  className="h-11 font-mono uppercase placeholder:normal-case"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
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
                  onChange={(e) => {
                    setEmailTaken(false);
                    field.onChange(e);
                  }}
                />
              </FormControl>
              {emailTaken ? (
                <p className="text-sm text-destructive">
                  这个邮箱已经注册了，
                  <Link href="/login" className="underline underline-offset-4">
                    去登录
                  </Link>
                </p>
              ) : (
                <FormMessage />
              )}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>名字</FormLabel>
              <FormControl>
                <Input autoComplete="name" className="h-11" {...field} />
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
              <FormLabel>密码</FormLabel>
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
              <FormLabel>确认密码</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="new-password" {...field} />
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

        <Button type="submit" className="h-11 w-full text-base" disabled={submitting}>
          {submitting ? '注册中…' : '注册'}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          已经有账号？
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            去登录
          </Link>
        </p>
      </form>
    </Form>
  );
}
