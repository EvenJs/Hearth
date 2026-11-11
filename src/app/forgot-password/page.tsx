import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { ForgotForm } from './forgot-form';

export const metadata: Metadata = {
  title: '忘记密码 · Hearth',
};

// 设计图 18（不出图，照 01 登录页做）。R26.8：填邮箱发重置链接
export default function ForgotPasswordPage() {
  return (
    <AuthShell title="忘记密码">
      <ForgotForm />
    </AuthShell>
  );
}
