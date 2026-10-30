'use client';

// 设置 → 税务（设计图 11，R14.3、R14.6、R14.7）。只按人，不做家庭合计
// 上面每人一张表单（全年工资税前总额、雇主已代扣的税），下面只读的估算表
// 已预缴只从 Tax (ATO) 拆分算，不能手填（R14.6）
import { Info, Loader2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { HouseholdTax, PersonTax } from '@/server/tax';
import { saveTaxProfileAction } from './actions';

type LoadedTax = Extract<HouseholdTax, { missingRates: null }>;

type Props = {
  years: { value: number; label: string }[]; // 有税率表的财年，从新到旧（R14.7）
  missingRates: string | null; // 今天所在的财年没有税率表时是 "2027-28"
  tax: LoadedTax | null; // null：一个有表的财年都没有
};

// 分 → 输入框里的元，972000 → "9720.00"。只用整数运算
function centsToInput(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// 估算表里减掉的两行显示成负数；0 不显示成 -$0.00
function minus(cents: number): string {
  return formatAud(cents === 0 ? 0 : -cents);
}

export function TaxView({ years, missingRates, tax }: Props) {
  const router = useRouter();
  const [switching, startSwitching] = useTransition();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={tax ? String(tax.financialYear) : undefined}
          onValueChange={(v) => startSwitching(() => router.push(`/settings/tax?fy=${v}`))}
          disabled={years.length === 0}
        >
          <SelectTrigger className="w-40" aria-label="财年">
            <SelectValue placeholder="没有税率表" />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y.value} value={String(y.value)}>
                {y.label} 财年
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {switching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {missingRates && (
        <Notice tone="warn">
          缺 {missingRates} 税率表，去 <code>src/lib/tax/rates.ts</code> 加上
        </Notice>
      )}

      <Notice tone="info">
        只是估算，不是税务建议。没有算业务开支抵扣、各种 offset、Medicare levy
        低收入减免，所以结果偏保守（偏高）。实际以 ATO 和会计为准。
      </Notice>

      {tax?.taxCategoryMissing && (
        <Notice tone="warn">找不到 Income / Tax (ATO) 分类，已预缴按 0 算</Notice>
      )}

      {tax && tax.persons.length === 0 && (
        <p className="text-sm text-muted-foreground">没有可以填工资的归属人（kind = person）。</p>
      )}

      {tax && tax.persons.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {tax.persons.map((p) => (
              // 换财年或保存后 updatedAt 变了，表单重新初始化，不留旧值（cacheComponents 的 Activity）
              <ProfileForm
                key={`${tax.financialYear}:${p.member.id}:${p.profile?.updatedAt.getTime() ?? 'none'}`}
                financialYear={tax.financialYear}
                person={p}
              />
            ))}
          </div>

          <EstimateTable persons={tax.persons} />
        </>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <div
      role={tone === 'warn' ? 'alert' : undefined}
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'warn'
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function ProfileForm({ financialYear, person }: { financialYear: number; person: PersonTax }) {
  const { member, profile } = person;
  const [gross, setGross] = useState(profile ? centsToInput(profile.paygGrossCents) : '');
  const [withheld, setWithheld] = useState(profile ? centsToInput(profile.paygWithheldCents) : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = (field: string) => `tax-${member.id}-${field}`;

  function save() {
    if (gross.trim() === '' || withheld.trim() === '') {
      setError('两个金额都要填，没有就填 0');
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await saveTaxProfileAction({
        memberId: member.id,
        financialYear,
        paygGross: gross,
        paygWithheld: withheld,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success(`${member.name} 的工资信息已保存`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{member.name}</CardTitle>
        {!profile && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            还没填，估算按工资 0 算
          </p>
        )}
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <MoneyField
            id={id('gross')}
            label="全年工资税前总额"
            hint="来自工资单或 myGov income statement"
            value={gross}
            onChange={setGross}
          />
          <MoneyField
            id={id('withheld')}
            label="雇主已代扣的税"
            hint="年度累计 PAYG withheld"
            value={withheld}
            onChange={setWithheld}
          />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MoneyField(props: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
          $
        </span>
        <Input
          id={props.id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="pl-6 tabular-nums"
        />
      </div>
      <p className="text-xs text-muted-foreground">{props.hint}</p>
    </div>
  );
}

type Row = { label: string; value: (p: PersonTax) => string; strong?: boolean };

// R14.3 的顺序；已代扣和已预缴分开列（R14.6）
const ROWS: Row[] = [
  { label: '工资', value: (p) => formatAud(p.profile?.paygGrossCents ?? 0) },
  { label: '税前收入', value: (p) => formatAud(p.estimate.preTaxIncomeCents) },
  { label: '应纳税收入', value: (p) => formatAud(p.estimate.taxableDollars * 100), strong: true },
  { label: '预计所得税', value: (p) => formatAud(p.estimate.incomeTaxCents) },
  { label: 'Medicare levy 2%', value: (p) => formatAud(p.estimate.medicareCents) },
  { label: '预计总税额', value: (p) => formatAud(p.estimate.totalCents), strong: true },
  { label: '已代扣', value: (p) => minus(p.estimate.paygWithheldCents) },
  { label: '已预缴 (ATO)', value: (p) => minus(p.estimate.prepaidCents) },
];

function EstimateTable({ persons }: { persons: PersonTax[] }) {
  return (
    <Card className="gap-0 py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">估算</TableHead>
            {persons.map((p) => (
              <TableHead key={p.member.id} className="px-4 text-right">
                {p.member.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((row) => (
            <TableRow key={row.label} className={cn(row.strong && 'font-medium')}>
              <TableCell className="px-4 whitespace-normal">{row.label}</TableCell>
              {persons.map((p) => (
                <TableCell key={p.member.id} className="px-4 text-right tabular-nums">
                  {row.value(p)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow className="bg-muted/50 font-semibold hover:bg-muted/50">
            <TableCell className="px-4 whitespace-normal">预计年底补税</TableCell>
            {persons.map((p) => {
              const owing = p.estimate.owingCents;
              return (
                <TableCell
                  key={p.member.id}
                  className={cn('px-4 text-right tabular-nums', owing > 0 && 'text-destructive')}
                >
                  {formatAud(owing)}
                  {owing < 0 && (
                    <span className="block text-xs font-normal text-muted-foreground">预计退税</span>
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        </TableBody>
      </Table>
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Home 名下的税前收入两人平分
      </p>
    </Card>
  );
}
