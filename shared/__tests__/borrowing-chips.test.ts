import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// 2026-09-08 国内库存按站点借用排除——面板 chips 交互（spec 验收口径）：
// chips 行渲染在参数配置区、问号带功能说明、勾选写回模块级 Set（SPA 重注入保持、
// 整页刷新=模块重载回默认）。技术点同 panel-collapse：模块级状态 → 每用例
// resetModules + 动态 import；tryInject 首次触发在 2s 后。
// 注意：面板与 marker 都挂 .erp-ai-panel 类，模拟 SPA 换页须整段替换 body.innerHTML
// （只 remove 一个 .erp-ai-panel 会删到 marker 导致 render 早退，实测踩坑）。
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); });

const PURCHASE_PAGE =
  '<div class="srm-pe-body-table"><div class="srm-pe-body-table__content">' +
  '<div class="surely-table-row"><div class="surely-table-cell-content">AB12CD</div></div>' +
  '</div></div>';
const TRANSFER_PAGE =
  '<div class="tbl-scroll-wrap"><div class="surely-table">' +
  '<div class="surely-table-row"><div class="surely-table-cell-content">B0TEST1234</div>' +
  '<div class="surely-table-cell-content">AB12CD</div></div>' +
  '</div></div>';

async function injectTransfer(): Promise<void> {
  const { render } = await import('../../modules/transfer-plan/ui');
  render(null as unknown as HTMLElement, null, document);
  vi.advanceTimersByTime(2100);
}

async function injectPurchase(): Promise<void> {
  const { render } = await import('../../modules/purchase-plan/ui');
  render(null as unknown as HTMLElement, null, document);
  vi.advanceTimersByTime(2100);
}

function chips(): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>('.erp-nl-chip');
}
function helpMark(): HTMLElement | null {
  return document.querySelector('.erp-nl-chip')?.closest('div')?.querySelector('span[title]') as HTMLElement | null;
}
function check(group: string): void {
  const cb = document.querySelector<HTMLInputElement>('.erp-nl-chip[data-group="' + group + '"]')!;
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('借用排除 chips（采购面板）', () => {
  beforeEach(() => { document.body.innerHTML = PURCHASE_PAGE; });

  it('参数配置头部渲染 chips 行 + 问号带功能说明（12 组）', async () => {
    await injectPurchase();
    expect(chips().length).toBe(12);
    const help = helpMark();
    expect(help).toBeTruthy();
    expect(help!.getAttribute('title')).toContain('不计入你的分析基数');
    expect(help!.getAttribute('title')).toContain('CN_A_US');
    expect(help!.getAttribute('title')).toContain('UK 独立');
  });

  it('采购面板头部渲染版本徽章（自动更新远程确认用）', async () => {
    await injectPurchase();
    expect(document.querySelector('[data-erp-version]')).toBeTruthy();
  });

  it('默认全不勾；勾选 US 后 SPA 重注入保持勾选态', async () => {
    await injectPurchase();
    for (const c of chips()) expect(c.checked).toBe(false);
    check('US');
    document.body.innerHTML = PURCHASE_PAGE;   // 模拟 SPA 换页（DOM 重建）
    await injectPurchase();                     // 同一模块实例
    const us = document.querySelector<HTMLInputElement>('.erp-nl-chip[data-group="US"]');
    expect(us).toBeTruthy();
    expect(us!.checked).toBe(true);
  });

  it('整页刷新语义：模块重载回默认全不勾', async () => {
    await injectPurchase();
    check('US');
    document.body.innerHTML = PURCHASE_PAGE;
    vi.resetModules();   // 整页刷新 = 模块重载
    await injectPurchase();
    expect((document.querySelector<HTMLInputElement>('.erp-nl-chip[data-group="US"]'))!.checked).toBe(false);
  });
});

describe('借用排除 chips（调拨面板）', () => {
  beforeEach(() => { document.body.innerHTML = TRANSFER_PAGE; });

  it('参数配置头部渲染 chips 行 + 问号带功能说明', async () => {
    await injectTransfer();
    expect(chips().length).toBe(12);
    expect(helpMark()!.getAttribute('title')).toContain('调拨会校验国内来源');
  });

  it('勾选 EU 后 SPA 重注入保持；模块重载回默认', async () => {
    await injectTransfer();
    check('EU');
    document.body.innerHTML = TRANSFER_PAGE;
    await injectTransfer();                     // 同一模块实例：保持勾选
    expect((document.querySelector<HTMLInputElement>('.erp-nl-chip[data-group="EU"]'))!.checked).toBe(true);
    document.body.innerHTML = TRANSFER_PAGE;
    vi.resetModules();                          // 整页刷新：回默认
    await injectTransfer();
    expect((document.querySelector<HTMLInputElement>('.erp-nl-chip[data-group="EU"]'))!.checked).toBe(false);
  });
});
