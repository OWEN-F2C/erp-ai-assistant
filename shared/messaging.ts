// shared/messaging.ts
import type { ModuleMessage, BackgroundMessage } from './types';

export interface StreamController {
  onChunk: (cb: (chunkType: 'reasoning' | 'content', chunk: string) => void) => () => void;
  onDone: (cb: (result: unknown) => void) => () => void;
  onError: (cb: (msg: string) => void) => () => void;
  onLog: (cb: (step: string, message: string) => void) => () => void;
  abort: () => void;
}

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Send a module invocation to the background and return stream callbacks.
 */
export function sendModuleMessage(
  moduleId: string,
  payload: unknown,
): StreamController {
  const requestId = generateRequestId();

  const chunkCbs = new Set<(chunkType: 'reasoning' | 'content', chunk: string) => void>();
  const doneCbs = new Set<(result: unknown) => void>();
  const errorCbs = new Set<(msg: string) => void>();
  const logCbs = new Set<(step: string, message: string) => void>();

  const listener = (msg: BackgroundMessage) => {
    if (msg.requestId !== requestId) return;
    switch (msg.type) {
      case 'stream:chunk':
        chunkCbs.forEach((cb) => cb(msg.chunkType, msg.chunk));
        break;
      case 'stream:log':
        logCbs.forEach((cb) => cb(msg.step, msg.message));
        break;
      case 'stream:done':
        doneCbs.forEach((cb) => cb(msg.result));
        cleanup();
        break;
      case 'stream:error':
        errorCbs.forEach((cb) => cb(msg.message));
        cleanup();
        break;
    }
  };

  chrome.runtime.onMessage.addListener(listener);

  const cleanup = () => {
    chrome.runtime.onMessage.removeListener(listener);
  };

  const message: ModuleMessage = {
    type: 'module:invoke',
    moduleId,
    requestId,
    payload,
  };

  chrome.runtime.sendMessage(message).catch((err: Error) => {
    cleanup();
    errorCbs.forEach((cb) => cb('发送失败: ' + (err?.message || '未知错误')));
    errorCbs.clear();
  });

  return {
    onChunk(cb) {
      chunkCbs.add(cb);
      return () => chunkCbs.delete(cb);
    },
    onDone(cb) {
      doneCbs.add(cb);
      return () => doneCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
    onLog(cb) {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },
    abort() {
      chrome.runtime.sendMessage({
        type: 'module:cancel',
        moduleId,
        requestId,
      }).catch(() => {});
      cleanup();
      errorCbs.forEach((cb) => cb('请求已取消'));
      errorCbs.clear();
    },
  };
}
