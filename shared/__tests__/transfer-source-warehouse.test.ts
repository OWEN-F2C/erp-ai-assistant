// shared/__tests__/transfer-source-warehouse.test.ts
// 调出仓缺货提示（feature/suggestion-update）：用户在表单选了调出仓库时，
// 提示词必须标注该仓在此 SKU 的库存状态；缺货时强制"先提示缺货、再荐替代仓"顺序。
import { describe, it, expect } from 'vitest';
import { sourceWarehouseStatus, sourceWarehouseBadgeHtml, shortageConclusionLine, buildTransferPrompt } from '../jijia-transfer-data';
import type { DomesticSiteGroup } from '../domestic-pool';
import type { AsinSummary } from '../jijia-transfer-data';

const WH = [{ name: 'CN_B_UK', available: 100, inTransit: 5, reserved: 30 }];

describe('sourceWarehouseStatus（调出仓状态行）', () => {
  it('未选择调出仓 → null（不加行，行为同旧版）', () => {
    expect(sourceWarehouseStatus('', WH)).toBeNull();
  });

  it('仓有货且可动用 > 0 → 正常状态行', () => {
    const line = sourceWarehouseStatus('CN_B_UK', WH);
    expect(line).toContain('调出仓(用户所选)');
    expect(line).toContain('CN_B_UK');
    expect(line).toContain('可用100');
    expect(line).toContain('预占30');
    expect(line).toContain('可动用70');
    expect(line).not.toContain('缺货');
  });

  it('可用 0 → 标注缺货', () => {
    const line = sourceWarehouseStatus('CN_B_UK', [{ name: 'CN_B_UK', available: 0, inTransit: 0 }]);
    expect(line).toContain('可用0');
    expect(line).toContain('缺货');
  });

  it('有可用但全部被预占 → 可动用 0 标注', () => {
    const line = sourceWarehouseStatus('CN_B_UK', [{ name: 'CN_B_UK', available: 50, reserved: 50 }]);
    expect(line).toContain('可动用0');
    expect(line).toContain('缺货');
  });

  it('库存行查无此仓 → 无库存记录标注（按缺货处理）', () => {
    const line = sourceWarehouseStatus('CN_A_US', WH);
    expect(line).toContain('CN_A_US');
    expect(line).toContain('无库存记录');
  });

  it('仓名匹配容忍空格与大小写', () => {
    const line = sourceWarehouseStatus(' cn_b_uk ', WH);
    expect(line).toContain('可用100');
  });
});

function makeSummary(wh: Array<{ name: string; available: number; inTransit?: number; reserved?: number }>): AsinSummary {
  return {
    asin: 'B0TEST1234', sku: 'HC586TX', msku: '', productName: 't', marketName: 'US',
    sellingPrice: 29.99, currency: 'USD', singleQuantity: 16,
    domesticWarehouses: wh, domesticAvailable: 100, domesticInTransit: 5, domesticReserved: 30,
    purchaseInTransit: 0, fbaAvailable: 200, fbaInTransit: 50, fbaReserved: 0,
    fbaPipeline: { shipped: 0, receiving: 0, waitShipped: 0, working: 0 },
    transferWaitShippedTotal: 0, invAgeList: [], bsrByMarket: [], missingPeriods: [],
    shippingDays: 25, sellUntilDate: '2026-12-14', bufferDays: 15,
    avgDaily7d: 5, avgDaily14d: 4, avgDaily30d: 4, avgDaily60d: 3, avgDaily90d: 3,
    sessions7d: 0, sessions14d: 0, sessions30d: 0, sessions60d: 0, sessions90d: 0,
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
  } as unknown as AsinSummary;
}

describe('sourceWarehouseStatus（非裸名静默——防格式漂移误报）', () => {
  it('带店铺前缀（Yaoshu:CN_B_UK）匹配失败 → null（不显示不报警）', () => {
    expect(sourceWarehouseStatus('Yaoshu:CN_B_UK', WH)).toBeNull();
  });

  it('带装饰后缀（CN_B_UK（国内仓））→ null', () => {
    expect(sourceWarehouseStatus('CN_B_UK（国内仓）', WH)).toBeNull();
  });

  it('裸国内仓名查无行（CN/GZ 前缀、纯字母数字_-）→ 仍判缺货（filterQuantity 语义）', () => {
    expect(sourceWarehouseStatus('CN_C_CA', WH)).toContain('缺货');
    expect(sourceWarehouseStatus('GZ_ZFH', WH)).toContain('缺货');
  });

  it('未匹配静默时提示词不提调出仓、不触发缺货指令', () => {
    const p = buildTransferPrompt(makeSummary(WH), undefined, 'Yaoshu:CN_B_UK');
    expect(p).not.toContain('调出仓(用户所选)');
    expect(p).not.toContain('先提示缺货');
  });
});

