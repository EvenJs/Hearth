// F8 批量修改（M4-9）：当前页的勾选状态、结果提示（R16.1、R16.2）
// 纯函数，不 import 数据库和 Next.js

export type BulkField = 'category' | 'member';

// 表头复选框的状态：只看当前页的交易，别的页残留的 id 不算
export function selectionState(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): 'none' | 'some' | 'all' {
  const n = pageIds.filter((id) => selected.has(id)).length;
  if (n === 0) return 'none';
  return n === pageIds.length ? 'all' : 'some';
}

// R16.1："改了"包括值本来就一样的；"跳过"是拆过的（R16.1）和改分类时的内部转账（R16.2）
export function bulkResultMessage(
  field: BulkField,
  result: { updatedCount: number; skippedCount: number },
): string {
  const done = `改了 ${result.updatedCount} 笔`;
  if (result.skippedCount === 0) return done;
  const why =
    field === 'category' ? '拆过的交易、内部转账不能批量改分类' : '拆过的交易要在子行里单独改';
  return `${done}，跳过 ${result.skippedCount} 笔（${why}）`;
}
