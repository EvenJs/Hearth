// llm reader（business-rules.md R20.1a，tech-stack 11.3）
// 发出去的只有：一张图片 + 分类列表。不发账户、交易、金额、日期，不发其他任何数据
// 返回用 rawReceiptSchema 校验，多的字段（人名、终端号、ABN、电话）被 Zod 丢掉
// 图片只在这次请求的内存里，不写磁盘、不打日志
import { rawReceiptSchema } from '@/lib/rules/receipt';
import type { LlmClient } from '../llm/client';
import type { ReadResult, ReceiptInput, ReceiptReader } from './types';

// R20.1a 的提示词要求逐条写进去。分类列表放在 user 消息里（见 buildCategoryText）
// 英文写：小票是英文的，模型按英文规则对得更准
export const RECEIPT_SYSTEM_PROMPT = `You read one photo of an Australian shop receipt and return its contents as a JSON object. Return only the JSON object, no other text.

JSON format (every amount and the date are strings copied exactly as printed):
{
  "merchant": "shop name as printed",
  "date": "receipt date as printed, e.g. 24/10/2026 or 24/10/26; null if not readable",
  "total": "amount paid as printed, e.g. 46.12",
  "items": [{ "name": "item name as printed", "amount": "line price, e.g. 4.50 or -0.80", "category": null }],
  "discounts": [{ "label": "discount line text", "amount": "negative, e.g. -2.04" }],
  "payment": { "method": "card" | "cash" | "unknown", "cardLast4": "last 4 card digits or null" }
}

Rules:
1. Weight and quantity detail lines (like "0.581 kg NET @ $4.90/kg" or "4 @ $1.70 EACH") are not items.
2. If a weight or quantity detail line ends with a price (Woolworths layout: "Papaya Red" then next line "1.367 kg NET @ $5.90/kg  8.07"), that price is the amount of the item on the line above. Do not add the detail line as an item.
3. A discount on a single item (like "GOLD KIWIFRUIT 4 FOR $6 -$0.80") is an item with a negative amount, placed right after the item it discounts.
4. A discount on the whole receipt (like "DISCOUNT -$2.04") goes in "discounts", not in "items". If there is none, "discounts" is [].
5. GST, subtotal, total, payment method, card, EFTPOS, change, cash tendered, rounding and loyalty points lines are not items.
6. Do not return any person's name (customer, cashier, manager), terminal or register number, ABN or phone number.
7. "category": use null for food and for anything that fits what this shop mainly sells. Only for items clearly outside that (household supplies, cosmetics, toiletries, medicine, alcohol and so on) pick exactly one category string from the list the user gives. Never invent a category.
8. "total" is the amount actually paid after all discounts. The item amounts plus the discounts should add up to it.
9. "payment.method": "card" if paid by card or EFTPOS, "cash" if paid in cash, otherwise "unknown". "cardLast4" is the last 4 digits of the card number if printed, otherwise null.`;

// 分类列表就是发出去的唯一文字数据
export function buildCategoryText(categories: string[]): string {
  return `Categories:\n${categories.map((c) => `- ${c}`).join('\n')}`;
}

// 模型有时会在 JSON 外面包 ```json 或者先输出 <think>，去掉再解析
function extractJson(content: string): unknown {
  const stripped = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(stripped);
}

async function toDataUrl(image: Blob): Promise<string> {
  const base64 = Buffer.from(await image.arrayBuffer()).toString('base64');
  return `data:${image.type || 'image/jpeg'};base64,${base64}`;
}

export function createLlmReader(client: LlmClient): ReceiptReader {
  return {
    id: 'llm',
    input: 'image',
    async read(input: ReceiptInput, categories: string[]): Promise<ReadResult> {
      if (input.kind !== 'image') return { ok: false, reason: 'llm reader 只收图片' };
      try {
        const result = await client.chat({
          model: 'vision',
          json: true,
          messages: [
            { role: 'system', content: RECEIPT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: buildCategoryText(categories) },
                { type: 'image_url', image_url: { url: await toDataUrl(input.image) } },
              ],
            },
          ],
        });
        if (!result.ok) return { ok: false, reason: result.reason };

        let json: unknown;
        try {
          json = extractJson(result.content);
        } catch {
          return { ok: false, reason: '返回的不是 JSON' };
        }

        const parsed = rawReceiptSchema.safeParse(json);
        // Zod 的报错里可能有小票内容，只给字段路径
        if (!parsed.success) {
          const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(根)'))];
          return { ok: false, reason: `返回格式不对：${fields.join(', ')}` };
        }
        return { ok: true, raw: parsed.data, reader: 'llm' };
      } catch {
        // LlmClient 不该抛错，万一抛了也当作识别失败
        return { ok: false, reason: '识别出错' };
      }
    },
  };
}
