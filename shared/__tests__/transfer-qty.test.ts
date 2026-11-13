import { describe, it, expect } from 'vitest';
import { computeTransferQty } from '../qty-formula';

// 2026-08-13 设计附录 A 的调拨形状（与采购同构）：
//   R = max(0, FBA可用 + FBA在途 − 预测日均 × 头程天数)
//   D = 预测日均 × max(0, 覆盖天数 − 头程天数)
//   调拨量 = ceil((D − R) / 箱规) × 箱规（≥ 0）
describe('computeTransferQty', () => {
  it('库存够撑过头程时按完整需求补足（旧公式会少买 日均×头程）', () => {
    // d=2, FBA可用=100, 在途=0, 头程=25, 覆盖=100, 箱规=1
    // R = max(0, 100 − 50) = 50; D = 2×75 = 150 → qty = 100
    // 旧公式（有效覆盖=75）：2×75 − 100 = 50，恰好少买 d×L = 50
    expect(computeTransferQty(2, 100, 0, 25, 100, 1)).toBe(100);
  });

  it('覆盖天数 ≤ 头程天数 → 0（当前库存已覆盖至卖到日期）', () => {
    expect(computeTransferQty(2, 10, 0, 25, 20, 1)).toBe(0);
  });

  it('库存富余导致结果为负 → 归零', () => {
    // R = max(0, 500+100−10) = 590; D = 1×50 = 50 → 0
    expect(computeTransferQty(1, 500, 100, 10, 60, 1)).toBe(0);
  });

  it('按箱规向上取整', () => {
    // R = 0; D = 2×75 = 150; ceil(150/16)=10 → 160
    expect(computeTransferQty(2, 0, 0, 25, 100, 16)).toBe(160);
  });

  it('预测日均为 0 → 0（零销量不调拨）', () => {
    expect(computeTransferQty(0, 10, 0, 25, 100, 16)).toBe(0);
  });

  it('在途库存计入库存基数', () => {
    // 与用例一同参数，但 100 可用改为 50 可用 + 50 在途，结果不变
    expect(computeTransferQty(2, 50, 50, 25, 100, 1)).toBe(100);
  });

  it('箱规非正数按 1 处理', () => {
    expect(computeTransferQty(2, 0, 0, 25, 100, 0)).toBe(150);
  });
});
