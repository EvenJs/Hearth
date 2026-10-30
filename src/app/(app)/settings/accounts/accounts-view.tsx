'use client';

import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ACCOUNT_TYPE_LABELS, BANK_LABELS } from '@/lib/accounts/account-input';
import { canImportCsv, canImportStatement } from '@/lib/import/banks';
import type { Account } from '@/server/accounts';
import type { Card } from '@/server/cards';
import type { Member } from '@/server/members';
import { AccountForm } from './account-form';
import { setAccountArchivedAction } from './actions';
import { CardsSection } from './cards-section';

type Props = {
  accounts: Account[];
  cards: Card[];
  members: Member[];
  showArchived: boolean;
};

// 流水来源（R1、R1C、R1D）
function sourceLabel(bank: Account['bank']): string | null {
  if (canImportCsv(bank)) return canImportStatement(bank) ? 'CSV / 对账单' : 'CSV 导入';
  if (canImportStatement(bank)) return 'PDF 对账单';
  return null;
}

// R1D：ANZ Plus 导对账单要按尾号认账户
function needsSuffix(a: Account): boolean {
  return a.bank === 'anz_plus' && !a.numberSuffix;
}

// editing：null = 关闭；'new' = 新建；Account = 编辑
type Editing = null | 'new' | Account;

export function AccountsView({ accounts, cards, members, showArchived }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [pending, startTransition] = useTransition();

  function setArchived(account: Account, archived: boolean) {
    startTransition(async () => {
      const result = await setAccountArchivedAction(account.id, archived);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (archived) {
        toast.success(`已归档「${account.name}」`, {
          action: { label: '撤销', onClick: () => setArchived(account, false) },
        });
      } else {
        toast.success(`已恢复「${account.name}」`);
      }
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="link" size="sm" className="px-0" asChild>
          <Link href={showArchived ? '/settings/accounts' : '/settings/accounts?archived=1'}>
            {showArchived ? '隐藏已归档' : '显示已归档'}
          </Link>
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          新增账户
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没有账户，点「新增账户」建一个。
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="hidden md:table-cell">银行</TableHead>
                <TableHead className="hidden md:table-cell">类型</TableHead>
                <TableHead>默认归属人</TableHead>
                <TableHead className="hidden md:table-cell">尾号</TableHead>
                <TableHead className="hidden md:table-cell">流水来源</TableHead>
                <TableHead className="w-0 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id} className={a.isArchived ? 'text-muted-foreground' : undefined}>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {a.name}
                      {a.isArchived && <Badge variant="outline">已归档</Badge>}
                    </div>
                    {/* 手机上隐藏了银行、类型、尾号列，放在名称下面 */}
                    <div className="text-xs text-muted-foreground md:hidden">
                      {BANK_LABELS[a.bank]} · {ACCOUNT_TYPE_LABELS[a.type]}
                      {a.numberSuffix && ` · ••${a.numberSuffix}`}
                      {needsSuffix(a) && <span className="text-amber-600"> · 先填尾号</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{BANK_LABELS[a.bank]}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {ACCOUNT_TYPE_LABELS[a.type]}
                  </TableCell>
                  <TableCell>{a.defaultMemberName}</TableCell>
                  <TableCell className="hidden font-mono md:table-cell">
                    {a.numberSuffix ? `••${a.numberSuffix}` : '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {sourceLabel(a.bank) ? (
                        <Badge variant="secondary">{sourceLabel(a.bank)}</Badge>
                      ) : (
                        <Badge variant="outline">手动录入</Badge>
                      )}
                      {needsSuffix(a) && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/50 text-amber-700 dark:text-amber-400"
                          title="导入 PDF 对账单时按尾号认账户"
                        >
                          先填尾号
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`编辑 ${a.name}`}
                        onClick={() => setEditing(a)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={a.isArchived ? `恢复 ${a.name}` : `归档 ${a.name}`}
                        title={a.isArchived ? '恢复' : '归档'}
                        disabled={pending}
                        onClick={() => setArchived(a, !a.isArchived)}
                      >
                        {a.isArchived ? <ArchiveRestore /> : <Archive />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{editing === 'new' ? '新增账户' : '编辑账户'}</SheetTitle>
            <SheetDescription>
              银行决定怎么导入：ANZ 可以导 CSV 和 PDF 对账单，CBA 导 CSV，ANZ Plus 只能导 PDF
              对账单，其他只能手动录入。
            </SheetDescription>
          </SheetHeader>
          {editing !== null && (
            <AccountForm
              // 切换编辑对象时重置表单
              key={editing === 'new' ? 'new' : editing.id}
              account={editing === 'new' ? null : editing}
              members={members}
              onDone={() => setEditing(null)}
            />
          )}
          {editing !== null && editing !== 'new' && (
            <CardsSection
              key={`cards-${editing.id}`}
              accountId={editing.id}
              cards={cards.filter((c) => c.accountId === editing.id)}
              members={members}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
