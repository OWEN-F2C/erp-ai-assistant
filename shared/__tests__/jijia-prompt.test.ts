import { describe, it, expect } from 'vitest';
import { buildAiPrompt } from '../../shared/jijia-data';
import type { SkuSummary } from '../../shared/jijia-data';
import { buildTransferPrompt } from '../../shared/jijia-transfer-data';
import type { AsinSummary } from '../../shared/jijia-transfer-data';
import type { DomesticSiteGroup } from '../../shared/domestic-pool';

function makeSummary(): SkuSummary {
  const s = {
    sku: 'HC586TX', productName: '理发套装', singleQuantity: 16,
    productionDays: 30, shippingDays: 25, sellUntilDate: '2026-11-11', bufferDays: 15,
    domesticAvailable: 100, domesticInTransit: 0, domesticReserved: 0, purchaseInTransit: 0,
    domesticWarehouses: [], fbaAvailable: 200, fbaInTransit: 50, fbaReserved: 0,
    otherAvailable: 0, otherInTransit: 0,
    invAgeList: [], totalAvailable: 300, totalInTransit: 50, totalReserved: 0,
    transferWaitShippedTotal: 48,
    avgDaily7d: 5, avgDaily14d: 4, avgDaily30d: 4, avgDaily60d: 3, avgDaily90d: 3,
    sessions7d: 0, sessions14d: 0, sessions30d: 0, sessions60d: 0, sessions90d: 0,
    pageViews7d: 0, pageViews14d: 0, pageViews30d: 0, pageViews60d: 0, pageViews90d: 0,
    cvr7d: 0, cvr14d: 0, cvr30d: 0, cvr60d: 0, cvr90d: 0,
    buyBox7d: 0, buyBox14d: 0, buyBox30d: 0, buyBox60d: 0, buyBox90d: 0,
    adsSpend7d: 0, adsSpend14d: 0, adsSpend30d: 0, adsSpend60d: 0, adsSpend90d: 0,
    acos7d: 0, acos14d: 0, acos30d: 0, acos60d: 0, acos90d: 0,
    roas7d: 0, roas14d: 0, roas30d: 0, roas60d: 0, roas90d: 0,
    adsOrders7d: 0, adsOrders14d: 0, adsOrders30d: 0, adsOrders60d: 0, adsOrders90d: 0,
    naturalOrders7d: 0, naturalOrders14d: 0, naturalOrders30d: 0, naturalOrders60d: 0, naturalOrders90d: 0,
    adsImpressions7d: 0, adsImpressions14d: 0, adsImpressions30d: 0, adsImpressions60d: 0, adsImpressions90d: 0,
    cpc7d: 0, cpc14d: 0, cpc30d: 0, cpc60d: 0, cpc90d: 0,
    ctr7d: 0, ctr14d: 0, ctr30d: 0, ctr60d: 0, ctr90d: 0,
    star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
    bestBsrTitle: null, bestBsrRank: null, listingStates: [],
  };
  return s as SkuSummary;
}

