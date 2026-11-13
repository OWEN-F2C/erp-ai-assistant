import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSettings } from '../settings';

afterEach(() => vi.unstubAllGlobals());

function stubChromeSettings(stored: unknown): void {
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({ settings: stored })) } },
  });
}

describe('getSettings（存量数据合并默认值）', () => {
  it('老版本存量 settings 缺新字段时按 DEFAULT_SETTINGS 兜底，已存值不覆盖', async () => {
    // 1.4.0 之前保存的 settings 没有 thinkingEnabled/reasoningEffort/marketGroups/autoGenerate
    stubChromeSettings({ llmProvider: 'deepseek', llmModel: 'deepseek-chat', apiKey: 'sk-x', purchaseModule: true });
    const s = await getSettings();
    expect(s.apiKey).toBe('sk-x');
    expect(s.llmProvider).toBe('deepseek');
    expect(s.thinkingEnabled).toBe(true);
    expect(s.reasoningEffort).toBe('high');
    expect(s.marketGroups).toEqual([]);
    expect(s.autoGenerate).toBe(false);
    expect(s.profitModule).toBe(true); // 净利润看板开关默认开（老配置自动补齐）
    expect(s.uiScale).toBe(1);          // 面板缩放默认 100%（老配置自动补齐）
  });

  it('用户调过面板缩放时保留', async () => {
    stubChromeSettings({ apiKey: 'sk-x', uiScale: 1.3 });
    const s = await getSettings();
    expect(s.uiScale).toBe(1.3);
  });

  it('用户显式关闭 profitModule 时保留 false', async () => {
    stubChromeSettings({ apiKey: 'sk-x', profitModule: false });
    const s = await getSettings();
    expect(s.profitModule).toBe(false);
  });

  it('用户显式关闭 thinkingEnabled 时保留 false', async () => {
    stubChromeSettings({ apiKey: 'sk-x', thinkingEnabled: false, reasoningEffort: 'low' });
    const s = await getSettings();
    expect(s.thinkingEnabled).toBe(false);
    expect(s.reasoningEffort).toBe('low');
  });

  it('无任何存量数据 → 全默认', async () => {
    stubChromeSettings(undefined);
    const s = await getSettings();
    expect(s.apiKey).toBe('');
    expect(s.purchaseModule).toBe(true);
    expect(s.thinkingEnabled).toBe(true);
  });
});
