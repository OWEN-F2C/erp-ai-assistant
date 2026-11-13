import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '../../modules/purchase-plan-generator/ui';

afterEach(() => vi.unstubAllGlobals());

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
}

describe('render() document 级监听器生命周期', () => {
  it('重复 render（SPA 重注入）释放上一次 render 的 document/window 级监听器', () => {
    stubChrome();
    const doc = document.implementation.createHTMLDocument('test');
    const signals: AbortSignal[] = [];
    const orig = doc.addEventListener.bind(doc);
    vi.spyOn(doc, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (typeof options === 'object' && options?.signal) {
          signals.push(options.signal);
        }
        return orig(type, listener, options);
      },
    );

    render(null as unknown as HTMLElement, null, doc);
    expect(signals.length).toBeGreaterThanOrEqual(1); // document 级监听带生命周期信号

    render(null as unknown as HTMLElement, null, doc);
    // 第一次 render 的信号已被 abort——旧监听器（闭包持有整棵旧 panel DOM）随之移除
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[signals.length - 1]!.aborted).toBe(false);
  });
});
