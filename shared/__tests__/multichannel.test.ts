import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMultiChannelAverages, applyMultiChannelToSummaries } from '../../shared/jijia-data';
import type { SkuSummary, SiteData } from '../../shared/jijia-data';
import type { PlatformMarket } from '../../shared/api-client';

afterEach(() => vi.unstubAllGlobals());

function mockFetch(rowsFor: (platformType: string) => Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const rows = rowsFor(String(body.platformType));
    return new Response(JSON.stringify({ data: { rows } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }));
}

describe('fetchMultiChannelAverages', () => {
  it('MULTI 无 Amazon 行时自动加 AMAZON 视图合并（全渠道口径）', async () => {
    mockFetch((platformType) => platformType === 'AMAZON'
      ? [{ sku: 'S1', marketId: 1, marketName: 'X:US', platformCode: 'AMAZON', unitsOrdered: 70, orders: 10 }]
      : [{ sku: 'S1', marketId: 1000051, marketName: 'TK:US', platformCode: 'TIKTOK', unitsOrdered: 35, orders: 5 }]);
    const avg = await fetchMultiChannelAverages(['S1'], 'tok');
    expect(avg.get('S1')!.avgDaily7d).toBe(15); // (70+35)/7
    expect(avg.get('S1')!.avgDaily30d).toBe(3.5); // (70+35)/30
  });

  it('带 platformMarketList 时不合并 AMAZON 视图（站点口径）', async () => {
    mockFetch(() => [{ sku: 'S1', marketId: 1000051, marketName: 'TK:US', platformCode: 'TIKTOK', unitsOrdered: 35, orders: 5 }]);
    const avg = await fetchMultiChannelAverages(['S1'], 'tok', [1000051]);
    expect(avg.get('S1')!.avgDaily7d).toBe(5); // 35/7，无 AMAZON 合并
  });

  it('MULTI 仅部分 SKU 含 Amazon 行时只补齐缺失的 SKU', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const pt = String(body.platformType);
      let rows: Array<Record<string, unknown>>;
      if (pt === 'MULTI') {
        rows = [
          { sku: 'S1', marketId: 1, marketName: 'X:US', platformCode: 'AMAZON', unitsOrdered: 70, orders: 10 },
          { sku: 'S2', marketId: 1000051, marketName: 'TK:US', platformCode: 'TIKTOK', unitsOrdered: 14, orders: 2 },
        ];
      } else {
        const skuList = (body.keywordsSearch as { skuList: string[] }).skuList;
        rows = skuList.map((s) => ({ sku: s, marketId: 2, marketName: 'Y:US', platformCode: 'AMAZON', unitsOrdered: 56, orders: 8 }));
      }
      return new Response(JSON.stringify({ data: { rows } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const avg = await fetchMultiChannelAverages(['S1', 'S2'], 'tok');
    expect(avg.get('S1')!.avgDaily7d).toBe(10); // 70/7，MULTI 已含 Amazon
    expect(avg.get('S2')!.avgDaily7d).toBe(10); // (14+56)/7，补齐缺失 SKU
  });

  it('五个时间窗口并行请求（不再串行等待）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response(JSON.stringify({
        data: { rows: [{ sku: 'S1', marketId: 1, marketName: 'X:US', platformCode: 'AMAZON', unitsOrdered: 7, orders: 1 }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const avg = await fetchMultiChannelAverages(['S1'], 'tok');
    expect(avg.get('S1')!.avgDaily7d).toBe(1); // 7/7，结果正确
    expect(maxInFlight).toBeGreaterThanOrEqual(3); // 5 窗口明显并行（串行时恒为 1）
  });
});

describe('applyMultiChannelToSummaries', () => {
  it('覆盖全渠道日均并追加多渠道站点块（含映射仓库存）', () => {
    const s: SkuSummary = {
      sku: 'S1', productName: 'P', singleQuantity: 16,
      productionDays: 30, shippingDays: 25, sellUntilDate: '2026-11-11', bufferDays: 15,
      domesticAvailable: 0, domesticInTransit: 0, domesticReserved: 0, purchaseInTransit: 0,
    otherAvailable: 0, otherInTransit: 0, domesticWarehouses: [],
      fbaAvailable: 0, fbaInTransit: 0, fbaReserved: 0, invAgeList: [],
      totalAvailable: 0, totalInTransit: 0, totalReserved: 0,
      transferWaitShippedTotal: 0,
      avgDaily7d: 1, avgDaily14d: 1, avgDaily30d: 1, avgDaily60d: 1, avgDaily90d: 1,
      sessions7d: 0, sessions14d: 0, sessions30d: 0, sessions60d: 0, sessions90d: 0,
      pageViews7d: 0, pageViews14d: 0, pageViews30d: 0, pageViews60d: 0, pageViews90d: 0,
      cvr7d: 0, cvr14d: 0, cvr30d: 0, cvr60d: 0, cvr90d: 0,
      buyBox7d: 0, buyBox14d: 0, buyBox30d: 0, buyBox60d: 0, buyBox90d: 0,
      adsSpend7d: 0, adsSpend14d: 0, adsSpend30d: 0, adsSpend60d: 0, adsSpend90d: 0,
      acos7d: 0, acos14d: 0, acos30d: 0, acos60d: 0, acos90d: 0,
      roas7d: 0, roas14d: 0, roas30d: 0, roas60d: 0, roas90d: 0,
      adsOrders7d: 0, adsOrders14d: 0, adsOrders30d: 0, adsOrders60d: 0, adsOrders90d: 0,
      naturalOrders7d: 0, naturalOrders14d: 0, naturalOrders30d: 0, naturalOrders60d: 0, naturalOrders90d: 0,
      adsImpressions7d: 0, adsImpressions14d: 0, adsImpressions30d: 0, adsImpressions60d: 0, adsImpressions90d: 0,
      cpc7d: 0, cpc14d: 0, cpc30d: 0, cpc60d: 0, cpc90d: 0,
      ctr7d: 0, ctr14d: 0, ctr30d: 0, ctr60d: 0, ctr90d: 0,
      star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
      bestBsrTitle: null, bestBsrRank: null, listingStates: [],
      warehouseDetail: [
        { name: 'CN_A_Tiktok', available: 100, inTransit: 10 },
        { name: 'US-Tiktok-FBT虚拟仓', available: 200, inTransit: 20 },
      ],
    };
    const mkts: PlatformMarket[] = [{
      id: '1000051', text: 'SUPRENT PRO ACCU:US', group: 'TIKTOK',
      groupAlias: 'Tiktok自运营', country: 'US', deleteMarket: 0,
    }];
    applyMultiChannelToSummaries(
      [s],
      new Map([['S1', { avgDaily7d: 9, avgDaily14d: 8, avgDaily30d: 7, avgDaily60d: 6, avgDaily90d: 5 }]]),
      new Map([['1000051', new Map([['S1', { avgDaily7d: 3, avgDaily14d: 3, avgDaily30d: 3, avgDaily60d: 3, avgDaily90d: 3 }]])]]),
      mkts,
    );
    expect(s.avgDaily7d).toBe(9); // 全渠道日均被覆盖
    const sd: SiteData | undefined = s.siteDatas?.find(x => x.site === '1000051');
    expect(sd).toBeDefined();
    expect(sd!.multichannelOnly).toBe(true);
    expect(sd!.fbaAvailable).toBe(300); // 国内100 + FBT200
    expect(sd!.fbaInTransit).toBe(30);  // 国内10 + FBT20
    expect(sd!.avgDaily7d).toBe(3);
  });
});
