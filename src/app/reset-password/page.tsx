import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { ResetForm } from './reset-form';

export const metadata: Metadata = {
  title: '重置密码 · Hearth',
};

// 设计图 19（不出图，照 01 登录页做）。R26.8
// 邮件里的链接先到 Better Auth 查 token，有效跳这里带 ?token=，过期或用过带 ?error=INVALID_TOKEN
export default function ResetPasswordPage(props: PageProps<'/reset-password'>) {
  return (
    <AuthShell title="重置密码">
      {/* 读 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <ResetSection searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function ResetSection({
  searchParams,
}: {
  searchParams: PageProps<'/reset-password'>['searchParams'];
}) {
  const { token, error } = await searchParams;
  const value = typeof token === 'string' && !error ? token : null;
  // 换链接时重新挂载，不沿用上一个链接的状态
  return <ResetForm key={value ?? ''} token={value} />;
}
