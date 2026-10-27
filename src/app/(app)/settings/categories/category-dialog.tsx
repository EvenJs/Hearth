'use client';

// 新建 / 修改分类的对话框（设计图 13-settings-categories-dialog，R19.2、R19.3）
// 字段：名字、类型（只有新建一级时能选）、默认归属人（可空）、税前（只有收入的二级出现）
// Other 不能改名；报错显示在对话框里，不关
import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { CATEGORY_NAME_MAX } from '@/lib/rules/category-admin';
import { cn } from '@/lib/utils';
import type { AdminCategoryItem, AdminTopCategory } from '@/server/categories';
import type { Member } from '@/server/members';
import { createCategoryAction, updateCategoryAction } from './actions';

export type CategoryDialogMode =
  | { kind: 'create-top' }
  | { kind: 'create-child'; top: AdminTopCategory }
  | { kind: 'edit'; item: AdminCategoryItem; top: AdminTopCategory | null }; // top = null：改的是一级

type Kind = 'expense' | 'income';

const KIND_LABEL: Record<Kind, string> = { expense: '支出', income: '收入' };
const NONE = '__none';
const ARCHIVED_MEMBER = '（已归档的归属人）';

type Props = {
  mode: CategoryDialogMode;
  members: Member[];
  memberName: (id: string | null) => string | null;
  onClose: () => void;
  // created：新建一级时它的 id，用来展开
  onSaved: (message: string, created?: string) => void;
};

export function CategoryDialog({ mode, members, memberName, onClose, onSaved }: Props) {
  const editing = mode.kind === 'edit' ? mode.item : null;
  // 这个分类所属的一级（新建二级、改二级时），一级本身是 null
  const top = mode.kind === 'create-child' ? mode.top : mode.kind === 'edit' ? mode.top : null;
  const isChild = top !== null;

  const [name, setName] = useState(editing?.nameEn ?? '');
  const [kind, setKind] = useState<Kind>('expense');
  const [memberId, setMemberId] = useState<string>(editing?.defaultMemberId ?? NONE);
  const [preTax, setPreTax] = useState(editing?.isPreTaxDefault ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const effectiveKind: Kind | 'system' = top ? top.kind : editing ? editing.kind : kind;
  const showPreTax = isChild && effectiveKind === 'income'; // R19.2
  const isOther = editing?.isOther ?? false;

  // 空的显示"继承一级（X）"或"无"（design/README 第 4 节 13）
  const inherited = top ? memberName(top.defaultMemberId) : null;
  const noneLabel = isChild ? (inherited ? `继承一级（${inherited}）` : '继承一级（无）') : '无';
  // 原来的归属人归档了：下拉里没有，保留这个选项，不改就原样保存
  const keepArchived =
    editing?.defaultMemberId && !members.some((m) => m.id === editing.defaultMemberId)
      ? editing.defaultMemberId
      : null;

  const title =
    mode.kind === 'create-top'
      ? '新建一级分类'
      : mode.kind === 'create-child'
        ? '新建二级分类'
        : `修改 ${editing!.nameEn}`;
  const description =
    mode.kind === 'create-top'
      ? '会同时建一个 Other 二级。类型建好以后不能改。'
      : mode.kind === 'create-child'
        ? `属于 ${mode.top.nameEn}，排在 Other 前面。`
        : '改默认归属人、税前只影响以后导入和录入的交易，已有交易不变。';

  function save() {
    setError(null);
    const defaultMemberId = memberId === NONE ? null : memberId;
    startTransition(async () => {
      const r =
        mode.kind === 'edit'
          ? await updateCategoryAction(mode.item.id, {
              nameEn: isOther ? undefined : name,
              defaultMemberId,
              isPreTaxDefault: showPreTax ? preTax : undefined,
            })
          : await createCategoryAction({
              nameEn: name,
              parentId: mode.kind === 'create-child' ? mode.top.id : null,
              kind: mode.kind === 'create-top' ? kind : undefined,
              defaultMemberId,
              isPreTaxDefault: showPreTax && preTax,
            });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      if (mode.kind === 'edit') onSaved('分类已修改');
      else onSaved('分类已新建', mode.kind === 'create-top' ? r.categoryId : undefined);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="category-name">名字</Label>
              <span className="text-xs text-muted-foreground">
                英文，最长 {CATEGORY_NAME_MAX} 字
              </span>
            </div>
            <Input
              id="category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isOther}
              autoFocus={!isOther}
              autoComplete="off"
              aria-invalid={error !== null}
            />
            {isOther && <p className="text-xs text-muted-foreground">Other 不能改名。</p>}
          </div>

          {mode.kind === 'create-top' && (
            <div className="grid gap-2">
              <Label id="category-kind">类型</Label>
              <div
                role="radiogroup"
                aria-labelledby="category-kind"
                className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
              >
                {(['expense', 'income'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded-sm px-3 py-1.5 text-sm transition-colors',
                      kind === k
                        ? 'bg-background font-medium shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label id="category-member">默认归属人</Label>
            <Select value={memberId} onValueChange={setMemberId}>
              <SelectTrigger aria-labelledby="category-member" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{noneLabel}</SelectItem>
                {keepArchived && <SelectItem value={keepArchived}>{ARCHIVED_MEMBER}</SelectItem>}
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isChild
                ? '为空时按一级的默认归属人。'
                : '钱用在谁身上。为空时按卡号、账户的默认归属人。'}
            </p>
          </div>

          {showPreTax && (
            <div className="flex items-start gap-2">
              <Checkbox
                id="category-pre-tax"
                checked={preTax}
                onCheckedChange={(v) => setPreTax(v === true)}
                className="mt-0.5"
              />
              <div className="grid gap-1">
                <Label htmlFor="category-pre-tax" className="font-normal">
                  税前
                </Label>
                <p className="text-xs text-muted-foreground">
                  到账金额是没扣过税的（比如 Interest、Contract income）。
                </p>
              </div>
            </div>
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
            <Button type="submit" disabled={pending || (!isOther && name.trim() === '')}>
              {pending && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
