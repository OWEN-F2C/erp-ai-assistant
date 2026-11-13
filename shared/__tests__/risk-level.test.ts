import { describe, it, expect } from 'vitest';
import { riskLevelFromRemainingDays } from '../qty-formula';

// 2026-08-07 设计口径：red = 剩余库存天数 ≤ 提前期（已到下单死线，必须立刻下单，
// 再晚就会断货），yellow = ≤ 提前期 + 冗余（接近死线），green = 更远。
// 历史上实现曾硬编码 red ≤ 30 天，导致提前期 > 30 天的行在死线已过时仍显示黄色。
describe('riskLevelFromRemainingDays', () => {
  const LEAD = 55;   // 生产 30 + 头程 25
  const BUFFER = 15;

  it('剩余天数 ≤ 提前期 → red（下单死线已到）', () => {
    expect(riskLevelFromRemainingDays(0, LEAD, BUFFER)).toBe('red');
    expect(riskLevelFromRemainingDays(30, LEAD, BUFFER)).toBe('red');
    expect(riskLevelFromRemainingDays(LEAD, LEAD, BUFFER)).toBe('red');
  });

  it('提前期 < 剩余天数 ≤ 提前期+冗余 → yellow', () => {
    expect(riskLevelFromRemainingDays(LEAD + 1, LEAD, BUFFER)).toBe('yellow');
    expect(riskLevelFromRemainingDays(LEAD + BUFFER, LEAD, BUFFER)).toBe('yellow');
  });

  it('剩余天数 > 提前期+冗余 → green', () => {
    expect(riskLevelFromRemainingDays(LEAD + BUFFER + 1, LEAD, BUFFER)).toBe('green');
    expect(riskLevelFromRemainingDays(365, LEAD, BUFFER)).toBe('green');
  });

  it('调拨场景：提前期 = 头程 25，yellow 区间非空', () => {
    // 修复前 transfer 的 red≤30 / yellow≤25 排序使 yellow 永不可达
    expect(riskLevelFromRemainingDays(25, 25, 15)).toBe('red');
    expect(riskLevelFromRemainingDays(26, 25, 15)).toBe('yellow');
    expect(riskLevelFromRemainingDays(41, 25, 15)).toBe('green');
  });
});
