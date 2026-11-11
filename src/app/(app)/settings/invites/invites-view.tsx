'use client';

// 设置 → 邀请（M12-6）。上面"发邀请码"对话框（R26.2），下面自己发过的码（R26.3）
// 电脑上表格，手机上卡片，照规则设置页
// 码和链接复制出来都带横杠（R26.1），注册页会自己整理
import { Copy, Loader2, Plus } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { formatInviteCode, type InvitePurpose, type InviteStatus } from '@/lib/rules/invite';
import { cn } from '@/lib/utils';
import type { InviteListItem } from '@/server/invites';
import type { Member } from '@/server/members';
import { createInviteAction, revokeInviteAction } from './actions';

type Props = {
  invites: InviteListItem[]; // 自己发的，新的在前
  members: Member[]; // 没归档的
  canIssueNewHousehold: boolean; // 站长才是 true（R26.2）
};

type DialogState = { name: 'create' } | { name: 'revoke'; invite: InviteListItem };

const PURPOSE_LABEL: Record<InvitePurpose, string> = {
  join: '加入我们家',
  new_household: '新建家庭',
};

const STATUS_LABEL: Record<InviteStatus, string> = {
  unused: '没用',
  used: '已用',
  expired: '过期',
  revoked: '撤销',
};

const STATUS_VARIANT: Record<InviteStatus, 'default' | 'secondary' | 'outline'> = {
  unused: 'default',
  used: 'secondary',
  expired: 'outline',
  revoked: 'outline',
};

