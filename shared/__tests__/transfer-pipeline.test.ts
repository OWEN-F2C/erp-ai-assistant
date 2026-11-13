import { describe, it, expect, vi, afterEach } from 'vitest';
// 2026-09-08 调拨发运管线·结论二：调拨公式 FBA 未来供给 I = rowFutureInTransit
// + 本仓 erpWorking（调入仓"已建单将流入"计入——调拨 S 不含国内仓无双计；
// 待出库的货仍在源仓可用量里，但调拨视角的 S=FBA 可用，不含源仓）。
// 采购侧则排除 working（总盘双计）——两侧口径相反，见 AGENTS.md 管线口径节。
import { fetchAndSummarizeTransfer } from '../jijia-transfer-data';

afterEach(() => vi.unstubAllGlobals());

const ASIN = 'B0AAAAAAAA1';

function baseSalesRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    asin: ASIN, sku: 'S1', productName: '产品', marketName: 'StoreA:US', unitsOrdered: 100,
    sessions: 500, orders: 20, star: 4.5, reviewQuantity: 30, buyBoxPercentage: 80,
    returnsRate: 1, refundsRate: 1, sellingPrice: 29.9, currency: 'USD', sellingSalesRank: null,
    fbaQuantity: 40, inboundQuantity: 0, reservedCustomerOrders: 0, reservedTransfers: 0,
    reservedProcessing: 0, invAgeList: [],
    adsSpend: 0, adsSales: 0, adsItemSales: 0, adsClicks: 0, adsImpressions: 0,
    ...over,
  };
}

function stubAll(invRows: Array<Record<string, unknown>>): void {
  sessionStorage.setItem('x-auth-token', 'tok');
  const rows = [baseSalesRow({})];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('warehouseSelection')) {
      return new Response(JSON.stringify({ data: [
        { key: -1, title: '自营仓', children: [
          { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
        ] },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/asinView')) {
      return new Response(JSON.stringify({ data: { rows } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('pageQuery')) {
      return new Response(JSON.stringify({ data: { rows: invRows } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected url ' + url);
  }));
}

const US_FBA_ROW = {
  sku: 'S1', warehouseId: 201, warehouseName: 'StoreA:US_FBA', warehouseType: 'FBA',
  availableQty: 10, inTransitQty: 336, reservedQuantity: 0, singleQuantity: 16,
  purchasePlanQuantity: 0, plPoLnQty: 0,
  erpWorking: 288, erpWaitShipped: 48, erpShipped: 240, erpReceiving: 120,
};

describe('fetchAndSummarizeTransfer（调拨发运管线·结论二）', () => {
  it('FBA 在途 = 管线未来口径 + 本仓待出库：max(336,240+120)+48+working288 = 696', async () => {
    stubAll([US_FBA_ROW]);
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'US', 'StoreA');
    expect(sums[0]!.fbaInTransit).toBe(696);   // 408 + 288
    expect(sums[0]!.fbaAvailable).toBe(10);
  });

  it('fbaPipeline 携带匹配仓管线分量（已发货/待入库/待出运/待出库）', async () => {
    stubAll([US_FBA_ROW]);
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'US', 'StoreA');
    expect(sums[0]!.fbaPipeline).toEqual({ shipped: 240, receiving: 120, waitShipped: 48, working: 288 });
  });

  it('transferWaitShippedTotal = 全仓 Σ 待出运（含 THIRD 中转仓行，不进 FBA 归属）', async () => {
    stubAll([
      US_FBA_ROW,
      { sku: 'S1', warehouseId: 301, warehouseName: '云途-杭州中转仓', warehouseType: 'THIRD',
        availableQty: 28, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
        purchasePlanQuantity: 0, plPoLnQty: 0,
        erpWorking: 0, erpWaitShipped: 20, erpShipped: 0, erpReceiving: 0 },
    ]);
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'US', 'StoreA');
    expect(sums[0]!.transferWaitShippedTotal).toBe(68);   // 48 + 20
    expect(sums[0]!.fbaInTransit).toBe(696);              // THIRD 行不进 FBA 归属
  });

  it('TIKTOK_FBT 行进 FBA 归属（语义=FBA/WFS，用户口径）', async () => {
    stubAll([
      US_FBA_ROW,
      { sku: 'S1', warehouseId: 401, warehouseName: 'StoreA:US_FBT', warehouseType: 'TIKTOK_FBT',
        availableQty: 5, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
        purchasePlanQuantity: 0, plPoLnQty: 0,
        erpWorking: 0, erpWaitShipped: 0, erpShipped: 10, erpReceiving: 0 },
    ]);
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'US', 'StoreA');
    expect(sums[0]!.fbaAvailable).toBe(15);      // 10 + 5
    expect(sums[0]!.fbaInTransit).toBe(706);     // 696 + max(0, 10+0)
  });
});
