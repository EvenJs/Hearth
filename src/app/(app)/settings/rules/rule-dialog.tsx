'use client';

// 新建 / 修改规则的对话框（设计图 12-settings-rules-dialog，R18.2）
// 字段：关键词、匹配方式（包含 / 开头是）、分类（R16.3 的范围）
// 报错（空的、太长、撞了"已有规则 X → Y"、分类不能选）显示在对话框里，不关
// 修改时显示打开时的命中数，不跟着输入变（design/README 第 4 节）
import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
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
import { RULE_MATCH_TYPES, type RuleMatchType } from '@/lib/rules/types';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import type { RuleListItem } from '@/server/rules';
import { CategoryPicker, pickerLabel } from '../../transactions/category-picker';
import { createRuleAction, updateRuleAction } from './actions';

export const MATCH_TYPE_LABEL: Record<RuleMatchType, string> = {
  contains: '包含',
  starts_with: '开头是',
};

type Props = {
  rule: RuleListItem | null; // null = 新建
  sections: PickerSections;
  onClose: () => void;
  onSaved: (message: string) => void;
};

export function RuleDialog({ rule, sections, onClose, onSaved }: Props) {
  const [keyword, setKeyword] = useState(rule?.keyword ?? '');
  const [matchType, setMatchType] = useState<RuleMatchType>(rule?.matchType ?? 'contains');
  const [categoryId, setCategoryId] = useState<string | null>(rule?.categoryId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 规则指向的分类归档了：下拉里没有它，按钮上显示原来的名字，要换一个才能保存（R16.3）
  const label =
    pickerLabel(sections, categoryId) ??
    (rule && categoryId === rule.categoryId ? `${rule.categoryLabel}（已归档）` : null);

  function save() {
    if (!categoryId) {
      setError('请选择分类');
      return;
    }
    setError(null);
    startTransition(async () => {
      const input = { keyword, matchType, categoryId };
      const r = rule ? await updateRuleAction(rule.id, input) : await createRuleAction(input);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onSaved(rule ? '规则已修改' : '规则已新建');
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
            <DialogTitle>{rule ? '修改规则' : '新建规则'}</DialogTitle>
            <DialogDescription>
              匹配清洗后的商家名，不区分大小写。多条规则命中时，关键词长的优先。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="rule-keyword">关键词</Label>
            <Input
              id="rule-keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              autoFocus
              autoComplete="off"
              className="font-mono"
              aria-invalid={error !== null}
            />
            <p className="text-xs text-muted-foreground">
              保存时去掉多余空格、转成大写，最长 100 个字符。
            </p>
          </div>

          <div className="grid gap-2">
            <Label id="rule-match-type">匹配方式</Label>
            <div
              role="radiogroup"
              aria-labelledby="rule-match-type"
              className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
            >
              {RULE_MATCH_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={matchType === t}
                  onClick={() => setMatchType(t)}
                  className={cn(
                    'rounded-sm px-3 py-1.5 text-sm transition-colors',
                    matchType === t
                      ? 'bg-background font-medium shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {MATCH_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label id="rule-category">分类</Label>
            <CategoryPicker
              sections={sections}
              value={categoryId}
              onSelect={(id) => setCategoryId(id)}
              mode="edit"
            >
              <Button
                type="button"
                variant="outline"
                aria-labelledby="rule-category"
                className="w-full justify-between font-normal"
              >
                <span className={cn('truncate', !label && 'text-muted-foreground')}>
                  {label ?? '选择分类'}
                </span>
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </CategoryPicker>
          </div>

          {rule && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              现在命中 {rule.hits} 笔
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
            <Button type="submit" disabled={pending || keyword.trim() === ''}>
              {pending && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
