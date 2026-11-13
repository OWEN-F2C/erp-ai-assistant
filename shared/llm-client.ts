// shared/llm-client.ts
import type { LlmProvider } from './types';

const PROVIDER_CONFIG: Record<LlmProvider, { baseUrl: string; defaultModel: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
};

export interface StreamChunk {
  type: 'reasoning' | 'content';
  text: string;
}

export function getBaseUrl(provider: LlmProvider): string {
  return PROVIDER_CONFIG[provider].baseUrl;
}

export async function* streamChat(
  prompt: string,
  provider: LlmProvider,
  apiKey: string,
  signal: AbortSignal,
  model?: string,
  thinking?: { type: 'enabled' | 'disabled' },
  reasoningEffort?: 'low' | 'high' | 'max',
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): AsyncGenerator<StreamChunk> {
  const config = PROVIDER_CONFIG[provider];
  const useModel = model || config.defaultModel;

  const messages = [...(history ?? []), { role: 'user', content: prompt }];
  const reqBody: Record<string, unknown> = {
    model: useModel,
    messages,
    stream: true,
  };
  if (thinking) reqBody.thinking = thinking;
  if (reasoningEffort) reqBody.reasoning_effort = reasoningEffort;

  const body = JSON.stringify(reqBody);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const endpoint = `${config.baseUrl}/chat/completions`;

  // Combine caller signal with a 300s internal timeout
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 300_000);
  const onExternalAbort = () => ctrl.abort();
  signal.addEventListener('abort', onExternalAbort, { once: true });

  let response: Response;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    signal.removeEventListener('abort', onExternalAbort);
    if (response.status === 401 || response.status === 403) {
      throw new Error('AUTH_ERROR');
    }
    throw new Error(`LLM API error: ${response.status}`);
  }

  reader = response.body?.getReader();
  if (!reader) { signal.removeEventListener('abort', onExternalAbort); throw new Error('No response body'); }

  // Re-register abort listener for stream-reading phase: cancel reader immediately
  signal.removeEventListener('abort', onExternalAbort);
  const onAbortStream = () => reader.cancel();
  signal.addEventListener('abort', onAbortStream, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';

  // Watchdog: abort if the stream stalls (no data for 300s after headers arrive)
  let lastActivity = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > 300_000) ctrl.abort();
  }, 10_000);

  try {
    while (true) {
      if (signal.aborted) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
          if (delta?.content) yield { type: 'content', text: delta.content };
        } catch {
          // skip unparseable chunks
        }
      }
    }
  } finally {
    clearInterval(watchdog);
    signal.removeEventListener('abort', onAbortStream);
    reader.releaseLock();
  }
}
