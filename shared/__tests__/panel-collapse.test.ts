import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// 2026-08-28 方案A（用户拍板）：AI 面板默认收起成细头部栏，不再挤占 ERP 原生
// SKU 表格（调拨页实测：面板插在虚拟表格滚动容器内，展开后 SKU 列表无法下拉）。
// 展开限高 30vh 内滚；「开始/追加分析」点击自动展开；折叠状态存模块级变量，
// SPA 切页重注入保持（整页刷新回默认收起）。
// 技术点：两面板 tryInject 由 setTimeout(2000) 首次触发 → 假时钟推进；
// 折叠状态在模块级 → 每个用例 vi.resetModules() 后动态 import 拿全新模块
// （SPA 用例外——它要的就是同一模块实例跨两次注入）。
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); });

async function injectTransfer(): Promise<void> {
  const { render } = await import('../../modules/transfer-plan/ui');
  render(null as unknown as HTMLElement, null, document);
  vi.advanceTimersByTime(2100);   // 首次 tryInject 在 2s 后
}

async function injectPurchase(): Promise<void> {
  const { render } = await import('../../modules/purchase-plan/ui');
  render(null as unknown as HTMLElement, null, document);
  vi.advanceTimersByTime(2100);
}

describe('调拨面板折叠（默认收起，不挤占原生表格）', () => {
  beforeEach(() => {
    // 模拟真实层级：body > 虚拟表格滚动容器 > .surely-table
    document.body.innerHTML = '<div class="tbl-scroll-wrap"><div class="surely-table"></div></div>';
  });

  function bodyDiv(): HTMLElement {
    return document.querySelector('#erp-tp-body') as HTMLElement;
  }
  function toggleBtn(): HTMLButtonElement {
    return document.querySelector('#erp-tp-collapse') as HTMLButtonElement;
  }

  it('注入后默认收起：内容区隐藏只剩头部栏，折叠钮显示 +', async () => {
    await injectTransfer();
    const body = bodyDiv();
    expect(body).toBeTruthy();
    expect(body.style.display).toBe('none');       // 默认收起（旧实现 display:''）
    expect(toggleBtn().textContent).toBe('+');
  });

  it('展开限高 30vh 内滚（output 不再有独立 420px 滚动，避免双滚动条）', async () => {
    await injectTransfer();
    const body = bodyDiv();
    expect(body.style.maxHeight).toBe('30vh');
    expect(body.style.overflowY).toBe('auto');
    const out = document.querySelector('#erp-transfer-output') as HTMLElement;
    expect(out.style.maxHeight).toBe('');
  });

  it('点折叠钮展开/再收起；收起时点「开始分析」自动展开', async () => {
    await injectTransfer();
    toggleBtn().click();
    expect(bodyDiv().style.display).toBe('');
    expect(toggleBtn().textContent).toBe('−');
    toggleBtn().click();
    expect(bodyDiv().style.display).toBe('none');

    // 收起状态点分析：自动展开（即便没检测到 ASIN 走早退分支，也已展开）
    (document.querySelector('#erp-transfer-analyze') as HTMLButtonElement).click();
    expect(bodyDiv().style.display).toBe('');
  });

  it('SPA 重注入保持上次展开状态（模块级变量，整页刷新才回默认收起）', async () => {
    await injectTransfer();
    toggleBtn().click();                            // 展开并保持
    document.body.innerHTML = '<div class="tbl-scroll-wrap"><div class="surely-table"></div></div>';  // 模拟 SPA 换页（面板随之移除）
    await injectTransfer();                         // resetModules 不触发——同一用例内同一模块
    expect(bodyDiv().style.display).toBe('');       // 仍展开
  });

  it('插入点在表格包装层之外（不再插进虚拟表格滚动容器内部）', async () => {
    await injectTransfer();
    const panel = document.querySelector('div.erp-transfer-ai-panel') as HTMLElement;
    const table = document.querySelector('.surely-table') as HTMLElement;
    // 面板与表格的包装层（table.parentElement）同级，而非与表格同级（容器内部）
    expect(panel.parentElement).toBe(table.parentElement!.parentElement);
    expect(panel.nextElementSibling).toBe(table.parentElement);
  });
});

describe('采购面板折叠（同款处理）', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="srm-pe-body-table"><div class="srm-pe-body-table__content"></div></div>';
  });

  function bodyDiv(): HTMLElement {
    return document.querySelector('#erp-ai-body') as HTMLElement;
  }
  function toggleBtn(): HTMLButtonElement {
    return document.querySelector('#erp-ai-collapse') as HTMLButtonElement;
  }

  it('注入后默认收起，点「开始分析」自动展开', async () => {
    await injectPurchase();
    expect(bodyDiv().style.display).toBe('none');
    (document.querySelector('#erp-ai-btn') as HTMLButtonElement).click();
    expect(bodyDiv().style.display).toBe('');
  });

  it('折叠钮切换 + 展开限高 30vh', async () => {
    await injectPurchase();
    expect(bodyDiv().style.maxHeight).toBe('30vh');
    expect(bodyDiv().style.overflowY).toBe('auto');
    toggleBtn().click();
    expect(bodyDiv().style.display).toBe('');
    expect(toggleBtn().textContent).toBe('−');
  });
});
