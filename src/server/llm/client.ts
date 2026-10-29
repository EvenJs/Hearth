// LLM 调用（tech-stack 11.2、11.3）。只在服务器端用，API key 不进浏览器
// 现在只有 OpenAI 兼容这一种实现：直接 fetch chat completions，不引入 SDK
// 换 Groq、Cloudflare、GitHub Models 只改 LLM_* 环境变量；接不兼容的服务商时加一个 LlmClient 实现
// 不打日志：请求里有小票图片，返回里有小票内容

export type LlmContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type LlmMessage =
  { role: 'system'; content: string } | { role: 'user'; content: string | LlmContentPart[] };

export type LlmChatRequest = {
  // 按用途选模型（tech-stack 11.2）：vision → LLM_VISION_MODEL。以后加 text → LLM_TEXT_MODEL
  model: 'vision';
  messages: LlmMessage[];
  json?: boolean; // 要求返回 JSON：response_format json_object
};

// content 是模型返回的原文，由调用方解析和校验
export type LlmResult = { ok: true; content: string } | { ok: false; reason: string };

export interface LlmClient {
  // 不抛错，失败返回 { ok: false, reason }
  chat(request: LlmChatRequest): Promise<LlmResult>;
}

export type OpenAiCompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  models: { vision?: string };
  timeoutMs?: number;
};

export const LLM_TIMEOUT_MS = 30_000; // tech-stack 11.3：超时 30 秒，不重试

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createOpenAiCompatibleClient(
  config: OpenAiCompatibleConfig,
  fetchImpl: FetchLike = fetch,
): LlmClient {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? LLM_TIMEOUT_MS;

  return {
    async chat(request) {
      const model = config.models[request.model];
      if (!model) return { ok: false, reason: `没配 ${request.model} 模型` };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            temperature: 0,
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return { ok: false, reason: `超时（${timeoutMs / 1000} 秒）` };
        }
        // 网络错误的信息里可能有地址，不往外传
        return { ok: false, reason: '连不上服务商' };
      }

      // 错误响应的正文不往外传（可能回显请求内容），只给状态码
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return { ok: false, reason: `超时（${timeoutMs / 1000} 秒）` };
        }
        return { ok: false, reason: '服务商返回的不是 JSON' };
      }

      const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
        ?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        return { ok: false, reason: '服务商没有返回内容' };
      }
      return { ok: true, content };
    },
  };
}

// 按 LLM_* 环境变量建 client。没配 LLM_BASE_URL 或 LLM_API_KEY 时，每次调用都返回失败
export function getLlmClient(env: Record<string, string | undefined> = process.env): LlmClient {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return { chat: async () => ({ ok: false, reason: '没配 LLM_BASE_URL 或 LLM_API_KEY' }) };
  }
  return createOpenAiCompatibleClient({
    baseUrl,
    apiKey,
    models: { vision: env.LLM_VISION_MODEL?.trim() || undefined },
  });
}
