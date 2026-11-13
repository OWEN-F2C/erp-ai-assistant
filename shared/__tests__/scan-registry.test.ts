import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// 2026-09-02 用户报 bug：采购页参数配置的 SKU 数量随表格滚动条变化——
// 产品明细表是长列表窗口化渲染（滚动时 DOM 里可见行集变化），逐次扫描
// 直接重建列表导致跳变；调拨页列表短未触发，但同款扫描有同样隐患。
// 修复：累计登记表（扫描取并集，列表稳定）+ 分析前滚表全量对账（剔除已删行）。
import { createScanRegistry, findTableScroller, sweepTableScroller } from '../scan-registry';

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('createScanRegistry（累计登记 + 滚表对账）', () => {
  it('merge 取并集：后见不丢先见（滚动窗口变化时列表稳定），保持首见顺序', () => {
    const reg = createScanRegistry<string>();
    expect(reg.merge(['A', 'B'])).toEqual(['A', 'B']);
    expect(reg.merge(['B', 'C'])).toEqual(['A', 'B', 'C']);   // 窗口滚走 A 仍保留
    expect(reg.merge(['C'])).toEqual(['A', 'B', 'C']);
  });

  it('sweep 对账：滚表期间未见过的（已删除行）被剔除，见过的保留', () => {
    const reg = createScanRegistry<string>();
    reg.merge(['A', 'B', 'C']);
    reg.beginSweep();
    reg.merge(['B']);        // 全量滚表只见到 B（A/C 已被用户删除）
    reg.merge(['B', 'D']);   // 新增 D
    expect(reg.endSweep()).toEqual(['B', 'D']);
    // 对账后继续正常累计
    expect(reg.merge(['B', 'D', 'E'])).toEqual(['B', 'D', 'E']);
  });

  it('keyOf 去重（对象条目按业务键）', () => {
    const reg = createScanRegistry<{ asin: string; sku: string }>((x) => x.asin);
    reg.merge([{ asin: 'B0X', sku: 'S1' }]);
    expect(reg.merge([{ asin: 'B0X', sku: 'S1-dup' }, { asin: 'B0Y', sku: 'S2' }]))
      .toEqual([{ asin: 'B0X', sku: 'S1' }, { asin: 'B0Y', sku: 'S2' }]);
  });

  it('未 beginSweep 直接 endSweep 是无害的（快照语义）', () => {
    const reg = createScanRegistry<string>();
    reg.merge(['A']);
    expect(reg.endSweep()).toEqual(['A']);
  });
});

