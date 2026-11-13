import { describe, it, expect, vi, afterEach } from 'vitest';
// 2026-08-28 活体探针结论（销售表现两套端点隔离实验）：
// - variationAsinView（父ASIN维度）对 UK 自 08-01 起丢失 sessions/pageViews/cvr/buyBox，
//   且部分市场（DE 30d: 2590 vs 页面 7119）流量偏低；
// - asinView（ASIN维度，ERP"销售表现"页面同源）数据完好。
//   → 面板切换到 asinView，并对同 SKU×市场的多 listing 行做合并。
import {
  fetchAsinViewRows, localDaysAgo,
} from '../jijia-api';
import {
  mergeMarketRows, aggregateRow, aggregateMarkets, backfillQualitySnapshots, buildAiPrompt,
} from '../jijia-data';
import type { SalesRow, PeriodFields, SkuSummary } from '../jijia-data';

afterEach(() => vi.unstubAllGlobals());

function row(partial: Partial<SalesRow>): SalesRow {
  return {
    sku: 'PC715SX', marketName: 'FuzzyFix_US:UK', unitsOrdered: 0, sessions: 0,
    cvr: 0, buyBoxPercentage: 0, star: 0, reviewQuantity: 0,
    returnsRate: 0, refundsRate: 0,
    sellersRank: null, fbaQuantity: 0, inboundQuantity: 0,
    reservedCustomerOrders: 0, reservedTransfers: 0, reservedProcessing: 0,
    invAgeList: [], adsSpend: 0, acos: 0, roas: 0, adsOrders: 0, naturalOrders: 0,
    adsImpressions: 0, cpc: 0, ctr: 0, pageViews: 0, orders: 0,
    adsClicks: 0, adsItemSales: 0, adsSales: 0,
    ...partial,
  } as SalesRow;
}

describe('fetchAsinViewRows（ASIN维度端点）', () => {
  it('调用 /asinView 且 groupByType=asin（不再走父ASIN维度）', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: { rows: [{ sku: 'S1', marketName: 'X:US', unitsOrdered: 5 }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fn);
    await fetchAsinViewRows({ skuList: ['S1'], beginDays: 30, token: 'tok' });
    const url = String(fn.mock.calls[0]![0]);
    expect(url).toContain('/v3/statistics/salesAnalysis/asinView');
    expect(url).not.toContain('variationAsinView');
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
    expect(body.groupByType).toBe('asin');
    expect(body.skuList).toEqual(['S1']);
  });
});

