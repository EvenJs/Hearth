import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import type { LlmChatRequest, LlmClient, LlmResult } from '../llm/client';
import { buildCategoryText, createLlmReader, RECEIPT_SYSTEM_PROMPT } from './llm';

// R20.1、R20.1a：llm reader 注入假的 LlmClient，不碰网络

const CATEGORIES = [
  'Home & utilities / Household supplies',
  'Personal & medical / Cosmetics & toiletries',
];
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const image = () => ({
  kind: 'image' as const,
  image: new Blob([IMAGE_BYTES], { type: 'image/jpeg' }),
});

function fakeClient(result: LlmResult | (() => Promise<LlmResult>)) {
  const requests: LlmChatRequest[] = [];
  const client: LlmClient = {
    async chat(request) {
      requests.push(request);
      return typeof result === 'function' ? result() : result;
    },
  };
  return { client, requests };
}

const ok = (content: unknown): LlmResult => ({
  ok: true,
  content: typeof content === 'string' ? content : JSON.stringify(content),
  model: 'fake/model-1',
});

describe('llm reader（R20.1a）', () => {
  it('R20.1: valid JSON comes back as the raw receipt, reader is llm:<model>', async () => {
    const raw = readReceiptFixture('coles-a.json');
    const { client } = fakeClient(ok(raw));
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: true, raw, reader: 'llm:fake/model-1' });
  });

  it('R20.1: extra fields like names, ABN and phone are dropped by Zod', async () => {
    const raw = readReceiptFixture('grocer-b.json') as Record<string, unknown>;
    const { client } = fakeClient(
      ok({
        ...raw,
        cashier: 'SOMEONE',
        customer: 'SOMEONE ELSE',
        abn: '12 345 678 901',
        phone: '03 9999 0000',
      }),
    );
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.raw).sort()).toEqual(
      ['date', 'discounts', 'items', 'merchant', 'payment', 'total'].sort(),
    );
  });

  it('R20.1a: JSON wrapped in ```json fences or after a <think> block is still read', async () => {
    const raw = readReceiptFixture('coles-a.json');
    const { client } = fakeClient(
      ok(`<think>reading…</think>\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``),
    );
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: true, raw, reader: 'llm:fake/model-1' });
  });

  it('R20.1a: HTTP 429 is a failure, not a throw', async () => {
    const { client } = fakeClient({ ok: false, reason: 'HTTP 429' });
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: false, reason: 'HTTP 429' });
  });

  it('R20.1a: timeout is a failure', async () => {
    const { client } = fakeClient({ ok: false, reason: '超时（30 秒）' });
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: false, reason: '超时（30 秒）' });
  });

  it('R20.1a: content that is not JSON is a failure', async () => {
    const { client } = fakeClient(ok('Sorry, I cannot read this receipt.'));
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: false, reason: '返回的不是 JSON' });
  });

  it('R20.1: JSON that fails rawReceiptSchema is a failure, reason names fields only', async () => {
    // 金额给成数字、少了 payment
    const { client } = fakeClient(
      ok({ merchant: 'COLES', date: '31/08/2026', total: 58.4, items: [], discounts: [] }),
    );
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^返回格式不对：/);
    expect(result.reason).toContain('total');
    expect(result.reason).toContain('payment');
    expect(result.reason).not.toContain('58.4');
  });

  it('R20.1a: a client that throws anyway is a failure', async () => {
    const { client } = fakeClient(() => Promise.reject(new Error('boom')));
    const result = await createLlmReader(client).read(image(), CATEGORIES);
    expect(result).toEqual({ ok: false, reason: '识别出错' });
  });

  it('R20.1: text input is rejected without calling the client', async () => {
    const { client, requests } = fakeClient(ok({}));
    const result = await createLlmReader(client).read({ kind: 'text', text: 'COLES' }, CATEGORIES);
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('R20.1a: the request carries only the fixed prompt, the category list and the image', async () => {
    const { client, requests } = fakeClient(ok(readReceiptFixture('coles-a.json')));
    await createLlmReader(client).read(image(), CATEGORIES);

    expect(requests).toHaveLength(1);
    const dataUrl = `data:image/jpeg;base64,${Buffer.from(IMAGE_BYTES).toString('base64')}`;
    expect(requests[0]).toEqual({
      model: 'vision',
      json: true,
      messages: [
        { role: 'system', content: RECEIPT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildCategoryText(CATEGORIES) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    // 分类文字里只有分类本身
    expect(buildCategoryText(CATEGORIES)).toBe(
      'Categories:\n- Home & utilities / Household supplies\n- Personal & medical / Cosmetics & toiletries',
    );
  });

  it('R20.1a: the prompt states every R20.1a requirement', () => {
    for (const phrase of [
      'kg NET @', // 称重、数量明细行不算商品
      '@ $1.70 EACH',
      'price is the amount of the item on the line above', // Woolworths 称重行末尾的价格
      'negative amount, placed right after the item it discounts', // 单件折扣
      'goes in "discounts", not in "items"', // 整单折扣
      'GST', // GST、付款、找零、积分
      'change',
      'loyalty points',
      "person's name", // 不返回人名、终端号、ABN、电话
      'terminal',
      'ABN',
      'phone',
      'use null for food', // 食品给 null
    ]) {
      expect(RECEIPT_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
