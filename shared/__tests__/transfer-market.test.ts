import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAndSummarizeTransfer, buildTransferPrompt } from '../jijia-transfer-data';
import { attributedFba } from '../jijia-data';

afterEach(() => vi.unstubAllGlobals());

const ASIN = 'B0AAAAAAAA1';
const EU_ASIN = 'B0FZGBZFD1';

type Row = Record<string, unknown>;

function baseSalesRow(over: Record<string, unknown>): Row {
  return {
    asin: ASIN, sku: 'S1', productName: '产品', marketName: 'StoreA:US', unitsOrdered: 100,
    sessions: 500, orders: 20, star: 4.5, reviewQuantity: 30, buyBoxPercentage: 80,
    returnsRate: 1, refundsRate: 1, sellingPrice: 29.9, currency: 'USD', sellingSalesRank: null,
    fbaQuantity: 40, inboundQuantity: 0, reservedCustomerOrders: 0, reservedTransfers: 0,
    reservedProcessing: 0, invAgeList: [],
    // 广告字段语义（2026-08-26 实测）：adsSpend 为负（CNY 记账支出为负），
    // 广告销售额 = adsSales（acos=|spend|/adsSales 逐位吻合），adsItemSales 是另一口径
    adsSpend: 0, adsSales: 0, adsItemSales: 0, adsClicks: 0, adsImpressions: 0,
    ...over,
  };
}

function salesRows(): Row[] {
  // 两个市场：US 销量高、DE 销量低。行 = ASIN×市场
  return [
    baseSalesRow({ marketName: 'StoreA:US' }),
    baseSalesRow({ marketName: 'StoreB:DE', unitsOrdered: 10, sessions: 50, orders: 2,
      star: 4.2, reviewQuantity: 12, buyBoxPercentage: 70, returnsRate: 2, refundsRate: 2,
      sellingPrice: 27.9, fbaQuantity: 5 }),
  ];
}

/** EU 商品 + AE 跟卖：AE 行销量最高，指标刻意做成"若被采信必然错" */
function euAeRows(): Row[] {
  return [
    baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'SUPRENT_Global:AE', unitsOrdered: 200,
      sessions: 1000, orders: 40, star: 4.9, reviewQuantity: 999, buyBoxPercentage: 95,
      returnsRate: 30, refundsRate: 25, sellingPrice: 99, currency: 'AED',
      sellingSalesRank: { mainCategory: 'AE大类', mainCategoryRank: 150, subCategory: 'AE小类', subCategoryRank: 10 },
      fbaQuantity: 11, inboundQuantity: 0,
    }),
    baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'Yaoshu:DE', unitsOrdered: 167,
      sessions: 800, orders: 30, star: 4.2, reviewQuantity: 30, buyBoxPercentage: 85,
      returnsRate: 2, refundsRate: 1.5, sellingPrice: 19.9, currency: 'EUR',
      sellingSalesRank: { mainCategory: 'Home', mainCategoryRank: 8000, subCategory: 'Sub', subCategoryRank: 300 },
      fbaQuantity: 577, inboundQuantity: 3,
      adsSpend: -100, adsSales: 400, adsItemSales: 999, adsClicks: 20, adsImpressions: 1000,
      reservedCustomerOrders: 11, reservedTransfers: 57, reservedProcessing: 10,
    }),
    baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'Yaoshu:FR', unitsOrdered: 50,
      sessions: 300, orders: 10, star: 4.8, reviewQuantity: 12, buyBoxPercentage: 75,
      returnsRate: 1, refundsRate: 1, sellingPrice: 22.5, currency: 'EUR',
      sellingSalesRank: { mainCategory: 'Home', mainCategoryRank: 1200, subCategory: 'Sub', subCategoryRank: 90 },
      fbaQuantity: 577, inboundQuantity: 3,
      adsSpend: -50, adsSales: 100, adsItemSales: 888, adsClicks: 10, adsImpressions: 500,
      reservedCustomerOrders: 10, reservedTransfers: 57, reservedProcessing: 10,
    }),
  ];
}

const EU_GROUP = { name: 'EU', markets: ['DE', 'FR', 'IT', 'ES', 'NL', 'BE'] };

function localDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

interface StubOpts {
  rows?: Row[];
  /** 该周期的销售行返回空（模拟零销量周期缺行） */
  emptyBeginDays?: number[];
  /** 按窗口返回不同行（键=近N天），用于测试跨窗口回退 */
  rowsByDays?: Record<number, Row[]>;
  invRows?: Row[];
}

