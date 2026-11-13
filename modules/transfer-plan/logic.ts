// modules/transfer-plan/logic.ts
// Transfer plan handler: receives pre-built prompt from content script,
// streams LLM response, parses result.

import type { StreamEvent, LlmSuggestion } from '../types';
import { getSettings } from '../../shared/settings';
import { streamChat } from '../../shared/llm-client';
import { parseLlmResponse } from '../../shared/llm-parser';
import { cache } from '../../shared/cache';

const LLM_CACHE_TTL = 30 * 60 * 1000;

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export async function* transferPlanHandler(
  payload: unknown,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const { prompt, pageUrl } = (payload ?? {}) as {
    prompt?: string;
    pageUrl?: string;
  };

  if (!prompt) {
    yield { type: 'error', message: '无效请求：缺少分析数据' };
    return;
  }

  // Check LLM cache
  const fingerprint = simpleHash(prompt);
  const llmCacheKey = 'llm:transfer:' + (pageUrl ?? '') + ':' + fingerprint;
  const cachedResult = await cache.get<LlmSuggestion[]>(llmCacheKey);
  if (cachedResult) {
    yield { type: 'log', step: 'llm_cache', message: '命中缓存，跳过LLM调用' };
    yield { type: 'done', result: cachedResult };
    return;
  }

  // Read settings
  const { llmProvider, llmModel, apiKey, thinkingEnabled, reasoningEffort } = await getSettings();

  if (!llmProvider || !apiKey) {
    yield { type: 'error', message: 'API Key 未配置' };
    return;
  }

  yield { type: 'log', step: 'llm_start', message: '正在调用 ' + (llmProvider || 'AI') + '/' + (llmModel || 'default') + ' 分析调拨数据…' };

  // Stream LLM
  let fullText = '';
  try {
    for await (const chunk of streamChat(
      prompt,
      llmProvider as 'deepseek',
      apiKey,
      signal,
      llmModel,
      thinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
      (reasoningEffort as 'low' | 'high' | 'max') || 'high',
    )) {
      if (chunk.type === 'content') fullText += chunk.text;
      yield { type: 'chunk', chunkType: chunk.type, data: chunk.text };
    }
  } catch (err: unknown) {
    if ((err as Error).message === 'AUTH_ERROR') {
      yield { type: 'error', message: '鉴权失败，请检查 API Key' };
      return;
    }
    throw err;
  }

  yield { type: 'log', step: 'llm_parse', message: 'AI 响应接收完成，正在解析…' };
  const suggestions = parseLlmResponse(fullText);
  yield { type: 'log', step: 'llm_parsed', message: '解析完成，获得 ' + suggestions.length + ' 条建议' };
  await cache.set(llmCacheKey, suggestions, LLM_CACHE_TTL);
  yield { type: 'done', result: suggestions };
}
