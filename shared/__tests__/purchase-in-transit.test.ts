import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAndSummarize } from '../jijia-data';

afterEach(() => vi.unstubAllGlobals());

/** 全管线 mock：仓库树 / 销售 / 库存（库存行带 purchasePlanQuantity） */
function stubPipeline(invRows: Array<Record<string, unknown>>): void {
  sessionStorage.setItem('x-auth-token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('warehouseSelection')) {
      return new Response(JSON.stringify({ code: 0, data: [
        { key: -1, title: '自营仓', children: [
          { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
          { key: -12, title: '海外-自营仓', children: [{ key: 102, title: 'US海外仓', isLeaf: true }] },
        ] },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/asinView')) {
      return new Response(JSON.stringify({ code: 0, data: { rows: [
        { sku: 'S1', marketName: 'StoreA:US', unitsOrdered: 70, sessions: 100, orders: 10,
          cvr: 10, buyBoxPercentage: 80, star: 4.5, reviewQuantity: 30, returnsRate: 1, refundsRate: 1,
          sellersRank: null, fbaQuantity: 40, inboundQuantity: 0,
          reservedCustomerOrders: 0, reservedTransfers: 0, reservedProcessing: 0, invAgeList: [],
          adsSpend: -100, adsSales: 400, adsItemSales: 999, adsClicks: 20, adsImpressions: 1000,
          adsOrders: 0, naturalOrders: 0, cpc: 5, ctr: 2, acos: 25, roas: 4, pageViews: 0 },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('pageQuery')) {
      return new Response(JSON.stringify({ code: 0, data: { rows: invRows } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected url ' + url);
  }));
}

const INV_ROWS = [
  { sku: 'S1', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
    availableQty: 10, inTransitQty: 5, reservedQuantity: 0, singleQuantity: 16,
    purchasePlanQuantity: 999, plPoLnQty: 100, productName: 'P' }, // 999 是旧口径字段,不再计入
  { sku: 'S1', warehouseId: 102, warehouseName: 'US海外仓', warehouseType: 'SELF',
    availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
    purchasePlanQuantity: 0, plPoLnQty: 55, productName: 'P' }, // 海外仓的计采交合计不计入国内口径
];

describe('fetchAndSummarize（调拨发运管线口径，2026-09-08 结论二）', () => {
  // 实测形态取自 HC586TX 库存行：Yaoshu:EU_FBA 行 在途336/已发240/待入96 之类
  // max 形态、云途中转仓 avail28/待出运48、Yaoshu:EU_FBA working=288
  const PIPE_ROWS = [
    { sku: 'S1', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 0, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
      purchasePlanQuantity: 0, plPoLnQty: 0, productName: 'P' },
    { sku: 'S1', warehouseId: 201, warehouseName: 'Yaoshu:US_FBA', warehouseType: 'FBA',
      availableQty: 10, inTransitQty: 336, reservedQuantity: 0, singleQuantity: 16,
      purchasePlanQuantity: 0, plPoLnQty: 0, productName: 'P',
      erpWorking: 288, erpWaitShipped: 48, erpShipped: 240, erpReceiving: 120 },
  ];

  it('在途合计走未来口径：max(货件在途,已发货+待入库)+待出运（336 vs 360 → 408，非 336）', async () => {
    stubPipeline(PIPE_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.fbaInTransit).toBe(408);   // max(336, 240+120) + 48
    expect(s!.totalInTransit).toBe(408);
  });

  it('待出库 erpWorking 不进采购在途（货仍在源仓可用量里，总盘视角计入即双计）', async () => {
    stubPipeline(PIPE_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.totalInTransit).toBe(408);             // 不含 working 288
    expect(s!.transferWaitShippedTotal).toBe(48);    // 待出运参考行数据源
  });

  it('THIRD 中转仓行进 other 桶（旧 else-if 链落不进任何桶，对公式完全不可见）', async () => {
    stubPipeline([
      ...PIPE_ROWS,
      { sku: 'S1', warehouseId: 301, warehouseName: '云途-杭州中转仓', warehouseType: 'THIRD',
        availableQty: 28, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
        purchasePlanQuantity: 0, plPoLnQty: 0, productName: 'P',
        erpWorking: 0, erpWaitShipped: 0, erpShipped: 10, erpReceiving: 0 },
    ]);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.otherAvailable).toBe(28);
    expect(s!.otherInTransit).toBe(10);              // max(0, 10+0) + 0
    expect(s!.totalAvailable).toBe(10 + 28);
    expect(s!.totalInTransit).toBe(408 + 10);
  });

  it('TIKTOK_FBT 行进 fba 桶（语义=FBA/WFS，用户口径；_FBT 仓名可解析）', async () => {
    stubPipeline([
      ...PIPE_ROWS,
      { sku: 'S1', warehouseId: 401, warehouseName: 'SUPRENT-TK-US:US_FBT', warehouseType: 'TIKTOK_FBT',
        availableQty: 5, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
        purchasePlanQuantity: 0, plPoLnQty: 0, productName: 'P',
        erpWorking: 0, erpWaitShipped: 12, erpShipped: 0, erpReceiving: 0 },
    ]);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.fbaAvailable).toBe(15);                // 10 + 5
    expect(s!.fbaInTransit).toBe(420);               // 408 + (max(0,0)+12)
    expect(s!.transferWaitShippedTotal).toBe(60);    // 48 + 12（全仓求和）
  });

  it('warehouseDetail 每仓携带管线分量（shipped/receiving/waitShipped/working）', async () => {
    stubPipeline(PIPE_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    const w = (s!.warehouseDetail || []).find(x => x.name === 'Yaoshu:US_FBA');
    expect(w).toBeDefined();
    expect(w!.shipped).toBe(240);
    expect(w!.receiving).toBe(120);
    expect(w!.waitShipped).toBe(48);
    expect(w!.working).toBe(288);
  });
});

describe('fetchAndSummarize（计采交合计 = plPoLnQty = 计划量+采购量+交货量）', () => {
  it('purchaseInTransit = 国内仓行 plPoLnQty 求和，purchasePlanQuantity 旧口径不再计入（海外仓不计）', async () => {
    stubPipeline(INV_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.purchaseInTransit).toBe(100);
    expect(s!.domesticAvailable).toBe(10);
    expect(s!.domesticInTransit).toBe(5); // 调拨在途与计采交合计分开存
  });

  it('广告比率：ACOS=Σ|花费|/ΣadsSales，ROAS=ΣadsSales/Σ|花费|，CPC 取绝对值（adsSpend 接口为负）', async () => {
    stubPipeline(INV_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.acos30d).toBeCloseTo(25, 5);   // 100/400
    expect(s!.roas30d).toBeCloseTo(4, 5);    // 400/100；旧实现 roas 因花费<0 沿用行字段/首行
    expect(s!.cpc30d).toBeCloseTo(5, 5);     // 100/20；旧实现为负
    expect(s!.ctr30d).toBeCloseTo(2, 5);     // 20/1000
  });

  it('warehouseDetail 带上每仓 purchasePlanQty（= plPoLnQty，供多渠道站点行汇总）', async () => {
    stubPipeline(INV_ROWS);
    const [s] = await fetchAndSummarize(['S1'], document);
    const detail = s!.warehouseDetail || [];
    expect(detail.find(w => w.name === '杭州仓')?.purchasePlanQty).toBe(100);
    expect(detail.find(w => w.name === 'US海外仓')?.purchasePlanQty).toBe(55);
  });

  it('提示词库存块包含计采交合计（含交货量口径）', async () => {
    stubPipeline(INV_ROWS);
    const { buildAiPrompt } = await import('../jijia-data');
    const [s] = await fetchAndSummarize(['S1'], document);
    const p = buildAiPrompt(s!);
    expect(p).toContain('计采交合计(计划量+采购量+交货量');
    expect(p).toContain('100');
  });

  it('国内仓展示预占与可动用（可用未扣预占）', async () => {
    stubPipeline(INV_ROWS.map(r => r.warehouseName === '杭州仓' ? { ...r, reservedQuantity: 12 } : r));
    const { buildAiPrompt } = await import('../jijia-data');
    const [s] = await fetchAndSummarize(['S1'], document);
    expect(s!.domesticReserved).toBe(12);
    const p = buildAiPrompt(s!);
    expect(p).toContain('预占12');
    expect(p).toContain('可动用');     // 可用 − 预留
  });

  it('全局 FBA 库存以库存接口为准：欧盟共享池只计一次，不被销售快照复制值放大', async () => {
    // 场景取自真实数据（HC586TX）：销售接口把 EU 池复制到 6 个站点（各 ~577），
    // 库存接口 EU_FBA 只有一行 581
    sessionStorage.setItem('x-auth-token', 'tok');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('warehouseSelection')) {
        return new Response(JSON.stringify({ code: 0, data: [
          { key: -1, title: '自营仓', children: [
            { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
          ] },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/asinView')) {
        const mk = (mkt: string, fba: number) => ({
          sku: 'S1', marketName: mkt, unitsOrdered: 10, sessions: 100, orders: 5,
          cvr: 5, buyBoxPercentage: 80, star: 4.5, reviewQuantity: 10, returnsRate: 1, refundsRate: 1,
          sellersRank: null, fbaQuantity: fba, inboundQuantity: 4,
          reservedCustomerOrders: 0, reservedTransfers: 0, reservedProcessing: 0, invAgeList: [],
          adsSpend: 0, acos: 0, roas: 0, adsOrders: 0, naturalOrders: 0, adsImpressions: 0,
          adsClicks: 0, adsItemSales: 0, cpc: 0, ctr: 0, pageViews: 0,
        });
        return new Response(JSON.stringify({ code: 0, data: { rows: [
          mk('Yaoshu:DE', 579), mk('Yaoshu:FR', 577), mk('Yaoshu:IT', 577),
          mk('Yaoshu:ES', 577), mk('Yaoshu:NL', 577), mk('Yaoshu:BE', 577),
        ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('pageQuery')) {
        return new Response(JSON.stringify({ code: 0, data: { rows: [
          { sku: 'S1', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
            availableQty: 0, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
            purchasePlanQuantity: 0, productName: 'P' },
          { sku: 'S1', warehouseId: 201, warehouseName: 'Yaoshu:EU_FBA', warehouseType: 'FBA',
            availableQty: 581, inTransitQty: 4, reservedQuantity: 0, singleQuantity: 16,
            purchasePlanQuantity: 0, productName: 'P' },
          { sku: 'S1', warehouseId: 202, warehouseName: 'XIUMEI-GLOBAL:US_FBA', warehouseType: 'FBA',
            availableQty: 456, inTransitQty: 320, reservedQuantity: 0, singleQuantity: 16,
            purchasePlanQuantity: 0, productName: 'P' },
        ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('unexpected url ' + url);
    }));

    const [s] = await fetchAndSummarize(['S1'], document);
    // 全局 FBA = 库存接口求和（581 + 456），而不是销售快照复制值求和（~3464）
    expect(s!.fbaAvailable).toBe(581 + 456);
    expect(s!.fbaInTransit).toBe(4 + 320);
  });

  it('站点行 FBA 按店铺+国家归属库存仓（EU 站拿到共享池单份）', async () => {
    sessionStorage.setItem('x-auth-token', 'tok');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('warehouseSelection')) {
        return new Response(JSON.stringify({ code: 0, data: [
          { key: -1, title: '自营仓', children: [
            { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
          ] },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/asinView')) {
        const mk = (mkt: string, units: number, fba: number) => ({
          sku: 'S1', marketName: mkt, unitsOrdered: units, sessions: 100, orders: 5,
          cvr: 5, buyBoxPercentage: 80, star: 4.5, reviewQuantity: 10, returnsRate: 1, refundsRate: 1,
          sellersRank: null, fbaQuantity: fba, inboundQuantity: 4,
          reservedCustomerOrders: 0, reservedTransfers: 0, reservedProcessing: 0, invAgeList: [],
          adsSpend: 0, acos: 0, roas: 0, adsOrders: 0, naturalOrders: 0, adsImpressions: 0,
          adsClicks: 0, adsItemSales: 0, cpc: 0, ctr: 0, pageViews: 0,
        });
        return new Response(JSON.stringify({ code: 0, data: { rows: [
          mk('Yaoshu:DE', 167, 579), mk('Yaoshu:FR', 116, 577), mk('Yaoshu:ES', 47, 577),
        ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('pageQuery')) {
        return new Response(JSON.stringify({ code: 0, data: { rows: [
          { sku: 'S1', warehouseId: 201, warehouseName: 'Yaoshu:EU_FBA', warehouseType: 'FBA',
            availableQty: 581, inTransitQty: 4, reservedQuantity: 0, singleQuantity: 16,
            purchasePlanQuantity: 0, productName: 'P' },
          { sku: 'S1', warehouseId: 202, warehouseName: 'OtherStore:EU_FBA', warehouseType: 'FBA',
            availableQty: 999, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16,
            purchasePlanQuantity: 0, productName: 'P' }, // 别家店铺的 EU 仓不计入
        ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('unexpected url ' + url);
    }));

    const [s] = await fetchAndSummarize(['S1'], document, new Map([['S1', ['DE:Yaoshu']]]));
    const sd = s!.siteDatas?.find(x => x.site === 'DE:Yaoshu');
    expect(sd).toBeDefined();
    expect(sd!.fbaAvailable).toBe(581);  // 本店铺 EU 池单份，别家店铺 999 不计入
    expect(sd!.fbaInTransit).toBe(4);
  });
});