function stubAll(opts: StubOpts = {}): void {
  sessionStorage.setItem('x-auth-token', 'tok');
  const rows = opts.rows ?? salesRows();
  const inv = opts.invRows ?? [
    { sku: 'S1', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16, purchasePlanQuantity: 0 },
    { sku: 'S1', warehouseId: 201, warehouseName: 'StoreB:EU_FBA', warehouseType: 'FBA',
      availableQty: 581, inTransitQty: 4, reservedQuantity: 0, singleQuantity: 16, purchasePlanQuantity: 0 },
    { sku: 'S1', warehouseId: 202, warehouseName: 'StoreA:US_FBA', warehouseType: 'FBA',
      availableQty: 456, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16, purchasePlanQuantity: 0 },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('warehouseSelection')) {
      return new Response(JSON.stringify({ data: [
        { key: -1, title: '自营仓', children: [
          { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
          { key: -12, title: '海外-自营仓', children: [{ key: 102, title: 'US海外仓', isLeaf: true }] },
        ] },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/asinView')) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const begin = typeof body.beginDate === 'string' ? body.beginDate.replace(/-/g, '') : '';
      // 近N天窗口的 beginDate = 今天−(N−1)（ERP 口径）
      const empty = (opts.emptyBeginDays ?? []).some(d => localDaysAgo(d - 1).replace(/-/g, '') === begin);
      const byDays = Object.keys(opts.rowsByDays ?? {}).map(Number)
        .find(d => localDaysAgo(d - 1).replace(/-/g, '') === begin);
      const winRows = byDays != null ? opts.rowsByDays![byDays]! : rows;
      return new Response(JSON.stringify({ data: { rows: empty ? [] : winRows } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('pageQuery')) {
      return new Response(JSON.stringify({ data: { rows: inv } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected url ' + url);
  }));
}

describe('attributedFba 店铺匹配', () => {
  it('店铺比较忽略大小写（仓名原始大小写 vs 传入大写）', () => {
    const r = attributedFba(
      [{ name: 'Yaoshu:EU_FBA', available: 656, inTransit: 4 }],
      'YAOSHU', ['DE'], 579, 0,
    );
    expect(r.available).toBe(656);
    expect(r.inTransit).toBe(4);
  });
});

describe('fetchAndSummarizeTransfer（targetMarket 页面目标市场）', () => {
  it('未传 targetMarket → 取销量最高市场（US），marketScope=top-market', async () => {
    stubAll();
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, []);
    expect(sums[0]!.marketName).toBe('US');
    expect(sums[0]!.marketScope).toBe('top-market');
    expect(sums[0]!.avgDaily30d).toBeCloseTo(100 / 30, 5);
    expect(sums[0]!.singleQuantity).toBe(16); // 箱规来自库存接口
  });

  it('传 targetMarket=DE → 按该市场匹配数据，marketScope=page，FBA=EU 池单份', async () => {
    stubAll();
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'DE');
    expect(sums[0]!.marketName).toBe('DE');
    expect(sums[0]!.marketScope).toBe('page');
    expect(sums[0]!.avgDaily30d).toBeCloseTo(10 / 30, 5);
    expect(sums[0]!.fbaAvailable).toBe(581);  // 库存仓 EU 池一次，而非快照 5
    expect(sums[0]!.fbaInTransit).toBe(4);
  });

  it('未传 targetMarket（销量最高市场 US）→ FBA=US 仓归属', async () => {
    stubAll();
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, []);
    expect(sums[0]!.fbaAvailable).toBe(456);  // StoreA:US_FBA，而非快照 40
  });

  it('targetMarket 无匹配市场 → 回落销量最高市场并明示口径', async () => {
    stubAll();
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, [], 'JP');
    expect(sums[0]!.marketName).toBe('US');
    expect(sums[0]!.marketScope).toBe('top-market');
  });
});

describe('调拨数据层作用域（EU 组 + AE 跟卖污染防护）', () => {
  const euInv = (over: Row[] = []) => [{
    sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
    availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    { sku: 'HC586TX', warehouseId: 201, warehouseName: 'Yaoshu:EU_FBA', warehouseType: 'FBA',
      availableQty: 654, inTransitQty: 4, reservedQuantity: 78, singleQuantity: 10, plPoLnQty: 0 },
    { sku: 'HC586TX', warehouseId: 202, warehouseName: 'SUPRENT_Global:AE_FBA', warehouseType: 'FBA',
      availableQty: 11, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    { sku: 'HC586TX', warehouseId: 203, warehouseName: 'XIUMEI-GLOBAL:US_FBA', warehouseType: 'FBA',
      availableQty: 451, inTransitQty: 320, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    ...over,
  ];

  it('targetMarket=DE 命中 EU 组 → 组口径求和，AE 跟卖行不污染任何派生字段', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.marketScope).toBe('group');
    expect(s.marketName).toContain('EU');
    // 求和口径：销量/Sessions 只有 DE+FR（217/30）
    expect(s.avgDaily30d).toBeCloseTo((167 + 50) / 30, 5);
    expect(s.sessions30d).toBe(800 + 300);
    // CVR 为加权重算：(30+10)/(800+300)*100
    expect(s.cvr30d).toBeCloseTo(40 / 1100 * 100, 5);
    // 广告比率：广告销售额 = adsSales（非 adsItemSales），花费取绝对值（接口为负的记账值）
    expect(s.acos30d).toBeCloseTo(150 / 500 * 100, 5);   // Σ|spend| / ΣadsSales
    expect(s.roas30d).toBeCloseTo(500 / 150, 5);          // 旧实现：负花费 → acos 为负 / roas 沿用首行
    // 代表市场（组内销量最高=DE）字段，而非 AE/FR 的
    expect(s.star).toBe(4.2);              // 旧实现取全市场 max=4.9（AE）
    expect(s.returnsRate).toBeCloseTo((2 * 167 + 1 * 50) / 217, 5);  // 销量加权（2026-08-28 口径），非代表市场单站 2
    expect(s.refundsRate).toBeCloseTo((1.5 * 167 + 1 * 50) / 217, 5);
    expect(s.sellingPrice).toBe(19.9);     // 旧实现首个非零价=99（AE，AED）
    expect(s.currency).toBe('EUR');
    expect(s.reviewQuantity).toBe(42);     // 组内求和 30+12，不含 AE 的 999
    // BSR 逐市场：仅组内市场，AE #150 不得出现
    expect(s.bsrByMarket.map(b => b.market)).toEqual(['DE', 'FR']);
    expect(s.bsrByMarket.map(b => b.mainRank)).toEqual([8000, 1200]);
    // FBA：Yaoshu 的 EU 池一次，AE/US 跨店仓不计
    expect(s.fbaAvailable).toBe(654);
    expect(s.fbaInTransit).toBe(4);
    // 预留走库存接口（EU 池单份）；旧实现=销售快照三段组求和，EFN 复制致 155(≈2×6) 虚高
    expect(s.fbaReserved).toBe(78);
  });

  it('目标市场命中组但该国家无行 → 仍按组聚合（组解析与行存在解耦），missingGroupMarkets 报告', async () => {
    const rows = [baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'StoreB:FR', unitsOrdered: 20,
      sessions: 100, orders: 4, fbaQuantity: 100,
    })];
    stubAll({ rows, invRows: [
      { sku: 'HC586TX', warehouseId: 201, warehouseName: 'Yaoshu:EU_FBA', warehouseType: 'FBA',
        availableQty: 100, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
      { sku: 'HC586TX', warehouseId: 202, warehouseName: 'StoreB:EU_FBA', warehouseType: 'FBA',
        availableQty: 7, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    ] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.marketScope).toBe('group');                     // 旧实现：无 DE 行 → 回落 top-market 单站 FR
    expect(s.avgDaily30d).toBeCloseTo(20 / 30, 5);
    expect(s.missingGroupMarkets).toContain('DE');
    // FBA 用表单声明的目标店（Yaoshu）仓，而非数据行所在店（StoreB）
    expect(s.fbaAvailable).toBe(100);
  });

  it('7d 无报表行 → missingPeriods 标注，prompt 不把缺数据当 0 判下降', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv(), emptyBeginDays: [7] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.missingPeriods).toContain('7d');
    expect(s.avgDaily7d).toBe(0);
    const p = buildTransferPrompt({ ...s, shippingDays: 25, bufferDays: 15, sellUntilDate: '2026-12-31' });
    expect(p).toContain('7d=数据缺失');
    expect(p).not.toContain('趋势:下降');   // 旧实现 7d=0 → 0 < 90d*0.85 误判下降
  });

  it('流量字段行值 null（接口未回传）→ summary 保持 null，prompt 渲染缺失不伪 0', async () => {
    // 防御性一致化（2026-08-28 评审）：asinView 实测数据完好，但两侧面板
    // 消费同一端点，采购侧已 number|null + 缺失渲染，调拨侧不得静默 || 0
    stubAll({
      rowsByDays: { 30: [baseSalesRow({ sessions: null, cvr: null, buyBoxPercentage: null })] },
      invRows: [{
        sku: 'S1', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
        availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 16, purchasePlanQuantity: 0 },
      ],
    });
    const sums = await fetchAndSummarizeTransfer([ASIN], ['S1'], undefined, document, []);
    const s = sums[0]!;
    expect(s.sessions30d).toBeNull();       // 旧实现 || 0 → 0
    expect(s.cvr30d).toBeNull();
    expect(s.buyBox30d).toBeNull();
    expect(s.sessions7d).toBe(500);         // 7d 走 top-market 口径取 US 行（销量最高市场）
    const p = buildTransferPrompt(s);
    expect(p).toContain('30d=数据缺失');    // Sessions 行
    expect(p).toContain('30d=缺失');        // CVR/BuyBox 行（null 不再 toFixed 崩溃）
    expect(p).not.toContain('=null');
    expect(p).not.toContain('NaN');
  });

  it('无 FBA 库存行时兜底 = 代表市场单站快照（非复制快照组求和）', async () => {
    stubAll({ rows: euAeRows(), invRows: [{
      sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    ] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.fbaAvailable).toBe(577);   // 旧实现 = r30 组求和 577+577=1154（EFN 复制快照）
    expect(s.fbaInTransit).toBe(3);
  });

  it('店铺段大小写不一致（表单站点值被大写成 YAOSHU）时 FBA 仍按库存仓归属', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'YAOSHU');
    expect(sums[0]!.fbaAvailable).toBe(654);   // 旧实现精确比较 'Yaoshu'!=='YAOSHU' → 剔除全部仓 → 兜底快照 579
    expect(sums[0]!.fbaInTransit).toBe(4);
  });

  it('计采交合计（plPoLnQty=计划+采购+交货）进入国内仓块，旧口径 purchasePlanQuantity 不计入', async () => {
    stubAll({ rows: euAeRows(), invRows: [{
      sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10,
      purchasePlanQuantity: 999, plPoLnQty: 100 },
      ...euInv(),
    ] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.purchaseInTransit).toBe(100);          // plPoLnQty，而非旧口径 999
    const p = buildTransferPrompt({ ...s, shippingDays: 25, bufferDays: 15, sellUntilDate: '2026-12-31' });
    expect(p).toContain('计采交合计(计划量+采购量+交货量,未来的货): 100');
    expect(p).toContain('计采100');                  // 每仓行
    expect(p).not.toContain('999');
  });

  it('国内仓展示预占与可动用（可用未扣预占，2026-08-27 用户修正口径）', async () => {
    stubAll({ rows: euAeRows(), invRows: [{
      sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 50, inTransitQty: 0, reservedQuantity: 12, singleQuantity: 10,
      purchasePlanQuantity: 999, plPoLnQty: 100 },
      ...euInv().filter(r => r.warehouseName !== '杭州仓'),
    ] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    expect(s.domesticReserved).toBe(12);
    const p = buildTransferPrompt({ ...s, shippingDays: 25, bufferDays: 15, sellUntilDate: '2026-12-31' });
    expect(p).toContain('预占12');
    expect(p).toContain('可动用38');   // 50 − 12
  });

  it('prompt：BSR 逐市场列出，售价用代表市场货币符号', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const p = buildTransferPrompt({ ...sums[0]!, shippingDays: 25, bufferDays: 15, sellUntilDate: '2026-12-31' });
    expect(p).toContain('BSR: DE #8000 / FR #1200');
    expect(p).not.toContain('#150');          // AE 排名不出现
    expect(p).toContain('€20');               // 19.9 EUR → €20
    expect(p).not.toContain('调出仓库存');     // 从未接线的死数据块,已删除(国内仓块覆盖其职能)
  });
});

describe('目标市场解析修复（调入仓库口径）', () => {
  const euInv = () => [{
    sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
    availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
    { sku: 'HC586TX', warehouseId: 201, warehouseName: 'Yaoshu:EU_FBA', warehouseType: 'FBA',
      availableQty: 654, inTransitQty: 4, reservedQuantity: 78, singleQuantity: 10, plPoLnQty: 0 },
    { sku: 'HC586TX', warehouseId: 202, warehouseName: 'SUPRENT_Global:AE_FBA', warehouseType: 'FBA',
      availableQty: 11, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
  ];

  it('resolveMarketGroup 支持按组名匹配（EU_FBA 仓库 → 区域码 EU）', async () => {
    const { resolveMarketGroup } = await import('../jijia-data');
    const groups = [{ name: 'EU', markets: ['DE', 'FR'] }];
    expect(resolveMarketGroup('EU', groups)?.name).toBe('EU');       // 组名匹配
    expect(resolveMarketGroup('eu', groups)?.name).toBe('EU');       // 大小写不敏感
    expect(resolveMarketGroup('DE', groups)?.name).toBe('EU');       // 组员匹配保持不变
    expect(resolveMarketGroup('US', groups)).toBeUndefined();
  });

  it('targetMarket=EU 且未配置汇总组 → 内置欧洲组，不回落销量最高市场（bug 2）', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    // euAeRows: AE 200 单最高、DE 167、FR 50、UK 不在其中；未配置任何组
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [], 'EU', 'Yaoshu');
    const s = sums[0]!;
    expect(s.marketScope).toBe('group');
    expect(s.marketName).toContain('EU');
    expect(s.marketGroupBuiltin).toBe(true);                  // UI 据此提示"使用内置组"
    expect(s.avgDaily30d).toBeCloseTo((167 + 50) / 30, 5);    // DE+FR，不含 AE 200
    expect(s.sessions30d).toBe(800 + 300);
    expect(s.fbaAvailable).toBe(654);                         // Yaoshu EU 池，AE 仓不计
  });

  it('配置了含 EU 组员的汇总组时优先用配置组（不标 builtin）', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'EU', 'Yaoshu');
    const s = sums[0]!;
    expect(s.marketScope).toBe('group');
    expect(s.marketGroupBuiltin).toBeUndefined();
  });

  it('内置 EU 组不报"缺站点"警告（27 国必然缺大半）', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [], 'EU', 'Yaoshu');
    expect(sums[0]!.missingGroupMarkets).toBeUndefined();
  });

  it('组口径退货/退款率按销量加权（非代表市场单站值）', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const s = sums[0]!;
    // DE 167@2%/1.5%，FR 50@1%/1% → 加权 (2*167+1*50)/217 / (1.5*167+1*50)/217
    expect(s.returnsRate).toBeCloseTo((2 * 167 + 1 * 50) / 217, 5);
    expect(s.refundsRate).toBeCloseTo((1.5 * 167 + 1 * 50) / 217, 5);
  });

  it('prompt 质量行标注退货/退款率窗口为 30d（bug 3 口径标注）', async () => {
    stubAll({ rows: euAeRows(), invRows: euInv() });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [EU_GROUP], 'DE', 'Yaoshu');
    const p = buildTransferPrompt({ ...sums[0]!, shippingDays: 25, bufferDays: 15, sellUntilDate: '2026-12-31' });
    expect(p).toContain('退货率(30d):');
    expect(p).toContain('退款率(30d):');
  });

  it('星级/评论快照回退：30d 行归零（变体合并中）取 60d 行的值', async () => {
    const uk30 = baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'Yaoshu:UK',
      unitsOrdered: 59, sessions: 1427, orders: 54, star: 0, reviewQuantity: 0,
      returnsRate: 6.78, refundsRate: 8.47,
    });
    const uk60 = baseSalesRow({
      asin: EU_ASIN, sku: 'HC586TX', marketName: 'Yaoshu:UK',
      unitsOrdered: 94, sessions: 2825, orders: 90, star: 4.4, reviewQuantity: 260,
    });
    stubAll({ rowsByDays: {
      30: [uk30],
      60: [uk60],
      90: [uk60],
    }, invRows: [{
      sku: 'HC586TX', warehouseId: 101, warehouseName: '杭州仓', warehouseType: 'SELF',
      availableQty: 50, inTransitQty: 0, reservedQuantity: 0, singleQuantity: 10, purchasePlanQuantity: 0 },
      { sku: 'HC586TX', warehouseId: 204, warehouseName: 'Yaoshu:UK_FBA', warehouseType: 'FBA',
        availableQty: 58, inTransitQty: 120, reservedQuantity: 4, singleQuantity: 10, purchasePlanQuantity: 0 },
    ] });
    const sums = await fetchAndSummarizeTransfer([EU_ASIN], ['HC586TX'], undefined, document, [], 'UK', 'Yaoshu');
    const s = sums[0]!;
    expect(s.marketScope).toBe('page');
    expect(s.star).toBe(4.4);
    expect(s.reviewQuantity).toBe(260);
    expect(s.returnsRate).toBe(6.78);   // 比率不是快照，不回退，取 30d 原值
  });
});
