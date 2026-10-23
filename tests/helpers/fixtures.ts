// 读 fixtures/ 里的假 CSV（fixtures/README.md）。原样返回文本，不改行尾
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

// 只允许 anz/*.csv、cba/*.csv，防止测试误读别的文件
const FIXTURE_PATH = /^(anz|cba)\/[a-z0-9-]+\.csv$/;

export type FixturePath = `anz/${string}.csv` | `cba/${string}.csv`;

export function readFixture(path: FixturePath): string {
  if (!FIXTURE_PATH.test(path)) {
    throw new Error(`fixture 路径不对: ${path}（只能是 anz/*.csv 或 cba/*.csv）`);
  }
  return readFileSync(FIXTURES_DIR + path, 'utf8');
}
