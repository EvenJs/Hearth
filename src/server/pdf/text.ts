// 读 PDF 文字（business-rules.md R1C 第一层），用 unpdf（包装 Mozilla PDF.js）
// 把每一页的文字块按坐标拼成行，交给 src/lib/import/anz-statement.ts 解析
// 不保存文件（R1C）；日志和报错里不打印读出来的文字
import { extractTextItems } from 'unpdf';

export type PdfLine = { page: number; text: string }; // page 从 1 开始

export type ExtractPdfResult = { ok: true; lines: PdfLine[] } | { ok: false; message: string };

// 拼行只需要这几个字段（unpdf 的 StructuredTextItem 的一部分）
export type PdfTextItem = {
  str: string;
  x: number; // 左下角原点
  y: number;
  width: number;
  fontSize: number;
};

const UNREADABLE = '读不出文字，可能是扫描件或者加了密码的 PDF';

// 同一行：y 相差不超过字号的一半（同一行里字号不同、上下标会有一点偏移）
const SAME_LINE_RATIO = 0.5;
// 两块之间的空隙小于一个字符宽的这个比例，当作紧挨着，不加空格（PDF.js 按字体切开的同一个词）
const TOUCHING_RATIO = 0.15;

// R1C：buffer 是上传的 PDF，只在内存里读
export async function extractPdfLines(buffer: ArrayBuffer | Uint8Array): Promise<ExtractPdfResult> {
  let pages: PdfTextItem[][];
  try {
    // PDF.js 会占用传进去的 buffer，复制一份，不影响调用方
    ({ items: pages } = await extractTextItems(new Uint8Array(buffer).slice()));
  } catch {
    // 不是 PDF、文件坏了、加了密码：PDF.js 的报错可能带文件内容，不往外传
    return { ok: false, message: UNREADABLE };
  }

  const lines = layoutLines(pages);
  // 扫描件只有图片，没有文字块
  if (lines.length === 0) return { ok: false, message: UNREADABLE };
  return { ok: true, lines };
}

// R1C：按 y 分行、按 x 排序；同一行里两块之间的空隙大于一个字符宽放两个空格，否则一个空格
// pages[i] 是第 i + 1 页的文字块
export function layoutLines(pages: readonly (readonly PdfTextItem[])[]): PdfLine[] {
  const result: PdfLine[] = [];
  pages.forEach((items, i) => {
    for (const row of groupRows(items)) {
      const text = joinRow(row);
      if (text !== '') result.push({ page: i + 1, text });
    }
  });
  return result;
}

// 从上到下分行。PDF 的 y 往上是正，所以 y 大的在上面
function groupRows(items: readonly PdfTextItem[]): PdfTextItem[][] {
  // 空白块不要：PDF.js 会在空隙里插空格块，空隙按坐标算
  const visible = items.filter((item) => item.str.trim() !== '');
  const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: { y: number; tolerance: number; items: PdfTextItem[] }[] = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - item.y) <= row.tolerance) {
      row.items.push(item);
      row.tolerance = Math.max(row.tolerance, item.fontSize * SAME_LINE_RATIO);
    } else {
      rows.push({ y: item.y, tolerance: item.fontSize * SAME_LINE_RATIO, items: [item] });
    }
  }
  return rows.map((row) => row.items.sort((a, b) => a.x - b.x));
}

function joinRow(items: readonly PdfTextItem[]): string {
  let text = '';
  let previous: PdfTextItem | null = null;
  for (const item of items) {
    const str = item.str.trim();
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const charWidth = averageCharWidth(previous);
      if (gap > charWidth) text += '  ';
      else if (gap > charWidth * TOUCHING_RATIO) text += ' ';
    }
    text += str;
    previous = item;
  }
  return text.trim();
}

// 这一块里平均一个字符多宽；宽度读不出来时按字号的一半估
function averageCharWidth(item: PdfTextItem): number {
  const length = item.str.length;
  if (item.width > 0 && length > 0) return item.width / length;
  return item.fontSize / 2;
}
