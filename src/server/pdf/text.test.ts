import { describe, expect, it } from 'vitest';
import { readFixture, readStatementFixture } from '../../../tests/helpers/fixtures';
import { makePdf, type PdfText } from '../../../tests/helpers/pdf';
import { parseAnzStatement } from '@/lib/import/anz-statement';
import { normalizeDescription } from '@/lib/rules/dedupe';
import { extractPdfLines, layoutLines, type PdfTextItem } from './text';

// R1C 第一层：按坐标拼行。PDF 都是测试里现拼的，内容是编的

// Helvetica 10pt 里一个大写字母大约 6-7pt 宽
async function linesOf(pages: PdfText[][]) {
  const result = await extractPdfLines(makePdf(pages));
  if (!result.ok) throw new Error(result.message);
  return result.lines;
}

describe('extractPdfLines（R1C 第一层）', () => {
  it('R1C: same y is one line, sorted by x; a gap wider than a character gets two spaces', async () => {
    const lines = await linesOf([
      [
        // 故意打乱顺序写进 PDF
        { x: 400, y: 700, text: '4,941.60' },
        { x: 50, y: 700, text: '01 SEP' },
        { x: 300, y: 700, text: '58.40' },
        { x: 120, y: 700, text: 'VISA DEBIT PURCHASE' },
        { x: 350, y: 700, text: 'blank' },
      ],
    ]);
    expect(lines).toEqual([
      { page: 1, text: '01 SEP  VISA DEBIT PURCHASE  58.40  blank  4,941.60' },
    ]);
  });

  it('R1C: a gap smaller than a character gets one space, touching blocks get none', async () => {
    // "COLES" 10pt 大约 33pt 宽：x 50 结束在 ~83
    const lines = await linesOf([
      [
        { x: 50, y: 700, text: 'COLES' },
        { x: 86, y: 700, text: '0559' },
        { x: 50, y: 680, text: 'GONG' },
        { x: 50 + 30.01, y: 680, text: 'CHA' },
      ],
    ]);
    expect(lines[0].text).toBe('COLES 0559');
    expect(lines[1].text).toMatch(/^GONG ?CHA$/); // 紧挨着时 PDF.js 自己可能合并
  });

  it('R1C: lines go top to bottom; y within half a font size is the same line', async () => {
    const lines = await linesOf([
      [
        { x: 50, y: 680, text: 'SECOND' },
        { x: 50, y: 700, text: 'FIRST' },
        { x: 200, y: 701.5, text: 'SAME' },
      ],
    ]);
    expect(lines.map((l) => l.text)).toEqual(['FIRST  SAME', 'SECOND']);
  });

  it('R1C: page numbers start at 1', async () => {
    const lines = await linesOf([
      [{ x: 50, y: 700, text: 'PAGE ONE' }],
      [{ x: 50, y: 700, text: 'PAGE TWO' }],
    ]);
    expect(lines).toEqual([
      { page: 1, text: 'PAGE ONE' },
      { page: 2, text: 'PAGE TWO' },
    ]);
  });

  it('R1C: a PDF with no text (like a scan) fails with 读不出文字', async () => {
    const result = await extractPdfLines(makePdf([[]]));
    expect(result).toEqual({ ok: false, message: expect.stringContaining('读不出文字') });
  });

  it('R1C: bytes that are not a PDF fail with 读不出文字, without throwing', async () => {
    const result = await extractPdfLines(new TextEncoder().encode('not a pdf at all'));
    expect(result).toEqual({ ok: false, message: expect.stringContaining('读不出文字') });
  });

  it('R1C: does not modify the caller buffer', async () => {
    const pdf = makePdf([[{ x: 50, y: 700, text: 'HELLO' }]]);
    const copy = pdf.slice();
    await extractPdfLines(pdf);
    expect(pdf).toEqual(copy);
  });

  it('R1C: a PDF that is not a statement makes parseAnzStatement fail, not crash', async () => {
    const lines = await linesOf([
      [
        { x: 50, y: 750, text: 'Shopping list' },
        { x: 50, y: 730, text: '01 SEP  milk' },
        { x: 50, y: 710, text: 'Total  $12.00' },
      ],
    ]);
    const result = parseAnzStatement(lines, '0001');
    expect(result.ok).toBe(false);
  });
});

// 把对账单 fixture 的每一行画进 PDF：两个空格隔开的段放在不同的 x，模拟对账单的栏位
function renderStatementFixture(text: string): PdfText[][] {
  return text.split('<<<PAGE>>>').map((pageText) =>
    pageText
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line, i) => {
        let x = 40;
        return line.split(/\s{2,}/).map((segment) => {
          const placed = { x, y: 800 - i * 14, text: segment, size: 8 };
          x += segment.length * 6 + 24; // 8pt 一个字符最宽 ~6pt，段之间留 24pt
          return placed;
        });
      }),
  );
}

describe('extractPdfLines + parseAnzStatement（R1C 两层）', () => {
  it('R1C: joint-2026-09.txt drawn into a PDF parses the same as the text fixture', async () => {
    const pdf = makePdf(renderStatementFixture(readFixture('anz-statement/joint-2026-09.txt')));
    const extracted = await extractPdfLines(pdf);
    if (!extracted.ok) throw new Error(extracted.message);

    const fromPdf = parseAnzStatement(extracted.lines, '0001');
    const fromText = parseAnzStatement(readStatementFixture('joint-2026-09.txt'), '0001');
    if (!fromPdf.ok || !fromText.ok) throw new Error('期望两份都解析成功');
    // 描述只会差空白（PDF 里大的空隙统一成两个空格），R4 的 normalizedDescription 会合并
    const normalized = (rows: typeof fromPdf.rows) =>
      rows.map((r) => ({ ...r, description: normalizeDescription(r.description) }));
    expect({ ...fromPdf, rows: normalized(fromPdf.rows) }).toEqual({
      ...fromText,
      rows: normalized(fromText.rows),
    });
  });
});

describe('layoutLines（R1C 第一层）', () => {
  const item = (str: string, x: number, y: number, width: number): PdfTextItem => ({
    str,
    x,
    y,
    width,
    fontSize: 10,
  });

  it('R1C: whitespace-only blocks are ignored, gaps are measured from coordinates', () => {
    expect(
      layoutLines([
        [item('05 SEP', 50, 800, 34), item(' ', 84, 800, 16), item('COLES', 100, 800, 33)],
      ]),
    ).toEqual([{ page: 1, text: '05 SEP  COLES' }]);
  });

  it('R1C: falls back to half the font size when a block has no width', () => {
    // 半个字号 = 5，空隙 4 → 一个空格；空隙 6 → 两个空格
    expect(layoutLines([[item('A', 0, 0, 0), item('B', 4, 0, 0)]])[0].text).toBe('A B');
    expect(layoutLines([[item('A', 0, 0, 0), item('B', 6, 0, 0)]])[0].text).toBe('A  B');
  });
});