describe('mergeMarketRows（同 SKU×市场多 listing 行合并）', () => {
  // 实测 PC715SX|FuzzyFix_US:UK：两个 ASIN 各自独立 listing 与库存
  const main = row({
    unitsOrdered: 62, sessions: 373, pageViews: 600, orders: 50,
    star: 4.9, reviewQuantity: 22, buyBoxPercentage: 73.33,
    sellersRank: [{ rank: 11309, title: 'Pet Supplies' }],
    fbaQuantity: 58, inboundQuantity: 120,
    reservedCustomerOrders: 1, reservedTransfers: 0, reservedProcessing: 3,
    invAgeList: [{ label: '库龄（0~30）', value: 63 }],
    adsSpend: -100, adsSales: 300, adsClicks: 20, adsImpressions: 1000,
    returnsRate: 5, refundsRate: 4,
  });
  const second = row({
    unitsOrdered: 56, sessions: 515, pageViews: 800, orders: 45,
    star: 4.1, reviewQuantity: 130, buyBoxPercentage: 93.03,
    sellersRank: [{ rank: 24423, title: 'Pet Supplies' }],
    fbaQuantity: 13, inboundQuantity: 0,
    reservedCustomerOrders: 1, reservedTransfers: 0, reservedProcessing: 0,
    invAgeList: [{ label: '库龄（91~180）', value: 16 }],
    adsSpend: -50, adsSales: 200, adsClicks: 10, adsImpressions: 500,
    returnsRate: 10, refundsRate: 8,
  });

  it('单行原样返回（与页面一致，不重算服务端比率）', () => {
    const m = mergeMarketRows([main]);
    expect(m).toEqual(main);
  });

  it('量的字段求和：销量/sessions/订单/广告/库存快照（listing 各自独立库存）', () => {
    const m = mergeMarketRows([main, second]);
    expect(m.unitsOrdered).toBe(118);
    expect(m.sessions).toBe(888);
    expect(m.pageViews).toBe(1400);
    expect(m.orders).toBe(95);
    expect(m.fbaQuantity).toBe(71);          // 58+13：独立库存求和，非 max
    expect(m.inboundQuantity).toBe(120);
    expect(m.reservedCustomerOrders).toBe(2);
    expect(m.reservedProcessing).toBe(3);
    expect(m.adsSpend).toBe(-150);
    expect(m.adsSales).toBe(500);
  });

  it('库龄按档位求和（新老库存都保留）', () => {
    const m = mergeMarketRows([main, second]);
    const byLabel = new Map(m.invAgeList.map(a => [a.label, a.value]));
    expect(byLabel.get('库龄（0~30）')).toBe(63);
    expect(byLabel.get('库龄（91~180）')).toBe(16);
  });

  it('listing 身份快照取销量最高行：星级/评论/BSR/BuyBox', () => {
    const m = mergeMarketRows([main, second]);
    expect(m.star).toBe(4.9);
    expect(m.reviewQuantity).toBe(22);
    expect(m.buyBoxPercentage).toBe(73.33);
    expect(m.sellersRank![0]!.rank).toBe(11309);
  });

  it('比率按分量重算：cvr=订单/sessions、acos=|花费|/广告销售额；退货退款率按销量加权', () => {
    const m = mergeMarketRows([main, second]);
    expect(m.cvr).toBeCloseTo((95 / 888) * 100, 5);
    expect(m.acos).toBeCloseTo((150 / 500) * 100, 5);
    expect(m.returnsRate).toBeCloseTo((5 * 62 + 10 * 56) / 118, 5);
    expect(m.refundsRate).toBeCloseTo((4 * 62 + 8 * 56) / 118, 5);
  });

  it('流量缺失语义：全部行 null → null（缺行≠0）；任一行有值 → null 视为 0 贡献求和', () => {
    const allNull = mergeMarketRows([
      row({ sessions: null, pageViews: null, unitsOrdered: 10 }),
      row({ sessions: null, pageViews: null, unitsOrdered: 5 }),
    ]);
    expect(allNull.sessions).toBeNull();
    expect(allNull.pageViews).toBeNull();
    const partial = mergeMarketRows([
      row({ sessions: null, pageViews: null, unitsOrdered: 5 }),
      row({ sessions: 30, pageViews: 50, unitsOrdered: 5 }),
    ]);
    expect(partial.sessions).toBe(30);
    expect(partial.pageViews).toBe(50);
  });
});

describe('aggregateRow（全市场聚合的流量缺失语义与 mergeMarketRows 对齐）', () => {
  it('所有市场 sessions 均未回传（null）→ 聚合保持 null，不得伪 0（缺失≠0）', () => {
    const merged = aggregateRow(new Map([
      ['Yaoshu:UK', row({ marketName: 'Yaoshu:UK', sessions: null, pageViews: null, unitsOrdered: 59, orders: 50 })],
      ['Yaoshu:DE', row({ marketName: 'Yaoshu:DE', sessions: null, pageViews: null, unitsOrdered: 171, orders: 160 })],
    ]));
    expect(merged!.sessions).toBeNull();
    expect(merged!.pageViews).toBeNull();
  });

  it('部分市场 null 视为缺数贡献 0，其余求和', () => {
    const merged = aggregateRow(new Map([
      ['A:US', row({ marketName: 'A:US', sessions: 100, pageViews: 200, unitsOrdered: 10 })],
      ['A:DE', row({ marketName: 'A:DE', sessions: null, pageViews: null, unitsOrdered: 5 })],
    ]));
    expect(merged!.sessions).toBe(100);
    expect(merged!.pageViews).toBe(200);
  });
});

