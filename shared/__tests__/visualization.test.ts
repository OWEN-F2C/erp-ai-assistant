import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeCurve, tooltipPosition } from '../../modules/purchase-plan-generator/visualization';
import type { CurveInput } from '../../modules/purchase-plan-generator/visualization';

const BASE_INPUT: CurveInput = {
  sku: 'TEST',
  label: 'TEST · 全渠道',
  currentStock: 300,
  inTransit: 0,
  weeklyForecast: Array(13).fill(50), // 13 weeks, sells out at week 6
  suggestedQty: 64,
  restockDate: '',
  arrivalDate: '',
};

function dateAfterDays(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

describe('computeCurve', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00+08:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('extends the forecast window so the arrival bump is visible', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      restockDate: '2026-10-19', // week 9
      arrivalDate: '2026-12-13', // week 17 — beyond the 13-week forecast
    };
    const d = computeCurve(input);
    expect(d.weeks.length).toBeGreaterThan(13);
    expect(d.arrivalWeek).toBe(17);
    expect(d.restockWeek).toBe(9);
    // qty arrives at week 17: baseline 0 + 64 (no sales in the extension)
    expect(d.withPurchase[17]).toBe(64);
    expect(d.withPurchase[16]).toBe(0);
  });

  it('forks at arrival week when it is inside the original window', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      restockDate: dateAfterDays(10), // week 1
      arrivalDate: dateAfterDays(45), // week 6 — inside 13 weeks
    };
    const d = computeCurve(input);
    expect(d.weeks.length).toBe(13); // no extension needed
    expect(d.restockWeek).toBe(1);
    expect(d.arrivalWeek).toBe(6);
    // stock hits 0 before arrival; arrival adds 64, that week's 50 sales are subtracted
    expect(d.withPurchase[6]).toBe(64 - 50);
    expect(d.withPurchase[7]).toBe(0); // 14 - 50 → clamped
  });

  it('marks stockout and keeps markers independent', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      restockDate: dateAfterDays(3),
      arrivalDate: dateAfterDays(58),
    };
    const d = computeCurve(input);
    // 300 stock, 50/week → hits 0 after 6 subtractions (index 5)
    expect(d.stockoutWeek).toBe(5);
    expect(d.arrivalWeek).toBeGreaterThanOrEqual(0);
    expect(d.restockWeek).toBeGreaterThanOrEqual(0);
  });

  it('no fake fork when arrival is beyond the horizon cap', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      restockDate: dateAfterDays(30),
      arrivalDate: dateAfterDays(200), // beyond 26 weeks
    };
    const d = computeCurve(input);
    expect(d.arrivalWeek).toBe(-1);
    expect(d.weeks.length).toBe(13); // no extension
    // withPurchase identical to noPurchase (no fork)
    expect(d.withPurchase).toEqual(d.noPurchase);
  });

  it('falls back to restockDate as arrival when arrivalDate is missing', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      restockDate: dateAfterDays(14),
      arrivalDate: '',
    };
    const d = computeCurve(input);
    expect(d.arrivalWeek).toBe(2);
    expect(d.restockWeek).toBe(2);
  });

  it('extension weeks decline at tailFillPerWeek instead of staying flat', () => {
    const input: CurveInput = {
      ...BASE_INPUT,
      currentStock: 2000,
      inTransit: 0,
      weeklyForecast: Array(13).fill(50),
      suggestedQty: 64,
      restockDate: '2026-10-19', // week 9
      arrivalDate: '2026-12-13', // week 17 — beyond the 13-week window
      tailFillPerWeek: 140,
    };
    const d = computeCurve(input);
    // week 12 (last AI week): 2000 − 13×50 = 1350
    expect(d.noPurchase[12]).toBe(1350);
    // extension weeks decline 140/week
    expect(d.noPurchase[13]).toBe(1210);
    expect(d.noPurchase[16]).toBe(790);
    // arrival week: 790 − 140 + 64 = 714
    expect(d.withPurchase[17]).toBe(714);
  });
});

describe('tooltipPosition', () => {
  it('默认锚定在鼠标右侧 14px', () => {
    expect(tooltipPosition(100, 50, 120, 800)).toEqual({ left: 114, top: 40 });
  });

  it('靠近右边缘时翻转到鼠标左侧', () => {
    // 700+14+120 = 834 > 800 → left = 700−14−120 = 566
    expect(tooltipPosition(700, 50, 120, 800)).toEqual({ left: 566, top: 40 });
  });

  it('极端右边缘时翻转后不越出左界', () => {
    // 790−14−120 = 656 ≥ 0
    expect(tooltipPosition(790, 50, 120, 800)).toEqual({ left: 656, top: 40 });
  });
});
