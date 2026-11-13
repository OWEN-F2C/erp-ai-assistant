// shared/__tests__/messaging.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendModuleMessage } from '../messaging';
import type { BackgroundMessage } from '../types';

// Mock chrome.runtime
const mockListeners = new Set<(msg: unknown) => void>();
const mockSendMessage = vi.fn().mockReturnValue(Promise.resolve());

vi.stubGlobal('chrome', {
  runtime: {
    onMessage: {
      addListener: (fn: unknown) => mockListeners.add(fn as (msg: unknown) => void),
      removeListener: (fn: unknown) => mockListeners.delete(fn as (msg: unknown) => void),
    },
    sendMessage: mockSendMessage,
  },
});

describe('sendModuleMessage', () => {
  beforeEach(() => {
    mockListeners.clear();
    mockSendMessage.mockClear();
  });

  it('sends a module message on creation', () => {
    sendModuleMessage('test-module', { data: 1 });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const call = mockSendMessage.mock.calls[0]![0];
    expect(call.type).toBe('module:invoke');
    expect(call.moduleId).toBe('test-module');
  });

  it('routes stream:chunk to onChunk callback', () => {
    const ctrl = sendModuleMessage('test', {});
    const chunks: string[] = [];
    ctrl.onChunk((_type, c) => chunks.push(c));

    // Simulate background response
    const listener = [...mockListeners][0]!;
    const chunkMsg: BackgroundMessage = {
      type: 'stream:chunk',
      requestId: mockSendMessage.mock.calls[0]![0].requestId,
      chunkType: 'content',
      chunk: 'hello',
    };
    listener(chunkMsg);

    expect(chunks).toEqual(['hello']);
  });

  it('routes stream:done and cleans up listener', () => {
    const ctrl = sendModuleMessage('test', {});
    const results: unknown[] = [];
    ctrl.onDone((r) => results.push(r));

    const listener = [...mockListeners][0]!;
    const doneMsg: BackgroundMessage = {
      type: 'stream:done',
      requestId: mockSendMessage.mock.calls[0]![0].requestId,
      result: { ok: true },
    };
    listener(doneMsg);

    expect(results).toEqual([{ ok: true }]);
    expect(mockListeners.size).toBe(0); // cleaned up
  });

  it('ignores messages with different requestId', () => {
    const ctrl = sendModuleMessage('test', {});
    const chunks: string[] = [];
    ctrl.onChunk((c) => chunks.push(c));

    const listener = [...mockListeners][0]!;
    listener({ type: 'stream:chunk', requestId: 'wrong-id', chunk: 'nope' });

    expect(chunks).toEqual([]);
  });
});
