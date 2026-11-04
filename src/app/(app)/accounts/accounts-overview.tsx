import { Clock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { BANK_LABELS } from '@/lib/accounts/account-input';
import { ACCOUNT_PURPOSE_LABELS, type AccountsOverview as Overview } from '@/lib/rules/balance';
import { formatAud } from '@/lib/rules/money';
import type { AccountBalance } from '@/server/balances';
import type { AccountConditionProgress } from '@/server/conditions';
import { CalibrateButton } from './calibrate-dialog';
import { ConditionHistory } from './condition-history';
import { ConditionProgress } from './condition-progress';
import { formatDiff } from './format-diff';

// R23.5 账户总览：顶部合计、按用途分组、每个账户一张卡片
// 合计都是可用余额，只算有锚点的账户（groupByPurpose）
// R24.10 有条件的账户卡片下面加"本月条件"和历史

const SOURCE_LABELS: Record<NonNullable<AccountBalance['anchorSource']>, string> = {
  pdf: '对账单期末',
  manual: '手动填的',
};

type Props = {
  overview: Overview<AccountBalance>;
  conditions: Map<string, AccountConditionProgress>; // 按账户 id，没条件的账户没有 key
  today: string;
};

export function AccountsOverview({ overview, conditions, today }: Props) {
  return (
    <>
      <Card className="min-w-0 gap-1 p-4 lg:p-5">
        <h2 className="text-sm text-muted-foreground">所有账户合计</h2>
        <p className="text-xl font-semibold tabular-nums sm:text-2xl">
          {formatAud(overview.availableCents)}
        </p>
        {overview.hasPending && (
          <Sub>
            入账合计 <span className="tabular-nums">{formatAud(overview.postedCents)}</span>
          </Sub>
        )}
        {overview.missingCount > 0 && (
          <Sub>不含 {overview.missingCount} 个还没有余额的账户</Sub>
        )}
      </Card>

      {overview.groups.map((g) => (
        <section
          key={g.purpose}
          aria-label={ACCOUNT_PURPOSE_LABELS[g.purpose]}
          className="flex flex-col gap-3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">{ACCOUNT_PURPOSE_LABELS[g.purpose]}</h2>
            <span className="font-medium tabular-nums">{formatAud(g.availableCents)}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:gap-4 xl:grid-cols-3">
            {g.accounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                conditions={conditions.get(a.id) ?? null}
                today={today}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function AccountCard({
  account: a,
  conditions,
  today,
}: {
  account: AccountBalance;
  conditions: AccountConditionProgress | null;
  today: string;
}) {
  const b = a.balance;
  const diff = a.lastCalibrationDiffCents;
  return (
    <Card className="min-w-0 gap-1 p-4 lg:p-5">
      <h3 className="truncate font-medium">{a.name}</h3>
      <Sub>
        {BANK_LABELS[a.bank]}
        {a.numberSuffix && ` · ••${a.numberSuffix}`}
      </Sub>

      {b === null ? (
        // R23.1：没有锚点不从 0 累加，"填一次余额"走校准对话框
        <p className="pt-2 text-sm text-muted-foreground">还没有余额，填一次</p>
      ) : (
        <>
          <p className="pt-2 text-xl font-semibold tabular-nums sm:text-2xl">
            {formatAud(b.availableCents)}
          </p>
          {/* R23.2：有 pending 时大字是可用余额，小字是入账余额 */}
          {b.pendingCount > 0 && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                入账 <span className="tabular-nums">{formatAud(b.postedCents)}</span>，含{' '}
                <span className="tabular-nums">{b.pendingCount}</span> 笔待确认{' '}
                <span className="tabular-nums">{formatAud(b.pendingCents)}</span>
              </span>
            </p>
          )}
          <Sub>
            截至 <span className="tabular-nums">{b.asOf}</span>
            {a.anchorSource && ` · ${SOURCE_LABELS[a.anchorSource]}`}
          </Sub>
          {/* R23.3：只看最近一次手动校准，差额是 0 不显示 */}
          {diff !== null && diff !== 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              上次校准差 <span className="tabular-nums">{formatDiff(diff)}</span>
            </p>
          )}
        </>
      )}

      <div className="mt-auto flex flex-col gap-3 pt-3">
        {conditions !== null && (
          <>
            <ConditionProgress progress={conditions} />
            <ConditionHistory progress={conditions} />
          </>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t pt-3 text-xs">
          <dt className="text-muted-foreground">关联账户</dt>
          <dd className="truncate text-right">
            {a.linkedAccount === null
              ? '—'
              : `${a.linkedAccount.name}${a.linkedAccount.isArchived ? '（已归档）' : ''}`}
          </dd>
          <dt className="text-muted-foreground">本财年利息</dt>
          <dd className="text-right tabular-nums">{formatAud(a.interestCents)}</dd>
        </dl>
        <div className="flex justify-end">
          <CalibrateButton account={a} today={today} />
        </div>
      </div>
    </Card>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="truncate text-xs text-muted-foreground">{children}</p>;
}