describe('sourceWarehouseBadgeHtml（卡片前端状态行）', () => {
  it('无状态 → 空串（不渲染行）', () => {
    expect(sourceWarehouseBadgeHtml(null)).toBe('');
  });

  it('缺货状态 → ⚠ 警告样式行，含仓名与缺货字样', () => {
    const html = sourceWarehouseBadgeHtml('调出仓(用户所选): CN_A_US 可用0 —— 缺货');
    expect(html).toContain('⚠');
    expect(html).toContain('CN_A_US');
    expect(html).toContain('缺货');
    expect(html).toContain('#dc2626');
  });

  it('不渲染背景框（用户要求：纯文字行，无红底无边框，不全宽拉伸）', () => {
    for (const st of [
      '调出仓(用户所选): CN_A_US 可用0 —— 缺货',
      '调出仓(用户所选): CN_B_UK 可用100 预占30 可动用70',
    ]) {
      const html = sourceWarehouseBadgeHtml(st);
      expect(html).not.toContain('background');
      expect(html).not.toContain('border');
    }
  });

  it('正常状态 → 安静灰字行，无 ⚠', () => {
    const html = sourceWarehouseBadgeHtml('调出仓(用户所选): CN_B_UK 可用100 预占30 可动用70');
    expect(html).toContain('CN_B_UK');
    expect(html).toContain('可动用70');
    expect(html).not.toContain('⚠');
    expect(html).toContain('#64748b');
  });

  it('仓名等文本被 HTML 转义', () => {
    const html = sourceWarehouseBadgeHtml('调出仓(用户所选): <X> 可用0 —— 缺货');
    expect(html).not.toContain('<X>');
    expect(html).toContain('&lt;X&gt;');
  });
});

describe('shortageConclusionLine（确定性结论句，评审 #2）', () => {
  it('缺货+有替代仓 → 结论句含所选仓名/替代仓/件数', () => {
    const line = shortageConclusionLine('CN_A_US', WH, new Set<DomesticSiteGroup>(), 96);
    expect(line).toContain('结论：建议调拨');
    expect(line).toContain('所选调出仓CN_A_US缺货');
    expect(line).toContain('从CN_B_UK调出约96件');
  });

  it('替代仓跳过不可借组（勾 UK 时 CN_B_UK 不入选）', () => {
    const wh = [
      { name: 'CN_B_UK', available: 100, reserved: 30 },
      { name: 'CN_A_US', available: 50, reserved: 0 },
    ];
    const line = shortageConclusionLine('CN_C_CA', wh, new Set<DomesticSiteGroup>(['UK']), 60);
    expect(line).toContain('从CN_A_US调出约60件');
  });

  it('qty=0 / 有货 / 未选仓 → null（不加结论）', () => {
    expect(shortageConclusionLine('CN_A_US', WH, new Set<DomesticSiteGroup>(), 0)).toBeNull();
    expect(shortageConclusionLine('CN_B_UK', WH, new Set<DomesticSiteGroup>(), 96)).toBeNull();
    expect(shortageConclusionLine('', WH, new Set<DomesticSiteGroup>(), 96)).toBeNull();
  });

  it('国内无可动用仓 → 缺货照说，替代仓提示为空', () => {
    const line = shortageConclusionLine('CN_C_CA', [{ name: 'CN_B_UK', available: 0 }], new Set<DomesticSiteGroup>(), 50);
    expect(line).toContain('所选调出仓CN_C_CA缺货');
    expect(line).toContain('国内暂无有货仓可调');
  });
});

describe('buildTransferPrompt（调出仓标注与顺序指令）', () => {
  it('未传调出仓 → 提示词不含调出仓状态（向后兼容）', () => {
    const p = buildTransferPrompt(makeSummary(WH));
    expect(p).not.toContain('调出仓(用户所选)');
  });

  it('调出仓有货 → 含状态行，无强制顺序指令', () => {
    const p = buildTransferPrompt(makeSummary(WH), undefined, 'CN_B_UK');
    expect(p).toContain('调出仓(用户所选)');
    expect(p).toContain('可动用70');
    expect(p).not.toContain('先提示缺货');
  });

  it('调出仓缺货 → 含缺货标注 + 强制"先缺货后替代仓"顺序指令', () => {
    const p = buildTransferPrompt(makeSummary([{ name: 'CN_B_UK', available: 0 }]), undefined, 'CN_B_UK');
    expect(p).toContain('缺货');
    expect(p).toContain('先');
    expect(p).toMatch(/先.{0,20}(提示|说明).{0,10}缺货/);
    expect(p).toMatch(/再.{0,20}(指明|给出|推荐).{0,20}(仓|来源)/);
  });

  it('调出仓查无库存行 → 同样触发缺货指令', () => {
    const p = buildTransferPrompt(makeSummary(WH), undefined, 'CN_A_US');
    expect(p).toContain('无库存记录');
    expect(p).toContain('先');
  });

  it('缺货时禁 AI 输出结论行（系统补充确定性结论句）', () => {
    const p = buildTransferPrompt(makeSummary([{ name: 'CN_B_UK', available: 0 }]), undefined, 'CN_B_UK');
    expect(p).toContain('结论行不要输出');
  });

  it('缺货态格式行同步去掉结论槽（不与"结论行不要输出"打架）；有货态保留', () => {
    const short = buildTransferPrompt(makeSummary([{ name: 'CN_B_UK', available: 0 }]), undefined, 'CN_B_UK');
    expect(short).not.toContain('判断+预测日均+结论（是否建议调拨）+调拨来源');
    expect(short).toContain('判断+预测日均+调拨来源');
    const ok = buildTransferPrompt(makeSummary(WH), undefined, 'CN_B_UK');
    expect(ok).toContain('判断+预测日均+结论（是否建议调拨）+调拨来源');
  });

  it('与借用排除组并存：不可借标注与调出仓状态行同现', () => {
    const wh = [
      { name: 'CN_B_UK', available: 100, reserved: 30 },
      { name: 'CN_A_US', available: 40 },
    ];
    const p = buildTransferPrompt(makeSummary(wh), new Set(['US' as const]), 'CN_A_US');
    expect(p).toContain('调出仓(用户所选): CN_A_US 可用40 预占0 可动用40');
    expect(p).toContain('[不可借]');
  });
});
