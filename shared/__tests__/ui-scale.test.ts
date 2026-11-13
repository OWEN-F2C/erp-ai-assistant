import { describe, it, expect } from 'vitest';
// 面板整体缩放（zoom）：所有面板样式是内联 px，仅调 font-size 会被内联值覆盖，
// 用 zoom 等比缩放字体+间距（2026-08-28 用户确认方案）。纯函数锁定步进/边界/兜底。
import { UI_SCALE_MIN, UI_SCALE_MAX, stepUiScale, normalizeUiScale } from '../ui-scale';

describe('stepUiScale（A± 步进 10%，边界夹紧）', () => {
  it('步进与常量', () => {
    expect(UI_SCALE_MIN).toBe(0.7);
    expect(UI_SCALE_MAX).toBe(1.5);
    expect(stepUiScale(1, 1)).toBe(1.1);
    expect(stepUiScale(1, -1)).toBe(0.9);
  });

  it('边界不越界（夹紧，按钮层据此禁用）', () => {
    expect(stepUiScale(1.5, 1)).toBe(1.5);
    expect(stepUiScale(0.7, -1)).toBe(0.7);
  });

  it('浮点卫生：0.8+0.1=0.9 而非 0.9000000000000001', () => {
    expect(stepUiScale(0.8, 1)).toBe(0.9);
    expect(stepUiScale(1.2, 1)).toBe(1.3);
    expect(stepUiScale(1.4, -1)).toBe(1.3);
  });

  it('非法入参按 1 起步，不抛错', () => {
    expect(stepUiScale(NaN, 1)).toBe(1.1);
    expect(stepUiScale(0, -1)).toBe(0.9);
  });
});

describe('normalizeUiScale（存储值兜底：非法/越界 → 1 或夹紧）', () => {
  it('NaN/undefined/负数/0 → 默认 1', () => {
    expect(normalizeUiScale(NaN)).toBe(1);
    expect(normalizeUiScale(undefined as unknown as number)).toBe(1);
    expect(normalizeUiScale(-5)).toBe(1);
    expect(normalizeUiScale(0)).toBe(1);
  });

  it('超出范围夹紧到边界，范围内的值原样保留', () => {
    expect(normalizeUiScale(99)).toBe(1.5);
    expect(normalizeUiScale(0.1)).toBe(0.7);
    expect(normalizeUiScale(1.15)).toBe(1.15);
  });
});
