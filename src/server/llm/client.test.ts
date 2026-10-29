import { describe, expect, it } from 'vitest';
import { createOpenAiCompatibleClient, getLlmClient, type LlmChatRequest } from './client';

// tech-stack 11.2、11.3：OpenAI 兼容的 client，注入假的 fetch，不碰网络

const CONFIG = {
  baseUrl: 'https://llm.example/v1/',
  apiKey: 'test-key',
  models: { vision: 'vision-model' },
};
const REQUEST: LlmChatRequest = {
  model: 'vision',
  json: true,
  messages: [{ role: 'user', content: 'hi' }],
};

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

const completion = (content: unknown) =>
  Response.json({ choices: [{ message: { role: 'assistant', content } }] });

describe('createOpenAiCompatibleClient（tech-stack 11.2）', () => {
  it('posts to /chat/completions with bearer key, model, json mode and temperature 0', async () => {
    const { fetchImpl, calls } = fakeFetch(() => completion('{"a":1}'));
    const result = await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat(REQUEST);

    expect(result).toEqual({ ok: true, content: '{"a":1}', model: 'vision-model' });
    expect(calls[0].url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'vision-model',
      messages: REQUEST.messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  it('no json flag → no response_format', async () => {
    const { fetchImpl, calls } = fakeFetch(() => completion('ok'));
    await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat({ ...REQUEST, json: false });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('response_format');
  });

  it('HTTP 429 → failure with status only, body not passed on', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('rate limited: echo of request', { status: 429 }),
    );
    const result = await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat(REQUEST);
    expect(result).toEqual({ ok: false, reason: 'HTTP 429' });
  });

  it('11.3: times out after timeoutMs, no retry', async () => {
    const { fetchImpl, calls } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const result = await createOpenAiCompatibleClient({ ...CONFIG, timeoutMs: 20 }, fetchImpl).chat(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, reason: '超时（0.02 秒）' });
    expect(calls).toHaveLength(1);
  });

  it('network error → failure', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const result = await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat(REQUEST);
    expect(result).toEqual({ ok: false, reason: '连不上服务商' });
  });

  it('response body not JSON → failure', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>', { status: 200 }));
    const result = await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat(REQUEST);
    expect(result).toEqual({ ok: false, reason: '服务商返回的不是 JSON' });
  });

  it('no content in choices → failure', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ choices: [] }));
    const result = await createOpenAiCompatibleClient(CONFIG, fetchImpl).chat(REQUEST);
    expect(result).toEqual({ ok: false, reason: '服务商没有返回内容' });
  });

  it('model for the purpose not configured → failure without calling fetch', async () => {
    const { fetchImpl, calls } = fakeFetch(() => completion('x'));
    const result = await createOpenAiCompatibleClient({ ...CONFIG, models: {} }, fetchImpl).chat(
      REQUEST,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('getLlmClient（tech-stack 11.2）', () => {
  it.each([
    [{}],
    [{ LLM_BASE_URL: 'https://llm.example/v1' }],
    [{ LLM_API_KEY: 'k', LLM_VISION_MODEL: 'm' }],
  ])('missing LLM_BASE_URL or LLM_API_KEY → every call fails', async (env) => {
    const result = await getLlmClient(env).chat(REQUEST);
    expect(result.ok).toBe(false);
  });

  it('missing LLM_VISION_MODEL → vision call fails', async () => {
    const result = await getLlmClient({
      LLM_BASE_URL: 'https://llm.example/v1',
      LLM_API_KEY: 'k',
    }).chat(REQUEST);
    expect(result).toEqual({ ok: false, reason: '没配 vision 模型' });
  });
});
