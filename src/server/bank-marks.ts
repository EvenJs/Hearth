// M13-12：public/banks/ 里放了哪些银行 logo。文件名 = bank 值，比如 anz.svg、anz_plus.png、cba.jpg
// 服务端先查好传给 BankMark，没有的直接画字母方块，不用 <img onError> 闪一下
// Vercel 上要靠 next.config 的 outputFileTracingIncludes 把这个目录打进函数包
import { readdirSync } from 'node:fs';
import path from 'node:path';

const LOGO_EXTS = ['.svg', '.png', '.jpg'] as const; // 同一个 bank 有几种时用前面的

// 返回 { anz: '/banks/anz.svg' }；目录不存在或读不了返回 {}，全部退回字母方块
export function getBankLogos(): Record<string, string> {
  let files: string[];
  try {
    files = readdirSync(path.join(process.cwd(), 'public', 'banks'));
  } catch {
    return {};
  }
  const logos: Record<string, string> = {};
  for (const ext of LOGO_EXTS) {
    for (const f of files) {
      if (!f.endsWith(ext)) continue;
      const bank = f.slice(0, -ext.length);
      if (bank !== '' && !(bank in logos)) logos[bank] = `/banks/${f}`;
    }
  }
  return logos;
}
