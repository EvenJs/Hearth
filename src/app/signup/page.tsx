import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: '注册 · Hearth',
};

// 设计图 17（不出图，照 01 登录页做）。F15 / R26.4：有邀请码才能注册
// 邀请链接带 ?code= 时自动填码
export default function SignupPage(props: PageProps<'/signup'>) {
  return (
    <AuthShell title="注册">
      {/* 读 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<SignupForm initialCode="" />}>
        <SignupSection searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function SignupSection({
  searchParams,
}: {
  searchParams: PageProps<'/signup'>['searchParams'];
}) {
  const { code } = await searchParams;
  const initialCode = (Array.isArray(code) ? code[0] : code)?.trim() ?? '';
  // URL 上的码变了（点了另一个邀请链接）时重新挂载，表单跟着换码
  return <SignupForm key={initialCode} initialCode={initialCode.slice(0, 100)} />;
}