describe('buildAiPrompt', () => {
  it('不再包含错误的计算公式', () => {
    const p = buildAiPrompt(makeSummary());
    expect(p).not.toContain('有效覆盖天数');
    expect(p).not.toContain('提前期 =');
    expect(p).not.toContain('建议采购量 = 预测日均');
  });

  it('明确要求 suggestedQty 填 0 由前端计算', () => {
    const p = buildAiPrompt(makeSummary());
    expect(p).toContain('suggestedQty');
    expect(p).toContain('填 0');
    expect(p).not.toContain('每个scope独立给出suggestedQty值');
    expect(p).not.toContain('建议采购量:N');
  });

  it('suggestion 格式行不含"由前端计算"等实现细节（防 AI 复述进结论）', () => {
    const p = buildAiPrompt(makeSummary());
    // 参数说明区可以有（AI 需要知道），但格式样例行不能带——AI 会照抄样例
    const formatLines = p.split('\n').filter(l => l.includes('判断+预测日均'));
    expect(formatLines.length).toBeGreaterThan(0);
    for (const l of formatLines) {
      expect(l).not.toContain('前端');
      expect(l).not.toContain('公式');
    }
  });

  it('结论数字行（库存/覆盖/提前期/日期/采购量）声明为固定展示，LLM 不得重复输出', () => {
    // 2026-09-03 用户报输出结论格式不稳定——这些行改由前端确定性渲染，
    // 提示词必须明确禁止 LLM 自行输出，否则面板出现双份且口径可能冲突
    const p = buildAiPrompt(makeSummary());
    expect(p).toContain('已固定展示');
    expect(p).toContain('不要重复输出这些数字行');
    // 约束行本身也不能带实现细节词（AI 会复述）
    const line = p.split('\n').find(l => l.includes('已固定展示'))!;
    expect(line).not.toContain('前端');
    expect(line).not.toContain('公式');
  });

  it('要求每 scope 输出 predictedDailySales', () => {
    const p = buildAiPrompt(makeSummary());
    expect(p).toContain('predictedDailySales');
  });

  it('库存块注明在途未来口径 + 待出运参考行（2026-09-08 管线）', () => {
    const p = buildAiPrompt(makeSummary());
    // 在途 = max(货件在途, 已发货+待入库)+待出运（两套账去重）
    expect(p).toContain('在途50(含已发货/待入库/待出运)');
    expect(p).toContain('调拨待出运(已出库未发运,中转): 48');
    expect(p).toContain('已计入在途合计');
  });

  it('勾选不可借站点：国内仓明细标 [不可借]，合计行切换可借口径（2026-09-08 借用排除）', () => {
    const s = makeSummary();
    s.domesticWarehouses = [
      { name: 'CN_A_US', available: 300, inTransit: 0 },
      { name: 'CN-独立站', available: 40, inTransit: 0 },
    ];
    s.domesticAvailable = 340;
    const p = buildAiPrompt(s, undefined, new Set<DomesticSiteGroup>(['US']));
    expect(p).toContain('CN_A_US: 可用300 预占0 在途0 [不可借]');
    expect(p).toContain('CN-独立站: 可用40 预占0 在途0');       // 通用仓无标注
    expect(p.match(/\[不可借\]/g)?.length).toBe(1);
    expect(p).toContain('（可借 40 / 不可借 300）');
    expect(p).toContain('可动用40(=可借−预占)');
  });

  it('不勾选时提示词与现状一致（无 [不可借] 无可借双数）', () => {
    const s = makeSummary();
    s.domesticWarehouses = [{ name: 'CN_A_US', available: 300, inTransit: 0 }];
    s.domesticAvailable = 300;
    const p = buildAiPrompt(s);
    expect(p).not.toContain('[不可借]');
    expect(p).not.toContain('可借 ');
    expect(p).toContain('可动用300(=可用−预占)');
  });
});

function makeTransferSummary(): AsinSummary {
  const base = {
    asin: 'B0TEST1234', sku: 'HC586TX', msku: '', productName: '理发套装',
    marketName: 'US', sellingPrice: 29.99, singleQuantity: 16,
    domesticWarehouses: [], domesticAvailable: 100, domesticInTransit: 0, domesticReserved: 0, purchaseInTransit: 0,
    fbaAvailable: 200, fbaInTransit: 586, fbaReserved: 0, invAgeList: [],
    fbaPipeline: { shipped: 240, receiving: 24, waitShipped: 48, working: 288 },
    transferWaitShippedTotal: 68,
    avgDaily7d: 5, avgDaily14d: 4, avgDaily30d: 4, avgDaily60d: 3, avgDaily90d: 3,
    sessions7d: 0, sessions14d: 0, sessions30d: 0, sessions60d: 0, sessions90d: 0,
    cvr7d: 0, cvr14d: 0, cvr30d: 0, cvr60d: 0, cvr90d: 0,
    buyBox7d: 0, buyBox14d: 0, buyBox30d: 0, buyBox60d: 0, buyBox90d: 0,
    adsSpend7d: 0, adsSpend14d: 0, adsSpend30d: 0, adsSpend60d: 0, adsSpend90d: 0,
    acos7d: 0, acos14d: 0, acos30d: 0, acos60d: 0, acos90d: 0,
    roas7d: 0, roas14d: 0, roas30d: 0, roas60d: 0, roas90d: 0,
    adsOrders7d: 0, adsOrders14d: 0, adsOrders30d: 0, adsOrders60d: 0, adsOrders90d: 0,
    naturalOrders7d: 0, naturalOrders14d: 0, naturalOrders30d: 0, naturalOrders60d: 0, naturalOrders90d: 0,
    bsrByMarket: [], missingPeriods: [], currency: 'USD',
    star: 0, reviewQuantity: 0, returnsRate: 0, refundsRate: 0,
  };
  return base as AsinSummary;
}

