import { describe, it, expect } from 'vitest';
import { aggregateBySku } from '../finance-profit-data';
import type { MonthProfitData, ProfitApiRow } from '../finance-profit-data';

function monthOffset(n: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mkRow(sku: string, netProfit: number): ProfitApiRow {
  return {
    sku, productName: '产品' + sku, brand: 'B', category: 'C',
    sellingManagerName: 'M', platformCode: 'AMAZON', platformName: 'Amazon',
    marketName: 'US', netProfit, salesMoney: netProfit * 10,
  };
}

function monthData(month: string, rows: ProfitApiRow[]): MonthProfitData {
  return { month, rows, fromCache: false };
}

describe('aggregateBySku（月均/趋势口径）', () => {
  it('月均分子分母同口径：排除当月部分数据，0 利润月（有行）计入分母', () => {
    // 6 个完整月：100, 200, 0, 300, 0, 100（合计 700，含两个真实 0 月）+ 当月 500
    const data: MonthProfitData[] = [
      monthData(monthOffset(-6), [mkRow('S1', 100)]),
      monthData(monthOffset(-5), [mkRow('S1', 200)]),
      monthData(monthOffset(-4), [mkRow('S1', 0)]),
      monthData(monthOffset(-3), [mkRow('S1', 300)]),
      monthData(monthOffset(-2), [mkRow('S1', 0)]),
      monthData(monthOffset(-1), [mkRow('S1', 100)]),
      monthData(monthOffset(0), [mkRow('S1', 500)]),
    ];
    const s = aggregateBySku(data)[0]!;
    expect(s.cumulativeProfit).toBe(1200); // 累计含当月
    expect(s.avgMonthlyProfit).toBeCloseTo(700 / 6, 5); // 当月剔除，0 月计入
  });

  it('未上架的月份（无行）不计入月均分母', () => {
    // 数据含 5 个月，SKU 只在 M-4、M-3、M-2 有行（各 300），当月 = M0
    const data: MonthProfitData[] = [
      monthData(monthOffset(-4), [mkRow('S1', 300)]),
      monthData(monthOffset(-3), [mkRow('S1', 300)]),
      monthData(monthOffset(-2), [mkRow('S1', 300)]),
      monthData(monthOffset(-1), []),
      monthData(monthOffset(0), []),
    ];
    const s = aggregateBySku(data)[0]!;
    expect(s.avgMonthlyProfit).toBeCloseTo(300, 5); // 900/3，而不是 900/4
  });

  it('趋势只统计有数据的月份：缺月不按 0 参与计算', () => {
    // M-7..M-1 有 7 个完整月，SKU 在 M-4 无行；当月 M0=999
    // 有数据月 = M-7(50), M-6(100), M-5(100), M-3(300), M-2(300), M-1(300)
    // 剔除首个盈利月 M-7 后只剩 5 个 < 6 → trend = null
    const data: MonthProfitData[] = [
      monthData(monthOffset(-7), [mkRow('S1', 50)]),
      monthData(monthOffset(-6), [mkRow('S1', 100)]),
      monthData(monthOffset(-5), [mkRow('S1', 100)]),
      monthData(monthOffset(-4), []),
      monthData(monthOffset(-3), [mkRow('S1', 300)]),
      monthData(monthOffset(-2), [mkRow('S1', 300)]),
      monthData(monthOffset(-1), [mkRow('S1', 300)]),
      monthData(monthOffset(0), [mkRow('S1', 999)]),
    ];
    const s = aggregateBySku(data)[0]!;
    expect(s.trend).toBeNull();
  });

  it('连续 6 个有数据的完整月给出趋势', () => {
    const data: MonthProfitData[] = [
      monthData(monthOffset(-7), [mkRow('S1', 50)]),
      monthData(monthOffset(-6), [mkRow('S1', 100)]),
      monthData(monthOffset(-5), [mkRow('S1', 100)]),
      monthData(monthOffset(-4), [mkRow('S1', 100)]),
      monthData(monthOffset(-3), [mkRow('S1', 300)]),
      monthData(monthOffset(-2), [mkRow('S1', 300)]),
      monthData(monthOffset(-1), [mkRow('S1', 300)]),
      monthData(monthOffset(0), [mkRow('S1', 999)]),
    ];
    const s = aggregateBySku(data)[0]!;
    // 剔除首个月（部分月）后 [100,100,100,300,300,300]：last3=300, prior3=100 → +200%
    expect(s.trend).toBeCloseTo(200, 5);
  });
});
