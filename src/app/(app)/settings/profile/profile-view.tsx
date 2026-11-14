'use client';

// 设置 → 账号（design/README 21，R26.8）：基本信息、改密码两张卡片
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useLayoutEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { updateNameAction } from './actions';

type Props = { email: string; name: string };

export function ProfileView({ email, name }: Props) {
  return (
    <div className="grid max-w-xl gap-6">
      <BasicInfoCard email={email} name={name} />
      <PasswordCard />
    </div>
  );
}

// R26.4 名字整理。服务端 updateNameAction 会再校验一次
const nameSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, '请填名字').max(30, '名字最多 30 个字')),
});

type NameInput = z.input<typeof nameSchema>;
type NameValues = z.output<typeof nameSchema>;

function BasicInfoCard({ email, name }: Props) {
  const router = useRouter();
  // 填到一半离开再回来保留（tech-stack 2）
  const form = useForm<NameInput, unknown, NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name },
  });

  async function onSubmit(values: NameValues) {
    let result;
    try {
      result = await updateNameAction(values.name);
    } catch {
      toast.error('没成功，请稍后再试');
      return;
    }
    if (!result.ok) {
      form.setError('name', { message: result.message }, { shouldFocus: true });
      return;
    }
    form.reset({ name: values.name });
    toast.success('名字改好了');
    router.refresh();
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>基本信息</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-email">邮箱</Label>
              <Input id="profile-email" value={email} readOnly disabled />
              <p className="text-sm text-muted-foreground">邮箱不能改</p>
            </div>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>名字</FormLabel>
                  <FormControl>
                    <Input autoComplete="name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div>
              <Button type="submit" loading={submitting} disabled={!form.formState.isDirty}>
                保存
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, '请填当前密码'),
    newPassword: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: '两次密码不一样',
  });

type PasswordValues = z.infer<typeof passwordSchema>;

const EMPTY_PASSWORDS: PasswordValues = { currentPassword: '', newPassword: '', confirmPassword: '' };

function PasswordCard() {
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: EMPTY_PASSWORDS,
  });

  // 离开页面时清掉密码框（cacheComponents 会保留 state，tech-stack 2）
  const { reset } = form;
  useLayoutEffect(() => () => reset(EMPTY_PASSWORDS), [reset]);

  async function onSubmit({ currentPassword, newPassword }: PasswordValues) {
    // R26.8：其他设备的 session 退出，当前这个换成新 session（cookie 由 /api/auth 写回）
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (error) {
      if (error.code === 'INVALID_PASSWORD') {
        form.setError('currentPassword', { message: '当前密码不对' }, { shouldFocus: true });
      } else {
        toast.error('没成功，请稍后再试');
      }
      return;
    }
    form.reset(EMPTY_PASSWORDS);
    toast.success('密码改好了');
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>改密码</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>当前密码</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPassword"
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
            <p className="text-sm text-muted-foreground">改好以后，其他设备上的登录会退出。</p>
            <div>
              <Button type="submit" loading={submitting}>
                改密码
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
