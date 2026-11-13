import { describe, it, expect } from 'vitest';
// 2026-09-03 用户报：①输出结论格式不稳定 ②红灯绿灯与结论矛盾（绿"库存充足"
// 与"尽快"同卡出现——旧实现三套口径：灯用 FBA 基数+suggestedQty≤0 强制 green、
// 日期用 FBA 基数、结论块用总可用基数）。
// 修复：结论块统一产出 灯/日期/数量/结论行（同基数 totalAvailable），面板不再
// 另算。灯走文档口径 riskLevelFromRemainingDays（红≤提前期 / 黄≤提前期+冗余）。
import { buildPurchaseConclusion } from '../purchase-conclusion';

const NOW = new Date('2026-09-03T00:00:00').getTime();

function baseInput(over: Record<string, unknown> = {}) {
  return {
    predictedDailySales: 5,
    fallbackDaily: 4,
    totalAvailable: 513,
    totalInTransit: 100,
    transferWaitShippedTotal: 48,
    productionDays: 30,
    shippingDays: 25,
    bufferDays: 15,
    sellUntilDate: '2026-12-01',
    boxQty: 16,
    now: NOW,
    ...over,
  };
}

describe('buildPurchaseConclusion（确定性结论块）', () => {
  it('字段齐全且顺序固定（截图五行 + 在途/预测日均补充）', () => {
    const r = buildPurchaseConclusion(baseInput());
    expect(r.lines.map(l => l.label)).toEqual([
      '总可用库存(国内+海外+FBA)',
      '在途(全部,含已发货/待入库/待出运)',
      '待出运(中转,已计入在途)',
      '预测日均',
      '可覆盖天数',
      '补货提前期(生产+头程)',
      '建议采购日期',
      '建议采购量',
    ]);
    // 可覆盖 513/5=102.6 → 绿（>55+15）；下单死线 = round(102.6−70)=33 天后
    expect(r.lines.map(l => l.value)).toEqual([
      '513 件', '100 件', '48 件', '5 件/天', '102 天', '55 天', '2026-10-06', '0 件',
    ]);
  });

  it('transferWaitShippedTotal 缺省为 0（旧调用方不传不报错）', () => {
    const r = buildPurchaseConclusion(baseInput({ transferWaitShippedTotal: undefined as unknown as number }));
    expect(r.lines[2]!.value).toBe('0 件');
  });

  it('建议采购量走确定性公式并按箱规向上凑整（与生成器同口径）', () => {
    const r0 = buildPurchaseConclusion(baseInput());
    expect(r0.qty).toBe(0);
    const r1 = buildPurchaseConclusion(baseInput({ totalAvailable: 0, totalInTransit: 0 }));
    expect(r1.qty).toBe(256);   // D=5×(104−55)=245 → 箱规16凑整 256
    expect(r1.lines[7]!.value).toBe('256 件');
  });

  it('预测日均缺失回退 fallbackDaily；日均为 0 时覆盖天数/日期显示 — 不产生 Infinity/NaN', () => {
    const r = buildPurchaseConclusion(baseInput({ predictedDailySales: null as unknown as number }));
    expect(r.lines[4]!.value).toBe('128 天');   // 513/4
    expect(r.lines[3]!.value).toBe('4 件/天');
    const r0 = buildPurchaseConclusion(baseInput({ predictedDailySales: 0, fallbackDaily: 0 }));
    expect(r0.lines[4]!.value).toBe('—');
    expect(r0.lines[6]!.value).toBe('—');
    expect(r0.qty).toBe(0);
    expect(r0.riskLevel).toBe('green');   // 无销量无断货风险
  });

  it('卖到日期未设置时不抛错（coverage 兜底 0）', () => {
    const r = buildPurchaseConclusion(baseInput({ sellUntilDate: '' }));
    expect(r.qty).toBe(0);
    expect(r.lines.every(l => !l.value.includes('NaN') && !l.value.includes('Invalid'))).toBe(true);
  });
});

describe('结论块国内不可借基数（2026-09-08 借用排除）', () => {
  it('不传 domesticNonLendable：首行文案与数值维持现状（逐字节）', () => {
    const r = buildPurchaseConclusion(baseInput({}));
    expect(r.lines[0]!.label).toBe('总可用库存(国内+海外+FBA)');
    expect(r.lines[0]!.value).toBe('513 件');
  });

  it('扣减 300：基数切换为可借口径，量/灯/覆盖/日期全部同基联动', () => {
    // 可借 = 513−300 = 213；213/5 = 42.6 天 ≤ 提前期 55 → red + 尽快
    // qty: D=5×(104−55)=245, R=max(0,213+100−275)=38 → ceil(207/16)×16 = 208
    const r = buildPurchaseConclusion(baseInput({ domesticNonLendable: 300 }));
    expect(r.lines[0]!.label).toBe('总可用库存(国内可借+海外+FBA)');
    expect(r.lines[0]!.value).toBe('213 件（国内不可借已扣 300）');
    expect(r.lines[4]!.value).toBe('42 天');           // floor(213/5)
    expect(r.lines[6]!.value).toBe('尽快');
    expect(r.lines[7]!.value).toBe('208 件');
    expect(r.riskLevel).toBe('red');
    expect(r.qty).toBe(208);
  });

  it('扣减超过总可用时基数下限 0，不产生负数', () => {
    const r = buildPurchaseConclusion(baseInput({ domesticNonLendable: 999 }));
    expect(r.lines[0]!.value).toBe('0 件（国内不可借已扣 999）');
    expect(r.qty).toBe(256);   // 与 totalAvailable=0 用例同值（D=245 全额补）
  });
});

describe('结论块风险一致性（灯/日期/数量同基数同源）', () => {
  it('绿灯必有未来日期（库存充足 ↔ 不显示"尽快"）', () => {
    const r = buildPurchaseConclusion(baseInput());
    expect(r.riskLevel).toBe('green');            // 102.6 > 55+15
    expect(r.restockDate).toBe('2026-10-06');     // 面板头部"预计补货日"同源
    expect(r.lines[6]!.value).not.toBe('尽快');
  });

  it('红灯显示"尽快"（剩余 ≤ 提前期 = 下单死线已过）', () => {
    const r = buildPurchaseConclusion(baseInput({ totalAvailable: 100 }));   // 100/5=20 ≤ 55
    expect(r.riskLevel).toBe('red');
    expect(r.restockDate).toBe('');
    expect(r.lines[6]!.value).toBe('尽快');
    expect(r.lines[7]!.value).toBe('256 件');     // R=max(0,100+100−275)=0, D=245 → 256
  });

  it('黄灯区间（提前期 < 剩余 ≤ 提前期+冗余）也显示"尽快"但灯为黄', () => {
    const r = buildPurchaseConclusion(baseInput({ totalAvailable: 300 }));   // 300/5=60 ∈ (55,70]
    expect(r.riskLevel).toBe('yellow');
    expect(r.lines[6]!.value).toBe('尽快');
  });

  it('基数=总可用（与可覆盖天数同源）：FBA 见底但国内充足 → 不误报红/尽快', () => {
    // 旧实现的灯/日期用 FBA 基数：FBA=13 时 13/5=2.6 天 → red+尽快，
    // 但总可用 513 → 可覆盖 102 天，绿灯 + 未来日期，卡片自洽
    const r = buildPurchaseConclusion(baseInput({ totalAvailable: 513 }));
    expect(r.riskLevel).toBe('green');
    expect(r.lines[4]!.value).toBe('102 天');
    expect(r.lines[6]!.value).toBe('2026-10-06');
  });
});
