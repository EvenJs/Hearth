'use client';

// 设置 → 税务（设计图 11，R14.3、R14.6、R14.7、R14.9、R14.10）。只按人，不做家庭合计
// 每人一张卡片：上面在职段列表（R14.9，新增 / 编辑用对话框，删除要确认），下面"实际数（可选）"
// 工资总额、已代扣、预计全年利息三格都可以空，空的用折算 / 已到账。最下面只读的估算表
// 已预缴只从 Tax (ATO) 拆分算，不能手填（R14.6）；实际数填过的可以清除（R14.8）
import { Info, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import type { HouseholdTax, PersonTax, TaxJobRow } from '@/server/tax';
import {
  createTaxJobAction,
  deleteTaxJobAction,
  deleteTaxProfileAction,
  saveTaxProfileAction,
  updateTaxJobAction,
} from './actions';

type LoadedTax = Extract<HouseholdTax, { missingRates: null }>;

type Props = {
  years: { value: number; label: string }[]; // 有税率表的财年，从新到旧（R14.7）
  missingRates: string | null; // 今天所在的财年没有税率表时是 "2027-28"
  tax: LoadedTax | null; // null：一个有表的财年都没有
};

// 分 → 输入框里的元，972000 → "9720.00"。只用整数运算
// 空 = 没填实际数（M14-3），输入框留空
function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// 估算表里减掉的两行显示成负数；0 不显示成 -$0.00
function minus(cents: number): string {
  return formatAud(cents === 0 ? 0 : -cents);
}

// R14.9 删除确认和列表里用的名字
function jobName(job: TaxJobRow): string {
  return job.employer ?? '这份工作';
}

function jobRange(job: TaxJobRow): string {
  return `${job.startDate} 到 ${job.endDate ?? '现在'}`;
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
          <SelectTrigger className="w-40" loading={switching} aria-label="财年">
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
              <PersonCard
                key={`${tax.financialYear}:${p.member.id}`}
                financialYear={tax.financialYear}
                yearLabel={
                  years.find((y) => y.value === tax.financialYear)?.label ??
                  String(tax.financialYear)
                }
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

function PersonCard({
  financialYear,
  yearLabel,
  person,
}: {
  financialYear: number;
  yearLabel: string; // "2026-27"
  person: PersonTax;
}) {
  const { member, profile, estimate } = person;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{member.name}</CardTitle>
        {/* R14.6：这个财年没有在职段落进来、工资总额也没填 */}
        {!estimate.hasSalaryInfo && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            还没填工资，估算按工资 0 算
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <JobList person={person} yearLabel={yearLabel} />
        {/* 换财年或保存后 updatedAt 变了，表单重新初始化，不留旧值（cacheComponents 的 Activity） */}
        <ActualForm
          key={profile?.updatedAt.getTime() ?? 'none'}
          financialYear={financialYear}
          yearLabel={yearLabel}
          person={person}
        />
      </CardContent>
    </Card>
  );
}

// ---------- 在职段（R14.9） ----------

type JobDialogState =
  | { kind: 'edit'; job: TaxJobRow | null } // null = 新增
  | { kind: 'delete'; job: TaxJobRow };

// 列出这个人的全部在职段：一段工作跨财年只存一行，改和删会影响所有财年，所以不在这个财年的也列（灰色）
function JobList({ person, yearLabel }: { person: PersonTax; yearLabel: string }) {
  const { member, jobs } = person;
  const [dialog, setDialog] = useState<JobDialogState | null>(null);
  // 离开页面时关掉对话框（cacheComponents 的 Activity，tech-stack 2）
  useLayoutEffect(() => () => setDialog(null), []);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">在职段</h3>
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有在职段。填年薪和入职日期，自动折算到财年底。</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {jobs.map(({ job, days, grossCents, withheldCents }) => (
            <li
              key={job.id}
              className={cn('flex items-start gap-2 px-3 py-2', days === 0 && 'text-muted-foreground')}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                <p className="truncate font-medium">{jobName(job)}</p>
                <p className="text-xs text-muted-foreground">
                  年薪 <span className="tabular-nums">{formatAud(job.annualSalaryCents)}</span> ·{' '}
                  {jobRange(job)}
                </p>
                <p className="text-xs">
                  {days === 0 ? (
                    `不在 ${yearLabel} 财年`
                  ) : (
                    <>
                      {yearLabel} 折算 {days} 天：工资{' '}
                      <span className="tabular-nums">{formatAud(grossCents)}</span>，已代扣{' '}
                      <span className="tabular-nums">{formatAud(withheldCents)}</span>
                    </>
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`编辑 ${jobName(job)}`}
                onClick={() => setDialog({ kind: 'edit', job })}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`删除 ${jobName(job)}`}
                onClick={() => setDialog({ kind: 'delete', job })}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDialog({ kind: 'edit', job: null })}
        >
          <Plus />
          新增在职段
        </Button>
      </div>

      {dialog?.kind === 'edit' && (
        <JobDialog
          memberId={member.id}
          memberName={member.name}
          job={dialog.job}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteJobDialog
          memberName={member.name}
          job={dialog.job}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

// 新增 / 编辑在职段。年薪 > 0、结束不早于开始在 src/server/tax.ts 里检查，报错显示在对话框里，不关
function JobDialog(props: {
  memberId: string;
  memberName: string;
  job: TaxJobRow | null; // null = 新增
  onClose: () => void;
}) {
  const { job } = props;
  const [employer, setEmployer] = useState(job?.employer ?? '');
  const [salary, setSalary] = useState(centsToInput(job?.annualSalaryCents));
  const [startDate, setStartDate] = useState(job?.startDate ?? '');
  const [endDate, setEndDate] = useState(job?.endDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = (field: string) => `job-${props.memberId}-${field}`;

  function save() {
    if (salary.trim() === '' || startDate === '') {
      setError('年薪和开始日期要填');
      return;
    }
    setError(null);
    startTransition(async () => {
      const fields = { employer, annualSalary: salary, startDate, endDate };
      const r = job
        ? await updateTaxJobAction({ ...fields, id: job.id })
        : await createTaxJobAction({ ...fields, memberId: props.memberId });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success(job ? '在职段已修改' : '在职段已新增');
      props.onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {job ? '修改' : '新增'} {props.memberName} 的在职段
            </DialogTitle>
            <DialogDescription>
              按年薪和在职天数折算到财年底，跨财年的工作只填一次。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={id('employer')}>雇主（可选）</Label>
            <Input
              id={id('employer')}
              autoComplete="off"
              maxLength={100}
              value={employer}
              onChange={(e) => setEmployer(e.target.value)}
            />
          </div>
          <MoneyField
            id={id('salary')}
            label="年薪"
            hint="税前，不含 super"
            value={salary}
            onChange={setSalary}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor={id('start')}>开始日期</Label>
              <Input
                id={id('start')}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={id('end')}>结束日期</Label>
              <Input
                id={id('end')}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">结束日期留空 = 还在职</p>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={props.onClose}>
              取消
            </Button>
            <Button type="submit" loading={pending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// R14.9：删除要确认，文字照规则
function DeleteJobDialog(props: { memberName: string; job: TaxJobRow; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await deleteTaxJobAction({ id: props.job.id });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success('在职段已删除');
      props.onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            删除 {props.memberName} 的在职段 {jobName(props.job)}（{jobRange(props.job)}）？
          </AlertDialogTitle>
          <AlertDialogDescription>所有财年的折算都会变。</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            取消
          </AlertDialogCancel>
          <Button type="button" variant="destructive" loading={pending} onClick={remove}>
            删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------- 实际数（R14.3、R14.10） ----------

// 三格都可以空：空的工资、已代扣用 R14.9 折算，空的利息只算已到账。输入框灰字显示会用的那个数
function ActualForm({
  financialYear,
  yearLabel,
  person,
}: {
  financialYear: number;
  yearLabel: string;
  person: PersonTax;
}) {
  const { member, profile, jobs, estimate } = person;
  const [gross, setGross] = useState(centsToInput(profile?.paygGrossCents));
  const [withheld, setWithheld] = useState(centsToInput(profile?.paygWithheldCents));
  const [interest, setInterest] = useState(centsToInput(profile?.expectedInterestCents));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  // 离开页面时关掉清除确认（cacheComponents 的 Activity，tech-stack 2）
  useLayoutEffect(() => () => setConfirming(false), []);
  const id = (field: string) => `tax-${member.id}-${field}`;

  // R14.9：每份工作分别取整再加，和列表里的数对得上
  const proratedGross = jobs.reduce((a, j) => a + j.grossCents, 0);
  const proratedWithheld = jobs.reduce((a, j) => a + j.withheldCents, 0);

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await saveTaxProfileAction({
        memberId: member.id,
        financialYear,
        paygGross: gross,
        paygWithheld: withheld,
        expectedInterest: interest,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success(`${member.name} 的实际数已保存`);
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">实际数（可选）</h3>
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
          hint="来自工资单或 myGov income statement。留空用折算"
          placeholder={centsToInput(proratedGross)}
          value={gross}
          onChange={setGross}
        />
        <MoneyField
          id={id('withheld')}
          label="雇主已代扣的税"
          hint="年度累计 PAYG withheld。留空用折算"
          placeholder={centsToInput(proratedWithheld)}
          value={withheld}
          onChange={setWithheld}
        />
        <MoneyField
          id={id('interest')}
          label="预计全年利息"
          hint="留空只算已到账的利息；填了按预计和已到账里大的算"
          placeholder={centsToInput(estimate.interestReceivedCents)}
          value={interest}
          onChange={setInterest}
        />

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {profile && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              清除
            </Button>
          )}
          <Button type="submit" loading={pending}>
            保存
          </Button>
        </div>
      </form>

      {confirming && (
        <ClearDialog
          memberId={member.id}
          memberName={member.name}
          financialYear={financialYear}
          yearLabel={yearLabel}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

// R14.8：删掉这一行 tax_profile，在职段不动。成功后 updatedAt 变成 none，ActualForm 的 key 变了会自己重建成空表单
function ClearDialog(props: {
  memberId: string;
  memberName: string;
  financialYear: number;
  yearLabel: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function clear() {
    setError(null);
    startTransition(async () => {
      const r = await deleteTaxProfileAction({
        memberId: props.memberId,
        financialYear: props.financialYear,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success(`已清除 ${props.memberName} 的实际数`);
      props.onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            清除 {props.memberName} {props.yearLabel} 财年的实际数？
          </AlertDialogTitle>
          <AlertDialogDescription>
            工资总额、已代扣、预计全年利息一起清。清除后工资和已代扣用在职段折算，利息只算已到账。在职段不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            取消
          </AlertDialogCancel>
          <Button type="button" variant="destructive" loading={pending} onClick={clear}>
            清除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MoneyField(props: {
  id: string;
  label: string;
  hint: string;
  placeholder?: string;
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
          placeholder={props.placeholder ?? '0.00'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="pl-6 tabular-nums"
        />
      </div>
      <p className="text-xs text-muted-foreground">{props.hint}</p>
    </div>
  );
}

// ---------- 估算表 ----------

type Row = {
  label: string;
  value: (p: PersonTax) => string;
  tag?: (p: PersonTax) => string; // R14.6：折算 / 实际、预计 / 已到账
  strong?: boolean;
  sub?: boolean; // 上一行里的一部分，缩进
};

const SOURCE_TAG = { prorated: '折算', actual: '实际' } as const;
const INTEREST_TAG = { expected: '预计', received: '已到账' } as const;

// R14.3 的顺序；已代扣和已预缴分开列（R14.6）
const ROWS: Row[] = [
  {
    label: '工资',
    value: (p) => formatAud(p.estimate.paygGrossCents),
    tag: (p) => SOURCE_TAG[p.estimate.paygGrossSource],
  },
  { label: '税前收入', value: (p) => formatAud(p.estimate.preTaxIncomeCents) },
  {
    label: '其中利息',
    value: (p) => formatAud(p.estimate.interestCents),
    tag: (p) => INTEREST_TAG[p.estimate.interestSource],
    sub: true,
  },
  { label: '应纳税收入', value: (p) => formatAud(p.estimate.taxableDollars * 100), strong: true },
  { label: '预计所得税', value: (p) => formatAud(p.estimate.incomeTaxCents) },
  { label: 'Medicare levy 2%', value: (p) => formatAud(p.estimate.medicareCents) },
  { label: '预计总税额', value: (p) => formatAud(p.estimate.totalCents), strong: true },
  {
    label: '已代扣',
    value: (p) => minus(p.estimate.paygWithheldCents),
    tag: (p) => SOURCE_TAG[p.estimate.paygWithheldSource],
  },
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
              <TableCell
                className={cn(
                  'px-4 whitespace-normal',
                  row.sub && 'pl-8 text-muted-foreground',
                )}
              >
                {row.label}
              </TableCell>
              {persons.map((p) => (
                <TableCell key={p.member.id} className="px-4 text-right tabular-nums">
                  {row.value(p)}
                  {row.tag && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {row.tag(p)}
                    </span>
                  )}
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
