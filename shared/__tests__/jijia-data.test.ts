import { describe, it, expect } from 'vitest';
import { aggregateRow, aggregateMarkets } from '../jijia-data';
import type { SalesRow, PeriodFields } from '../jijia-data';

function row(partial: Partial<SalesRow>): SalesRow {
  return {
    sku: 'S1', marketName: 'X:US', unitsOrdered: 0, sessions: 0,
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

describe('aggregateRow（跨市场合并）', () => {
  it('非累加字段从合并分量重算：acos/roas/cpc/ctr（广告销售额=adsSales，花费为负取绝对值）', () => {
    const merged = aggregateRow(new Map([
      ['A:US', row({
        adsSpend: -30, adsSales: 300, adsItemSales: 999, adsClicks: 10, adsImpressions: 1000,
        orders: 10, sessions: 200, acos: 10, roas: 10, cpc: 3, ctr: 1,
      })],
      ['B:DE', row({
        adsSpend: -20, adsSales: 100, adsItemSales: 888, adsClicks: 15, adsImpressions: 1000,
        orders: 5, sessions: 300, acos: 20, roas: 5, cpc: 1.33, ctr: 1.5,
      })],
    ]));
    expect(merged).not.toBeNull();
    // 汇总分量：|spend|=50, adsSales=400, clicks=25, impressions=2000, orders=15, sessions=500
    expect(merged!.acos).toBeCloseTo(12.5, 5);   // 50/400×100
    expect(merged!.roas).toBeCloseTo(8, 5);      // 400/50
    expect(merged!.cpc).toBeCloseTo(2, 5);       // 50/25
    expect(merged!.ctr).toBeCloseTo(1.25, 5);    // 25/2000×100
    expect(merged!.cvr).toBeCloseTo(3, 5);       // 15/500×100
  });

  it('累加字段求和', () => {
    const merged = aggregateRow(new Map([
      ['A:US', row({ unitsOrdered: 10, adsSpend: 30, orders: 4 })],
      ['B:DE', row({ unitsOrdered: 15, adsSpend: 20, orders: 6 })],
    ]));
    expect(merged!.unitsOrdered).toBe(25);
    expect(merged!.adsSpend).toBe(50);
    expect(merged!.orders).toBe(10);
  });

  it('空入参返回 null', () => {
    expect(aggregateRow(undefined)).toBeNull();
    expect(aggregateRow(new Map())).toBeNull();
  });
});

describe('aggregateMarkets（质量字段聚合）', () => {
  it('reviewQuantity 不与 aggregateRow 的求和重复累加', () => {
    // fillPeriodFields 已把 30d 聚合行（求和后的）reviewQuantity 写入 target，
    // aggregateMarkets 不得再加一遍各市场的值（历史 bug：恒为 2 倍）
    const target = {
      star: 0, reviewQuantity: 100, returnsRate: 0, refundsRate: 0,
      bestBsrRank: null as number | null, bestBsrTitle: null as string | null,
    } as unknown as PeriodFields;
    aggregateMarkets(new Map([
      ['A:US', row({ reviewQuantity: 60, star: 4.5 })],
      ['B:DE', row({ reviewQuantity: 40, star: 4.8 })],
    ]), target);
    expect(target.reviewQuantity).toBe(100);
    expect(target.star).toBe(4.8); // 取最大
  });
});
