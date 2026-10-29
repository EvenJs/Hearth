// 测试用：手写一个最小的 PDF（Helvetica，只有文字），不用额外的库
// 只用来测 src/server/pdf/text.ts 按坐标拼行；内容都是编的

export type PdfText = { x: number; y: number; text: string; size?: number };

function escapePdfString(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

// 每个元素是一页，页里每块文字按 (x, y) 放，y 从页面底部往上算。页面放宽到 1400pt，长行不会被裁掉
export function makePdf(pages: PdfText[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 对象编号从 1 开始
  };

  const catalog = add(''); // 先占位，最后填
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = pages.map((texts) => {
    const stream = texts
      .map((t) => `BT /F1 ${t.size ?? 10} Tf ${t.x} ${t.y} Td (${escapePdfString(t.text)}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 1400 842] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf); // 只有 ASCII，长度就是字节数
}