describe('aggregateMarkets（全渠道退货率按销量加权，不再 Math.max）', () => {
  it('NL 4单 25% 的小样本噪声不再顶掉全渠道值（HC586TX 30d 实测场景）', () => {
    const target = {
      star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
      bestBsrRank: null as number | null, bestBsrTitle: null as string | null,
    } as unknown as PeriodFields;
    aggregateMarkets(new Map([
      ['XIUMEI-GLOBAL:US', row({ marketName: 'XIUMEI-GLOBAL:US', unitsOrdered: 263, returnsRate: 6.84, refundsRate: 7.6 })],
      ['Yaoshu:DE', row({ marketName: 'Yaoshu:DE', unitsOrdered: 171, returnsRate: 4.68, refundsRate: 8.19 })],
      ['Yaoshu:NL', row({ marketName: 'Yaoshu:NL', unitsOrdered: 4, returnsRate: 25, refundsRate: 25 })],
    ]), target);
    expect(target.returnsRate).toBeCloseTo((6.84 * 263 + 4.68 * 171 + 25 * 4) / 438, 5);
    expect(target.returnsRate).toBeLessThan(7);   // 不再被 25% 顶掉
    expect(target.refundsRate).toBeCloseTo((7.6 * 263 + 8.19 * 171 + 25 * 4) / 438, 5);
  });

  it('全部市场零销量时保持 0（除零保护）', () => {
    const target = {
      star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
      bestBsrRank: null as number | null, bestBsrTitle: null as string | null,
    } as unknown as PeriodFields;
    aggregateMarkets(new Map([
      ['A:US', row({ unitsOrdered: 0, returnsRate: 12 })],
    ]), target);
    expect(target.returnsRate).toBe(0);
  });

  it('BSR 逐市场列出（各站独立序数不可跨市场取最小值），bestBsrRank 兼容保留', () => {
    const target = {
      star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
      bestBsrRank: null as number | null, bestBsrTitle: null as string | null,
    } as unknown as PeriodFields;
    aggregateMarkets(new Map([
      ['XIUMEI-GLOBAL:US', row({ marketName: 'XIUMEI-GLOBAL:US', unitsOrdered: 263, sellersRank: [{ rank: 168, title: 'Hair Clippers' }] })],
      ['Yaoshu:DE', row({ marketName: 'Yaoshu:DE', unitsOrdered: 171, sellersRank: [{ rank: 8000, title: 'Haustierbedarf' }] })],
      ['Yaoshu:NL', row({ marketName: 'Yaoshu:NL', unitsOrdered: 4, sellersRank: null })],
    ]), target);
    expect(target.bsrByMarket).toEqual([
      { market: 'US', mainRank: 168, title: 'Hair Clippers' },
      { market: 'DE', mainRank: 8000, title: 'Haustierbedarf' },
    ]);
    expect(target.bestBsrRank).toBe(168);   // 单站点块回退口径保留
  });
});

describe('backfillQualitySnapshots（星级/评论快照回退）', () => {
  function pmap(rows: SalesRow[]): Map<string, Map<string, SalesRow>> {
    const m = new Map<string, Map<string, SalesRow>>();
    for (const r of rows) {
      if (!m.has(r.sku)) m.set(r.sku, new Map());
      m.get(r.sku)!.set(r.marketName, r);
    }
    return m;
  }

  it('30d 行 star=0/评论=0（变体合并暂时态）时取 60d/90d 同市场的值', () => {
    const p30 = pmap([row({ sku: 'HC586TX', marketName: 'Yaoshu:UK', unitsOrdered: 59, star: 0, reviewQuantity: 0 })]);
    const p60 = pmap([row({ sku: 'HC586TX', marketName: 'Yaoshu:UK', star: 4.4, reviewQuantity: 260 })]);
    const p90 = pmap([row({ sku: 'HC586TX', marketName: 'Yaoshu:UK', star: 4.4, reviewQuantity: 260 })]);
    backfillQualitySnapshots(p30, p60, p90);
    const r = p30.get('HC586TX')!.get('Yaoshu:UK')!;
    expect(r.star).toBe(4.4);
    expect(r.reviewQuantity).toBe(260);
  });

  it('60d 缺行时回退 90d；非零值不被覆盖', () => {
    const p30 = pmap([
      row({ sku: 'S1', marketName: 'A:US', star: 0, reviewQuantity: 0 }),
      row({ sku: 'S1', marketName: 'A:DE', star: 4.3, reviewQuantity: 90 }),
    ]);
    const p90 = pmap([row({ sku: 'S1', marketName: 'A:US', star: 4.7, reviewQuantity: 33 })]);
    backfillQualitySnapshots(p30, undefined, p90);
    expect(p30.get('S1')!.get('A:US')!.star).toBe(4.7);
    expect(p30.get('S1')!.get('A:US')!.reviewQuantity).toBe(33);
    expect(p30.get('S1')!.get('A:DE')!.star).toBe(4.3);  // 原值不动
    expect(p30.get('S1')!.get('A:DE')!.reviewQuantity).toBe(90);
  });
});

