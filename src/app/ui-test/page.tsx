import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToastButton } from './toast-button';

// M0-3 临时测试页：确认 shadcn/ui 组件能正常渲染，后面做正式页面时删掉
export default function UiTestPage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">组件测试</h1>

      <section className="flex flex-wrap gap-3">
        <Button>保存</Button>
        <Button variant="secondary">取消</Button>
        <Button variant="outline">导入 CSV</Button>
        <Button variant="destructive">删除</Button>
        <Button variant="ghost">更多</Button>
        <ToastButton />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>本月支出</CardTitle>
            <CardDescription>2026 年 10 月</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">$3,482.15</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>快速录入</CardTitle>
            <CardDescription>现金和随手记的消费</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Label htmlFor="amount">金额</Label>
            <Input id="amount" inputMode="decimal" placeholder="0.00" />
          </CardContent>
          <CardFooter>
            <Button className="w-full">记一笔</Button>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
