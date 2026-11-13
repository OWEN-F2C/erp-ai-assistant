import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 2026-09-03 用户报"获取数据失败: Extension context invalidated"——扩展重载/更新后，
// 旧页面里的旧内容脚本上下文失效，chrome.storage 抛英文错误被原样展示。
// 修复：探测失效（chrome.runtime.id 变 undefined）→ 面板替换为"请刷新页面"提示，
// 分析路径兜底识别该错误。jsdom 面板测试注入时带 runtime.id（有效）、随后改写
// stub 模拟失效；现有其他面板测试的 chrome stub 无 runtime（hadContext=false）不触发。
import { isExtensionContextValid, isExtensionContextInvalidatedError, extensionInvalidatedNoticeHtml } from '../extension-context';

afterEach(() => vi.unstubAllGlobals());

describe('isExtensionContextValid', () => {
  it('runtime.id 存在 → true；id 变 undefined（重载后旧上下文）→ false', () => {
    vi.stubGlobal('chrome', { storage: {}, runtime: { id: 'abc' } });
    expect(isExtensionContextValid()).toBe(true);
    vi.stubGlobal('chrome', { storage: {}, runtime: { id: undefined as unknown as string } });
    expect(isExtensionContextValid()).toBe(false);
  });

  it('chrome/runtime 不存在（测试环境/异常）不抛错 → false', () => {
    vi.stubGlobal('chrome', { storage: {} });
    expect(isExtensionContextValid()).toBe(false);
  });

  it('提示文案包含刷新指引', () => {
    const html = extensionInvalidatedNoticeHtml();
    expect(html).toContain('扩展已更新');
    expect(html).toContain('刷新页面');
  });

  it('错误识别：仅匹配 Extension context invalidated', () => {
    expect(isExtensionContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(true);
    expect(isExtensionContextInvalidatedError(new Error('fetch failed'))).toBe(false);
    expect(isExtensionContextInvalidatedError('not an error')).toBe(false);
  });
});

describe('采购面板上下文失效自检（jsdom）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML =
      '<div class="srm-pe-body-table"><div class="srm-pe-body-table__content"><div class="surely-table-body"></div></div></div>';
  });
  afterEach(() => vi.useRealTimers());

  it('注入时有效、重载后（runtime.id 消失）面板替换为刷新提示并停轮询', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-1' },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    });
    const { render } = await import('../../modules/purchase-plan/ui');
    render(null as unknown as HTMLElement, null, document);
    await vi.advanceTimersByTimeAsync(2100);
    const body = document.querySelector('#erp-ai-body') as HTMLElement;
    expect(body.textContent).not.toContain('扩展已更新');

    // 模拟扩展重载：旧上下文的 chrome.runtime.id 变 undefined
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => { throw new Error('Extension context invalidated.'); }), set: vi.fn(async () => undefined) } },
    });
    await vi.advanceTimersByTimeAsync(2200);
    expect(body.textContent).toContain('扩展已更新');
    expect(body.textContent).toContain('刷新页面');
  });

  it('注入时本就无 runtime（测试环境常态）不误报', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    });
    const { render } = await import('../../modules/purchase-plan/ui');
    render(null as unknown as HTMLElement, null, document);
    await vi.advanceTimersByTimeAsync(4200);
    const body = document.querySelector('#erp-ai-body') as HTMLElement;
    expect(body.textContent).not.toContain('扩展已更新');
  });
});