describe('sweepTableScroller（程序化滚表让每行进过 DOM）', () => {
  it('逐步滚动并在每步回调采集，结束后恢复原滚动位置', async () => {
    const body = document.createElement('div');
    body.className = 'surely-table-body';
    document.body.appendChild(body);
    body.scrollTop = 50;   // 用户停在中间

    let calls = 0;
    const seen: number[] = [];
    const p = sweepTableScroller(body, () => { calls++; seen.push(body.scrollTop); });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(calls).toBeGreaterThanOrEqual(2);   // jsdom 无布局：顶步 + 底部再采
    expect(body.scrollTop).toBe(50);           // 恢复用户位置
    body.remove();
  });

  it('findTableScroller：优先返回有实际滚动量的表格体，否则首个兜底', () => {
    document.body.innerHTML =
      '<div class="surely-table-body" id="no-scroll"></div>' +
      '<div class="surely-table-body" id="yes-scroll"></div>';
    // jsdom 无布局（scrollHeight 恒 0），两个都无滚动量 → 兜底首个
    const el1 = findTableScroller(document);
    expect(el1 && el1.id).toBe('no-scroll');
    // 有滚动量的优先（模拟：直接定义属性）
    const yes = document.getElementById('yes-scroll') as HTMLElement;
    Object.defineProperty(yes, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(yes, 'clientHeight', { value: 200, configurable: true });
    const el2 = findTableScroller(document);
    expect(el2 && el2.id).toBe('yes-scroll');
  });
});

describe('采购面板 SKU 登记（jsdom 行为）', () => {
  function stubProductRows(skus: string[]): void {
    const wrap = document.createElement('div');
    wrap.className = 'srm-pe-body-table';
    const content = document.createElement('div');
    content.className = 'srm-pe-body-table__content';
    const tbody = document.createElement('div');
    tbody.className = 'surely-table-body';
    for (const s of skus) {
      const row = document.createElement('div');
      row.className = 'surely-table-row';
      row.dataset.sku = s;
      const cell = document.createElement('div');
      cell.className = 'surely-table-cell-content';
      cell.textContent = s;
      row.appendChild(cell);
      tbody.appendChild(row);
    }
    content.appendChild(tbody);
    wrap.appendChild(content);
    document.body.appendChild(wrap);
  }

  async function injectPurchase(): Promise<void> {
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { render } = await import('../../modules/purchase-plan/ui');
    render(null as unknown as HTMLElement, null, document);
    await vi.advanceTimersByTimeAsync(2100);
  }

  it('滚动窗口变化后参数配置列表不缩（登记表取并集）', async () => {
    stubProductRows(['PC715SX', 'HC586TX']);
    await injectPurchase();
    const inputs = document.querySelector('#erp-ai-inputs') as HTMLElement;
    expect(inputs.textContent).toContain('PC715SX');
    expect(inputs.textContent).toContain('HC586TX');

    // 模拟窗口化：滚走 HC586TX 行（DOM 移除），下一次扫描不得把它从参数配置里丢掉
    // （选择器限定表格行——面板参数输入框同样带 data-sku，不能误删）
    const row = document.querySelector('.surely-table-row[data-sku="HC586TX"]');
    row?.remove();
    await vi.advanceTimersByTimeAsync(2200);
    expect(inputs.textContent).toContain('HC586TX');   // 旧实现：重建后消失
  });

  it('点「开始分析」滚表对账：已删除的行被剔除（全量扫描未见）', async () => {
    stubProductRows(['PC715SX', 'HC586TX']);
    await injectPurchase();
    // 限定表格行（面板输入框也带 data-sku）
    document.querySelector('.surely-table-row[data-sku="HC586TX"]')?.remove();   // 用户删行
    (document.querySelector('#erp-ai-btn') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(4000);                    // 滚表 + 拉数据(拒绝)
    const inputs = document.querySelector('#erp-ai-inputs') as HTMLElement;
    expect(inputs.textContent).not.toContain('HC586TX');        // 对账剔除
    expect(inputs.textContent).toContain('PC715SX');
  });
});

describe('调拨面板 ASIN 登记（jsdom 行为）', () => {
  function stubProductRows(pairs: Array<{ asin: string; sku: string }>): void {
    const table = document.createElement('div');
    table.className = 'surely-table';
    const tbody = document.createElement('div');
    tbody.className = 'surely-table-body';
    for (const p of pairs) {
      const row = document.createElement('div');
      row.className = 'surely-table-row';
      const a = document.createElement('div');
      a.className = 'surely-table-cell-content';
      a.textContent = p.asin;
      const s = document.createElement('div');
      s.className = 'surely-table-cell-content';
      s.textContent = p.sku;
      row.appendChild(a); row.appendChild(s);
      row.dataset.asin = p.asin;
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    document.body.appendChild(table);
  }

  async function injectTransfer(): Promise<void> {
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { render } = await import('../../modules/transfer-plan/ui');
    render(null as unknown as HTMLElement, null, document);
    await vi.advanceTimersByTimeAsync(2100);
  }

  it('窗口滚走的 ASIN 保留在参数配置；点分析后对账剔除已删行', async () => {
    stubProductRows([
      { asin: 'B0AAAAAAA1', sku: 'HC586TX' },
      { asin: 'B0BBBBBBB2', sku: 'PC715SX' },
    ]);
    await injectTransfer();
    const inputs = document.querySelector('#erp-transfer-inputs') as HTMLElement;
    expect(inputs.textContent).toContain('B0AAAAAAA1');
    expect(inputs.textContent).toContain('B0BBBBBBB2');

    // 限定表格行（面板输入框也带 data-asin）
    document.querySelector('.surely-table-row[data-asin="B0AAAAAAA1"]')?.remove();   // 模拟窗口滚走
    await vi.advanceTimersByTimeAsync(2200);
    expect(inputs.textContent).toContain('B0AAAAAAA1');             // 登记表保留

    (document.querySelector('#erp-transfer-analyze') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(4000);                        // 滚表对账（B0AAAAAAA1 已删）
    expect(inputs.textContent).not.toContain('B0AAAAAAA1');
    expect(inputs.textContent).toContain('B0BBBBBBB2');
  });
});