describe('buildAiPrompt（流量字段 null 安全）', () => {
  function nullSummary(): SkuSummary {
    return {
      sku: 'HC586TX', productName: 'P', singleQuantity: 16,
      productionDays: 30, shippingDays: 25, sellUntilDate: '2026-11-11', bufferDays: 15,
      domesticAvailable: 0, domesticInTransit: 0, domesticReserved: 0, purchaseInTransit: 0,
      domesticWarehouses: [], fbaAvailable: 0, fbaInTransit: 0, fbaReserved: 0,
      otherAvailable: 0, otherInTransit: 0, invAgeList: [],
      totalAvailable: 0, totalInTransit: 0, totalReserved: 0,
      avgDaily7d: 2, avgDaily14d: 2, avgDaily30d: 2, avgDaily60d: 1.5, avgDaily90d: 1.9,
      sessions7d: null, sessions14d: null, sessions30d: null, sessions60d: 2814, sessions90d: 5237,
      pageViews7d: null, pageViews14d: null, pageViews30d: null, pageViews60d: 4990, pageViews90d: 8933,
      cvr7d: null, cvr14d: null, cvr30d: null, cvr60d: 3.3, cvr90d: 3.0,
      buyBox7d: null, buyBox14d: null, buyBox30d: null, buyBox60d: 55, buyBox90d: 51,
      adsSpend7d: -100, adsSpend14d: -200, adsSpend30d: -603, adsSpend60d: -3138, adsSpend90d: -12814,
      acos7d: 41, acos14d: 40, acos30d: 31, acos60d: 30, acos90d: 27,
      roas7d: 2.4, roas14d: 2.5, roas30d: 3.2, roas60d: 3.3, roas90d: 3.7,
      adsOrders7d: 2, adsOrders14d: 8, adsOrders30d: 27, adsOrders60d: 90, adsOrders90d: 250,
      naturalOrders7d: 5, naturalOrders14d: 15, naturalOrders30d: 27, naturalOrders60d: 67, naturalOrders90d: 493,
      adsImpressions7d: 17552, adsImpressions14d: 40000, adsImpressions30d: 141154, adsImpressions60d: 300000, adsImpressions90d: 700000,
      cpc7d: 0.65, cpc14d: 0.6, cpc30d: 0.67, cpc60d: 0.6, cpc90d: 0.5,
      ctr7d: 0.54, ctr14d: 0.5, ctr30d: 0.64, ctr60d: 0.6, ctr90d: 0.5,
      star: 4.4, reviewQuantity: 260, returnsRate: 6.78, refundsRate: 8.47,
      bestBsrTitle: 'Hair Clippers', bestBsrRank: 168, listingStates: [],
    } as unknown as SkuSummary;
  }

  it('流量字段为 null 时不再抛 TypeError，渲染为"缺失"', () => {
    let prompt = '';
    expect(() => { prompt = buildAiPrompt(nullSummary()); }).not.toThrow();
    expect(prompt).toContain('30d=缺失');
    expect(prompt).toContain('60d=2814');
    expect(prompt).not.toContain('30d=null');
  });

  it('包含缺失字段说明（引导 LLM 结合其他窗口判断）', () => {
    const p = buildAiPrompt(nullSummary());
    expect(p).toContain('接口未回传');
  });

  it('BSR 逐市场列出（全局/组口径优先于单值 bestBsrRank）', () => {
    const s = nullSummary();
    s.bsrByMarket = [
      { market: 'US', mainRank: 168, title: 'Hair Clippers' },
      { market: 'DE', mainRank: 8000, title: 'Haustierbedarf' },
    ];
    const p = buildAiPrompt(s);
    expect(p).toContain('BSR: US #168 / DE #8000');
    expect(p).not.toContain('BSR: Hair Clippers #168');   // 不再退化为跨市场最小值单条
  });
});
