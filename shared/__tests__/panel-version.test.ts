import { describe, it, expect, vi, afterEach } from 'vitest';
// 面板版本徽章（自动更新 spec：发版后远程确认谁已更新）。
// chrome.runtime.getManifest 在策略/crx 安装与 unpacked 下均有效；
// jsdom 测试环境无 chrome 对象 → 回退 '0.0.0' 不抛错。
import { getPanelVersion, versionBadgeHtml } from '../panel-version';

afterEach(() => { vi.unstubAllGlobals(); });

describe('面板版本徽章', () => {
  it('读 chrome.runtime.getManifest 版本', () => {
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '9.9.9' }) } });
    expect(getPanelVersion()).toBe('9.9.9');
    expect(versionBadgeHtml()).toContain('v9.9.9');
    expect(versionBadgeHtml()).toContain('data-erp-version');
  });

  it('无 chrome 对象回退 0.0.0（jsdom 测试环境），不抛错', () => {
    expect(getPanelVersion()).toBe('0.0.0');
    expect(versionBadgeHtml()).toContain('v0.0.0');
  });
});
