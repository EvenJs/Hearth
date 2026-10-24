import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';

// 看板在 M5 做（设计图 02）。现在只有临时的数据访问检查
export default function HomePage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">看板</h1>
      {/* M1-4 临时验证：数据访问层能查到归属人和分类。M5 做看板时删掉 */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <DataAccessCheck />
      </Suspense>
    </>
  );
}

async function DataAccessCheck() {
  const ctx = await getHouseholdContext();
  const [members, tree] = await Promise.all([listMembers(ctx), listCategoryTree(ctx)]);
  const normal = tree.filter((c) => c.kind !== 'system');
  const system = tree.filter((c) => c.kind === 'system');

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>归属人（{members.length}）</CardTitle>
          <CardDescription>临时验证用</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {members.map((m) => (
              <li key={m.id}>
                {m.name} <span className="text-muted-foreground">· {m.kind}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>一级分类（{normal.length}）</CardTitle>
          <CardDescription>括号里是二级分类数量</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {normal.map((c) => (
              <li key={c.id}>
                {c.nameEn}{' '}
                <span className="text-muted-foreground">
                  · {c.kind}（{c.children.length}）
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>系统分类（{system.length}）</CardTitle>
          <CardDescription>内部转账、取现、银行费用、未分类</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {system.map((c) => (
              <li key={c.id}>
                {c.nameEn} <span className="text-muted-foreground">· {c.systemKey}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
