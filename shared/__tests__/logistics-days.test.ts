import { describe, it, expect } from 'vitest';
import { parseLogisticsDays } from '../logistics-days';

// 调拨单"物流方式"选项文本自带时效（如 欧洲卡航递延（30-40天）），
// 选择后解析出天数同步到 AI 面板的头程输入。
describe('parseLogisticsDays', () => {
  it('区间时效取中值（四舍五入）', () => {
    expect(parseLogisticsDays('欧洲卡航递延（30-40天）')).toBe(35);
    expect(parseLogisticsDays('海运普船（25-35天）')).toBe(30);
    expect(parseLogisticsDays('海运（30~45天）')).toBe(38); // 37.5 → 38
  });

  it('单一时效直接取值', () => {
    expect(parseLogisticsDays('空运（15天）')).toBe(15);
    expect(parseLogisticsDays('国际快递(7天)')).toBe(7); // 半角括号
  });

  it('无时效信息返回 null（不动头程输入）', () => {
    expect(parseLogisticsDays('自提')).toBeNull();
    expect(parseLogisticsDays('欧洲卡航递延')).toBeNull();
    expect(parseLogisticsDays('')).toBeNull();
  });

  it('文本身带杂项也能解析首个时效', () => {
    expect(parseLogisticsDays('中欧班列（铁路）35-40天 双清包税')).toBe(38);
  });
});
