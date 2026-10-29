'use server';

// 小票的 Server Actions（M6.7-7，business-rules.md R20，tech-stack 11.3）
// 输入的形状由 src/server/receipts.ts 里的 Zod 校验，钱的计算在 src/lib/rules/ 的纯函数
// 图片只在这次请求的内存里：不写磁盘、不存数据库、不打日志。日志里也不打印小票内容和数据库错误详情
import { revalidatePath } from 'next/cache';
import { getHouseholdContext } from '@/server/context';
import { getReceiptReader } from '@/server/receipt-readers';
import {
  getReceiptCandidates,
  previewReceipt,
  saveReceipt,
  scanReceipt,
  type PreviewReceiptInput,
  type ReceiptCandidatesInput,
  type ReceiptCandidatesResult,
  type ReceiptDraft,
  type ReceiptPreview,
  type SaveReceiptInput,
  type SaveReceiptResult,
} from '@/server/receipts';

// 浏览器里先压成 JPEG（长边 ≤ 1600px、≤ 1MB），这里再挡一次
const MAX_IMAGE_BYTES = 1024 * 1024;

type Failure = { ok: false; message: string };

function logError(what: string, err: unknown) {
  console.error(`[receipt] ${what}失败`, err instanceof Error ? err.name : typeof err);
}

// 拍小票：formData 里有 image 就交给当前 reader；没有 image（RECEIPT_READER = none）直接返回空草稿
export async function scanReceiptAction(
  formData: FormData,
): Promise<{ ok: true; draft: ReceiptDraft } | Failure> {
  // 没登录时 getHouseholdContext 会 redirect，不能放进 try（会被吞掉）
  const ctx = await getHouseholdContext();
  const image = formData.get('image');
  const reader = getReceiptReader();

  if (image !== null) {
    if (!(image instanceof Blob) || !image.type.startsWith('image/')) {
      return { ok: false, message: '只能上传图片' };
    }
    if (image.size > MAX_IMAGE_BYTES) return { ok: false, message: '图片太大，换一张再试' };
  }

  try {
    // 没有图片，或者 reader 不收图片：不调 reader，打开空的核对界面
    const useReader = image instanceof Blob && reader?.input === 'image' ? reader : null;
    const draft = await scanReceipt(
      ctx,
      image instanceof Blob ? { kind: 'image', image } : { kind: 'text', text: '' },
      useReader,
    );
    return { ok: true, draft };
  } catch (err) {
    logError('识别', err);
    return { ok: false, message: '加载失败，请关掉再试' };
  }
}

// R20.4：核对界面里改了日期、总额、店名后重新找候选。cardLast4 是 scanReceiptAction 返回的
export async function receiptCandidatesAction(
  input: ReceiptCandidatesInput,
  cardLast4: string | null,
): Promise<{ ok: true; result: ReceiptCandidatesResult } | Failure> {
  const ctx = await getHouseholdContext();
  try {
    return { ok: true, result: await getReceiptCandidates(ctx, input, cardLast4) };
  } catch (err) {
    logError('查候选', err);
    return { ok: false, message: '查找交易失败，请稍后再试' };
  }
}

// "保存后的拆分"预览，和保存走同一个计划，不写库
export async function previewReceiptAction(input: PreviewReceiptInput): Promise<ReceiptPreview> {
  const ctx = await getHouseholdContext();
  try {
    return await previewReceipt(ctx, input);
  } catch (err) {
    logError('预览', err);
    return { ok: false, code: 'invalid', message: '预览失败，请稍后再试' };
  }
}

// R20.3 到 R20.7 保存。成功后看板和 F8（含详情页）一起刷新
export async function saveReceiptAction(input: SaveReceiptInput): Promise<SaveReceiptResult> {
  const ctx = await getHouseholdContext();
  try {
    const r = await saveReceipt(ctx, input);
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    // 事务已经回滚，什么都没写
    logError('保存', err);
    return { ok: false, code: 'invalid', message: '保存失败，请稍后再试' };
  }
}
