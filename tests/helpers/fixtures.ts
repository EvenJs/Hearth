// 读 fixtures/ 里的假数据（fixtures/README.md）。原样返回文本，不改行尾
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

// 只允许 anz/*.csv、cba/*.csv、anz-statement/*.txt、receipts/*.json，防止测试误读别的文件
const FIXTURE_PATH =
  /^((anz|cba)\/[a-z0-9-]+\.csv|anz-statement\/[a-z0-9-]+\.txt|receipts\/[a-z0-9-]+\.json)$/;

export type FixturePath =
  | `anz/${string}.csv`
  | `cba/${string}.csv`
  | `anz-statement/${string}.txt`
  | `receipts/${string}.json`;

export function readFixture(path: FixturePath): string {
  if (!FIXTURE_PATH.test(path)) {
    throw new Error(
      `fixture 路径不对: ${path}（只能是 anz/*.csv、cba/*.csv、anz-statement/*.txt 或 receipts/*.json）`,
    );
  }
  return readFileSync(FIXTURES_DIR + path, 'utf8');
}

// R20.1 小票 fixture：假 reader 的原始结果，JSON.parse 后原样返回，没经过 Zod
export function readReceiptFixture(name: `${string}.json`): unknown {
  return JSON.parse(readFixture(`receipts/${name}`));
}

// R1C 第一层的输出格式：一行一个 { page, text }，页码从 1 开始
export type StatementFixtureLine = { page: number; text: string };

// 对账单 fixture 的分页标记，单独一行
const PAGE_BREAK = '<<<PAGE>>>';

// 把对账单 fixture 的文本按 <<<PAGE>>> 分页、按行拆开。测试里改过的文本也用这个
export function toStatementLines(text: string): StatementFixtureLine[] {
  const lines: StatementFixtureLine[] = [];
  let page = 1;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === PAGE_BREAK) {
      page += 1;
      continue;
    }
    if (raw.trim() === '') continue;
    lines.push({ page, text: raw });
  }
  return lines;
}

export function readStatementFixture(name: `${string}.txt`): StatementFixtureLine[] {
  return toStatementLines(readFixture(`anz-statement/${name}`));
}
