import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAsinViewRows, fetchInventoryRows, localDaysAgo } from '../jijia-api';

afterEach(() => vi.unstubAllGlobals());

describe('localDaysAgo（本地时区日期）', () => {
  it('以本地日期为准，而非 UTC（北京时间凌晨时段 UTC 仍是前一天）', () => {
    const inst = new Date('2026-08-20T01:00:00+08:00'); // UTC = 2026-08-19 17:00
    vi.useFakeTimers();
    vi.setSystemTime(inst);
    const fmt = (d: Date) => d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    expect(localDaysAgo(0)).toBe(fmt(new Date()));
    const d7 = new Date(Date.now() - 7 * 86400000);
    expect(localDaysAgo(7)).toBe(fmt(d7));
    vi.useRealTimers();
  });
});

/** 按请求 body.page 返回分页行的 mock：rows 为一整页数据 */
function pagedMock(allRows: Array<Record<string, unknown>>, pagesize: number) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const page = Number(body.page ?? 1);
    const rows = allRows.slice((page - 1) * pagesize, page * pagesize);
    return new Response(JSON.stringify({ data: { rows, total: allRows.length } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('fetchAsinViewRows（asinView 端点）', () => {
  it('多市场行超过一页时持续翻页直到短页（修复静默截断）', async () => {
    // 353 行 = 17 SKU × ~21 市场（真实抓包规模），一页 200 → 需要 2 页
    const all: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 353; i++) {
      all.push({ sku: 'S' + (i % 17), marketName: 'Store' + i + ':US', unitsOrdered: 353 - i });
    }
    const fn = pagedMock(all, 200);
    vi.stubGlobal('fetch', fn);

    const rows = await fetchAsinViewRows({ skuList: ['S0'], beginDays: 30, token: 'tok' });
    expect(rows).toHaveLength(353);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('单页不满时只请求一次', async () => {
    const fn = pagedMock([{ sku: 'S1', marketName: 'X:US', unitsOrdered: 5 }], 200);
    vi.stubGlobal('fetch', fn);
    const rows = await fetchAsinViewRows({ skuList: ['S1'], beginDays: 7, token: 'tok' });
    expect(rows).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('请求体带 skuList/asinList 与日期窗口', async () => {
    const fn = pagedMock([], 200);
    vi.stubGlobal('fetch', fn);
    await fetchAsinViewRows({ skuList: ['S1'], beginDays: 7, token: 'tok' });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.skuList).toEqual(['S1']);
    expect(body.keywordsSearch.asinList).toEqual([]);
    await fetchAsinViewRows({ asinList: ['B0TEST1234'], beginDays: 30, token: 'tok' });
    const body2 = JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(body2.keywordsSearch.asinList).toEqual(['B0TEST1234']);
    expect(body2.skuList).toBeUndefined();
  });

  it('近N天窗口 = 今天−(N−1) ~ 今天 的闭区间N天（ERP口径，勿多算一天）', async () => {
    // 2026-08-25 实测：页面"近7天"显示 08-19~08-25；averageDailySales=units/N 自洽。
    // 旧实现发 today-7 起（8天量除以7）→ 日销系统性偏大 ~12.5%（用户实测 8 vs 9.1）
    const fn = pagedMock([], 200);
    vi.stubGlobal('fetch', fn);
    for (const n of [7, 14, 30, 60, 90]) {
      await fetchAsinViewRows({ skuList: ['S1'], beginDays: n, token: 'tok' });
    }
    const calls = vi.mocked(fetch).mock.calls;
    for (let i = 0; i < 5; i++) {
      const body = JSON.parse((calls[i]![1] as RequestInit).body as string);
      expect(body.beginDate).toBe(localDaysAgo([7, 14, 30, 60, 90][i]! - 1));
      expect(body.endDate).toBe(localDaysAgo(0));
    }
  });

  it('翻页有安全上限（防止接口异常导致死循环）', async () => {
    // 永远返回满页 → 必须在上限处停止
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { rows: Array.from({ length: 200 }, (_, i) => ({ sku: 'S', marketName: 'M' + i })) },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const rows = await fetchAsinViewRows({ skuList: ['S'], beginDays: 30, token: 'tok' });
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(21); // 20 页 + 兜底
    expect(rows.length).toBeLessThanOrEqual(21 * 200);
  });
});

describe('fetchInventoryRows', () => {
  it('库存行超过 pagesize 时翻页取满（修复仓库行截断）', async () => {
    // 30 SKU × 10 仓库 = 300 行 > 200
    const all: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 300; i++) {
      all.push({ sku: 'S' + (i % 30), warehouseId: i, warehouseName: 'W' + i, availableQty: 1 });
    }
    const fn = pagedMock(all, 200);
    vi.stubGlobal('fetch', fn);

    const rows = await fetchInventoryRows(['S0'], 'tok');
    expect(rows).toHaveLength(300);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('单页不满时只请求一次', async () => {
    const fn = pagedMock([{ sku: 'S1', warehouseId: 1, availableQty: 5 }], 200);
    vi.stubGlobal('fetch', fn);
    const rows = await fetchInventoryRows(['S1'], 'tok');
    expect(rows).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