// 界面上的时间按 Melbourne（R26 总则）
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Australia/Melbourne',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function signupLink(code: string): string {
  return `${window.location.origin}/signup?code=${encodeURIComponent(code)}`;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what}已复制`);
  } catch {
    toast.error('复制失败，手动选中复制');
  }
}

export function InvitesView({ invites, members, canIssueNewHousehold }: Props) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  return (
    <>
      <div className="flex items-center">
        <Button className="ml-auto" onClick={() => setDialog({ name: 'create' })}>
          <Plus />
          发邀请码
        </Button>
      </div>

      {invites.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没发过邀请码。
        </div>
      ) : (
        <>
          {/* 电脑：表格 */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>码</TableHead>
                  <TableHead>用途</TableHead>
                  <TableHead>归属人</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>谁用了</TableHead>
                  <TableHead>什么时候用的</TableHead>
                  <TableHead>
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono font-medium">{i.code}</TableCell>
                    <TableCell>{PURPOSE_LABEL[i.purpose]}</TableCell>
                    <TableCell>{i.memberName ?? '—'}</TableCell>
                    <TableCell>
                      <StatusBadge status={i.status} />
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {timeFormat.format(i.expiresAt)}
                    </TableCell>
                    <TableCell>{i.usedByName ?? '—'}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {i.usedAt ? timeFormat.format(i.usedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions invite={i} onRevoke={() => setDialog({ name: 'revoke', invite: i })} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 手机：卡片 */}
          <ul className="flex flex-col gap-2 md:hidden">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{i.code}</span>
                  <StatusBadge status={i.status} />
                </div>
                <p className="text-sm">
                  {PURPOSE_LABEL[i.purpose]}
                  {i.memberName && ` · ${i.memberName}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i.usedAt
                    ? `${i.usedByName ?? '—'} 在 ${timeFormat.format(i.usedAt)} 用了`
                    : `${timeFormat.format(i.expiresAt)} 过期`}
                </p>
                <RowActions invite={i} onRevoke={() => setDialog({ name: 'revoke', invite: i })} />
              </li>
            ))}
          </ul>
        </>
      )}

      {dialog?.name === 'create' && (
        <CreateInviteDialog
          members={members}
          canIssueNewHousehold={canIssueNewHousehold}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.name === 'revoke' && (
        <RevokeInviteDialog invite={dialog.invite} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: InviteStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="font-normal">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// R26.3 "没用"的才有复制和撤销
function RowActions({ invite, onRevoke }: { invite: InviteListItem; onRevoke: () => void }) {
  if (invite.status !== 'unused') return null;
  return (
    <div className="flex flex-wrap items-center gap-1 md:justify-end">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copy(signupLink(invite.code), '注册链接')}
      >
        <Copy />
        复制链接
      </Button>
      <Button variant="ghost" size="sm" className="text-destructive" onClick={onRevoke}>
        撤销
      </Button>
    </div>
  );
}

// R26.2：站长能选用途；不是站长只能发 join，不显示用途选项
// 生成以后对话框里换成码和链接，关掉才回到列表
function CreateInviteDialog({
  members,
  canIssueNewHousehold,
  onClose,
}: {
  members: Member[];
  canIssueNewHousehold: boolean;
  onClose: () => void;
}) {
  const [purpose, setPurpose] = useState<InvitePurpose>('join');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null); // 码，XXXX-XXXX
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const r = await createInviteAction({
        purpose,
        memberId: purpose === 'join' ? memberId : null,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      // createInvite 返回存的 8 位，显示成 XXXX-XXXX（R26.1）
      setCreated(formatInviteCode(r.code));
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <CreatedInvite code={created} onClose={onClose} />
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>发邀请码</DialogTitle>
              <DialogDescription>3 天内有效，只能用一次。</DialogDescription>
            </DialogHeader>

            {canIssueNewHousehold && (
              <div className="grid gap-2">
                <Label id="invite-purpose">用途</Label>
                <div
                  role="radiogroup"
                  aria-labelledby="invite-purpose"
                  className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
                >
                  {(['join', 'new_household'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={purpose === p}
                      onClick={() => setPurpose(p)}
                      className={cn(
                        'rounded-sm px-3 py-1.5 text-sm transition-colors',
                        purpose === p
                          ? 'bg-background font-medium shadow-xs'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {PURPOSE_LABEL[p]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {purpose === 'join' ? (
              <div className="grid gap-2">
                <Label htmlFor="invite-member">归属人</Label>
                <Select value={memberId ?? ''} onValueChange={setMemberId}>
                  <SelectTrigger id="invite-member" className="w-full">
                    <SelectValue placeholder="选一个归属人" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  注册的人进我们家，登录后默认是这个归属人。
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                注册的人会有一个自己的新家庭，带预置的分类和规则，看不到我们家的数据。
              </p>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                生成
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreatedInvite({ code, onClose }: { code: string; onClose: () => void }) {
  const link = signupLink(code);
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>邀请码生成好了</DialogTitle>
        <DialogDescription>发给要注册的人。3 天内有效，只能用一次。</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label>邀请码</Label>
        <div className="flex items-center gap-2">
          <span className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-lg tracking-wider">
            {code}
          </span>
          <Button type="button" variant="outline" onClick={() => void copy(code, '邀请码')}>
            <Copy />
            复制
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        <Label>注册链接</Label>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
            {link}
          </span>
          <Button type="button" variant="outline" onClick={() => void copy(link, '注册链接')}>
            <Copy />
            复制
          </Button>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onClose}>
          完成
        </Button>
      </DialogFooter>
    </div>
  );
}

// R26.3 撤销不能恢复
function RevokeInviteDialog({ invite, onClose }: { invite: InviteListItem; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function revoke() {
    setError(null);
    startTransition(async () => {
      const r = await revokeInviteAction(invite.id);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success('邀请码已撤销');
      onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            撤销邀请码 <span className="font-mono">{invite.code}</span>？
          </AlertDialogTitle>
          <AlertDialogDescription>
            撤销以后这个码不能注册，也不能恢复。要用就再发一个。
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
          <Button type="button" variant="destructive" disabled={pending} onClick={revoke}>
            {pending && <Loader2 className="animate-spin" />}
            撤销
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
