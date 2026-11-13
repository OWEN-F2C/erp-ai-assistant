import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamChat } from '../../shared/llm-client';

function sseResponse(lines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('streamChat', () => {
  it('无 history 时只发送单条 user 消息（向后兼容）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]']),
    );
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    for await (const c of streamChat('hello', 'deepseek', 'key', new AbortController().signal)) {
      if (c.type === 'content') chunks.push(c.text);
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(chunks).toEqual(['hi']);
  });

  it('传入 history 时拼在 prompt 之前', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']),
    );
    vi.stubGlobal('fetch', fetchMock);

    for await (const _ of streamChat('fix it', 'deepseek', 'key', new AbortController().signal,
      undefined, undefined, undefined, [
        { role: 'user', content: 'original prompt' },
        { role: 'assistant', content: 'bad json' },
      ])) { /* drain */ }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'user', content: 'original prompt' },
      { role: 'assistant', content: 'bad json' },
      { role: 'user', content: 'fix it' },
    ]);
  });
});
