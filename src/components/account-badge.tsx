'use client';

// M13-12 账户标识：银行方块、用途标签、第二行（尾号 · 类型 · 归属人）
// 账户卡片用全套；流水、筛选、导入页只用 AccountLabel（20px 方块 + 名字）
import { createContext, useContext } from 'react';
import {
  ArrowLeftRight,
  Banknote,
  Coins,
  CreditCard,
  Landmark,
  PiggyBank,
  ShieldCheck,
  Target,
  Users,
  Vault,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { ACCOUNT_TYPE_LABELS, BANK_LABELS, type AccountType } from '@/lib/accounts/account-input';
import { ACCOUNT_PURPOSE_LABELS, type AccountPurpose } from '@/lib/rules/balance';
import { cn } from '@/lib/utils';

// ---------- 银行方块 ----------

// { bank: '/banks/anz.svg' }，在 (app)/layout.tsx 用 getBankLogos() 查好放进来
const BankLogosContext = createContext<Record<string, string>>({});

export function BankLogosProvider({
  logos,
  children,
}: {
  logos: Record<string, string>;
  children: React.ReactNode;
}) {
  return <BankLogosContext value={logos}>{children}</BankLogosContext>;
}

// 没有 logo 时的字母方块。key 用 string：westpac、boq、ing 等 M9.5-7 / M9.6 加了枚举值就生效
// 底色都是固定深色配白字（cba 黄底配黑字），暗色模式下不变也看得清
type Fallback = { className: string; text?: string; icon?: LucideIcon };
const FALLBACKS: Record<string, Fallback> = {
  anz: { className: 'bg-blue-600 text-white', text: 'ANZ' },
  anz_plus: { className: 'bg-blue-900 text-white', text: 'ANZ+' },
  cba: { className: 'bg-yellow-400 text-black', text: 'CBA' },
  westpac: { className: 'bg-red-600 text-white', text: 'W' },
  boq: { className: 'bg-purple-900 text-white', text: 'BOQ' },
  ing: { className: 'bg-orange-500 text-white', text: 'ING' },
  cash: { className: 'bg-green-600 text-white', icon: Banknote },
  other: { className: 'bg-gray-500 text-white', icon: Landmark },
};

const SIZES = {
  sm: { box: 'size-5 rounded-[4px]', text: 'text-[7px]', icon: 'size-3' },
  md: { box: 'size-8 rounded-md', text: 'text-[10px]', icon: 'size-4.5' },
};

export function BankMark({
  bank,
  size = 'sm',
  className,
}: {
  bank: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const logo = useContext(BankLogosContext)[bank];
  const label = (BANK_LABELS as Record<string, string>)[bank] ?? bank;
  const s = SIZES[size];
  if (logo) {
    return (
      // logo 是 public/ 里的小图，svg 和 png 都直接显示，不走 next/image
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt={label}
        title={label}
        className={cn(s.box, 'shrink-0 object-contain', className)}
      />
    );
  }
  const f = FALLBACKS[bank] ?? FALLBACKS.other;
  const Icon = f.icon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        s.box,
        'inline-flex shrink-0 items-center justify-center font-bold leading-none tracking-tight',
        f.className,
        className,
      )}
    >
      {Icon ? <Icon className={s.icon} /> : <span className={s.text}>{f.text}</span>}
    </span>
  );
}

// 流水、筛选、导入页：小方块 + 名字
export function AccountLabel({
  bank,
  name,
  className,
}: {
  bank: string;
  name: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <BankMark bank={bank} />
      <span className="truncate">{name}</span>
    </span>
  );
}

// ---------- 用途标签（R23.4） ----------

// bills 不再可选，已有的照旧显示"账单"、灰色、不带图标
const PURPOSE_STYLES: Record<AccountPurpose, { className: string; icon?: LucideIcon }> = {
  everyday: { className: 'bg-muted text-muted-foreground', icon: Wallet },
  bills: { className: 'bg-muted text-muted-foreground' },
  emergency: {
    className: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    icon: ShieldCheck,
  },
  savings: {
    className: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
    icon: PiggyBank,
  },
  goal: {
    className: 'bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300',
    icon: Target,
  },
};

export function PurposeTag({ purpose }: { purpose: AccountPurpose }) {
  const p = PURPOSE_STYLES[purpose];
  const Icon = p.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        p.className,
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {ACCOUNT_PURPOSE_LABELS[purpose]}
    </span>
  );
}

// ---------- 第二行：尾号 · 类型 · 归属人 ----------

const TYPE_ICONS: Record<AccountType, LucideIcon> = {
  everyday: ArrowLeftRight,
  savings: Vault,
  credit_card: CreditCard,
  joint: Users,
  cash: Coins,
};

export function AccountMeta({
  numberSuffix,
  type,
  memberName,
}: {
  numberSuffix: string | null;
  type: AccountType;
  memberName: string; // 默认归属人
}) {
  const TypeIcon = TYPE_ICONS[type];
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {numberSuffix && (
        <>
          <span className="tabular-nums">••{numberSuffix}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span className="inline-flex min-w-0 items-center gap-1">
        <TypeIcon className="size-3.5 shrink-0" />
        <span className="truncate">{ACCOUNT_TYPE_LABELS[type]}</span>
      </span>
      <span aria-hidden>·</span>
      <MemberAvatar name={memberName} />
    </p>
  );
}

// 名字的第一个字：Johnson → J、Iris → I、共同 → 共
function MemberAvatar({ name }: { name: string }) {
  const initial = Array.from(name)[0]?.toUpperCase() ?? '?';
  return (
    <span
      role="img"
      aria-label={`归属人 ${name}`}
      title={name}
      className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground"
    >
      {initial}
    </span>
  );
}
