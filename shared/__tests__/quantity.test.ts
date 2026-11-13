import { describe, it, expect } from 'vitest';
import { computePurchaseQty, padWeeklyForecast } from '../../modules/purchase-plan-generator/quantity';

describe('computePurchaseQty', () => {
  it('情形A：库存够撑过提前期，提前期抵消', () => {
    // d=10, S=400, I=0, L=30, C=60 → 10×60−400 = 200
    expect(computePurchaseQty(10, 400, 0, 30, 60, 16)).toBe(208); // ceil(200/16)=13 → 208
  });

  it('情形B：库存撑不到到货，只买到货后的量', () => {
    // d=10, S=100, I=0, L=30, C=60 → 10×(60−30) = 300
    expect(computePurchaseQty(10, 100, 0, 30, 60, 16)).toBe(304); // ceil(300/16)=19 → 304
  });

  it('情形C：提前期超过覆盖期 → 0', () => {
    expect(computePurchaseQty(10, 100, 0, 40, 30, 16)).toBe(0);
  });

  it('库存充足无需补货 → 0', () => {
    // d=10, S=800, I=100, L=30, C=60 → 10×60−900 = −300 → 0
    expect(computePurchaseQty(10, 800, 100, 30, 60, 16)).toBe(0);
  });

  it('box ≤ 0 回退 1；box=1 时等于原始值向上取整', () => {
    expect(computePurchaseQty(10, 400, 0, 30, 60, 0)).toBe(200);
    expect(computePurchaseQty(10, 400, 0, 30, 60, 1)).toBe(200);
  });

  it('d=0（无销量数据）→ 0', () => {
    expect(computePurchaseQty(0, 0, 0, 30, 60, 16)).toBe(0);
  });
});

describe('padWeeklyForecast', () => {
  it('补齐缺失的周', () => {
    expect(padWeeklyForecast([100, 80], 5, 70)).toEqual([100, 80, 70, 70, 70]);
  });

  it('截断多余的周', () => {
    expect(padWeeklyForecast([100, 80, 70, 60, 50, 40], 4, 70)).toEqual([100, 80, 70, 60]);
  });

  it('空数组或 undefined → 全填充', () => {
    expect(padWeeklyForecast([], 3, 70)).toEqual([70, 70, 70]);
    expect(padWeeklyForecast(undefined, 3, 70)).toEqual([70, 70, 70]);
  });

  it('expectedWeeks < 1 按 1 处理', () => {
    expect(padWeeklyForecast([100], 0, 70)).toEqual([100]);
  });
});