describe('buildTransferPrompt', () => {
  it('不再包含双重扣除头程的错误公式', () => {
    const p = buildTransferPrompt(makeTransferSummary());
    expect(p).not.toContain('有效覆盖天数');
    expect(p).not.toContain('建议调拨量 = 预测日均');
  });

  it('调拨量由前端计算：suggestedQty 统一填 0', () => {
    const p = buildTransferPrompt(makeTransferSummary());
    expect(p).toContain('suggestedQty');
    expect(p).toContain('填 0');
    expect(p).toContain('前端');
  });

  it('格式说明不含"由前端计算"等实现细节，防止 AI 复述进结论', () => {
    const p = buildTransferPrompt(makeTransferSummary());
    expect(p).not.toContain('由前端计算');
    expect(p).not.toContain('前端按公式');
  });

  it('国内仓块包含计采交合计（计划量+采购量+交货量）', () => {
    const s = makeTransferSummary();
    s.purchaseInTransit = 300;
    s.domesticWarehouses = [{ name: '杭州仓', available: 10, inTransit: 5, purchaseQty: 300 }];
    const p = buildTransferPrompt(s);
    expect(p).toContain('计采交合计(计划量+采购量+交货量,未来的货): 300');
    expect(p).toContain('计采300');
  });

  it('未匹配汇总组时明示市场口径为"销量最高市场"（非页面目标市场）', () => {
    const s = makeTransferSummary();
    s.marketScope = 'top-market';
    s.marketName = 'US';
    const p = buildTransferPrompt(s);
    expect(p).toContain('销量最高');
    expect(p).toContain('非页面目标市场');
  });

  it('匹配汇总组时不显示口径提示', () => {
    const s = makeTransferSummary();
    s.marketScope = 'group';
    s.marketName = '欧洲站（DE+FR+IT）';
    const p = buildTransferPrompt(s);
    expect(p).not.toContain('销量最高');
  });

  it('FBA 区块注明管线口径 + 发运管线参考行（2026-09-08 结论二）', () => {
    const p = buildTransferPrompt(makeTransferSummary());
    // 在途 = max(货件在途, 已发货+待入库)+待出运 + 本仓待出库（调拨调入仓视角）
    expect(p).toContain('在途(含已发货+待入库+待出运+待出库)');
    expect(p).toContain('发运管线: 已发货240 待入库24 待出库288(已计入) 待出运68(全仓参考)');
  });

  it('勾选不可借站点：国内仓明细标 [不可借]，合计行切换可借口径（2026-09-08 借用排除）', () => {
    const s = makeTransferSummary();
    s.domesticWarehouses = [
      { name: 'CN_B_DE', available: 120, inTransit: 5 },
      { name: 'CN_B_UK', available: 80, inTransit: 0 },
    ];
    s.domesticAvailable = 200;
    s.domesticReserved = 0;
    const p = buildTransferPrompt(s, new Set<DomesticSiteGroup>(['EU']));
    expect(p.match(/\[不可借\]/g)?.length).toBe(1);              // 只标 DE，UK 不标
    expect(p).toContain('CN_B_DE: 可用120 预占0 在途5 [不可借]');
    expect(p).toContain('CN_B_UK: 可用80 预占0 在途0');
    expect(p).toContain('（可借 80 / 不可借 120）');
    expect(p).toContain('可动用80(=可借−预占)');
  });
});
