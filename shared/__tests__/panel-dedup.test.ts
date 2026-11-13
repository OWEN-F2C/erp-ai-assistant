import { describe, it, expect, beforeEach } from 'vitest';
// 2026-09-08 用户偶遇双"AI 采购建议"面板（F5 即恢复；悬浮球只有一个=单实例，
// 根因未锁定）。去重看门狗：无论哪条路径造成重复，轮询 1s 内收敛回一个；
// 构建标记 data-erp-build 用于复发时取证（区分同实例重复 vs 跨实例残留）。
import { dedupeExtensionPanels, PANEL_CLASSES, PANEL_BUILD } from '../panel-dedup';

beforeEach(() => { document.body.innerHTML = ''; });

describe('dedupeExtensionPanels（面板去重看门狗）', () => {
  function makePanels(cls: string, count: number, tagged: boolean[]): HTMLElement[] {
    const divs: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = cls;
      if (tagged[i]) d.dataset.erpBuild = PANEL_BUILD;
      document.body.appendChild(d);
      divs.push(d);
    }
    return divs;
  }

  it('同类双面板只留一个，隐藏 marker 不受影响（marker 与面板共用类名是正常共存）', () => {
    const marker = document.createElement('span');
    marker.className = 'erp-ai-panel';
    marker.hidden = true;
    document.body.appendChild(marker);
    const divs = makePanels('erp-ai-panel', 2, [true, true]);
    const removed = dedupeExtensionPanels(document);
    expect(removed).toBe(1);
    expect(document.querySelectorAll('div.erp-ai-panel').length).toBe(1);
    expect(marker.isConnected).toBe(true);   // marker 保留（守卫依赖）
    expect(divs[0]!.isConnected || divs[1]!.isConnected).toBe(true);
  });

  it('优先保留带构建标记的面板（旧实例无标记 vs 新实例有标记）', () => {
    const old = makePanels('erp-transfer-ai-panel', 1, [false]);
    const fresh = makePanels('erp-transfer-ai-panel', 1, [true]);
    const removed = dedupeExtensionPanels(document);
    expect(removed).toBe(1);
    expect(old[0]!.isConnected).toBe(false);
    expect(fresh[0]!.isConnected).toBe(true);
  });

  it('单面板 no-op 返回 0；四类面板各各自洽', () => {
    for (const cls of PANEL_CLASSES) makePanels(cls, 1, [true]);
    expect(dedupeExtensionPanels(document)).toBe(0);
    for (const cls of PANEL_CLASSES) {
      expect(document.querySelectorAll('div.' + cls).length).toBe(1);
    }
  });
});
