// shared/jijia-transfer-data.ts
// Fetches sales + inventory data for transfer order ASIN analysis.

import { getAuthToken } from './auth';
import { fetchDomesticWarehouseIds, isDomesticWarehouse } from './api-client';
import { fetchAsinViewRows, fetchInventoryRows } from './jijia-api';
import { ErpApiError } from './erp-errors';
import type { MarketGroup } from './types';
import { EU_COUNTRIES } from './fba-warehouse';
import { resolveMarketGroup, attributedFba, backfillQualitySnapshots } from './jijia-data';
import {
  domesticNonLendable, parseDomesticSiteGroup, pickFallbackSourceWarehouse, transferSourceCapacity,
  type DomesticSiteGroup,
} from './domestic-pool';

// --- Raw API row types ---

interface SalesRow {
  asin: string;
  sku: string;
  productName: string;
  marketName: string;
  currency: string;
  sellingPrice: number;
  unitsOrdered: number;
  averageDailySales: number;
  /** 流量字段接口可能不回传（null），与采购侧同语义：null=缺失≠0 */
  sessions: number | null;
  cvr: number | null;
  buyBoxPercentage: number | null;
  sellingSalesRank: {
    mainCategory: string;
    mainCategoryRank: number;
    subCategory: string;
    subCategoryRank: number;
  } | null;
  star: number;
  reviewQuantity: number;
  returnsRate: number;
  refundsRate: number;
  fbaQuantity: number;
  inboundQuantity: number;
  reservedCustomerOrders: number;
  reservedTransfers: number;
  reservedProcessing: number;
  invAgeList: Array<{ label: string; value: number }>;
  adsImpressions: number;
  adsClicks: number;
  ctr: number;
  cpc: number;
  adsOrders: number;
  adsCvr: number;
  adsSpend: number;
  acos: number;
  roas: number;
  adsItemSales: number;
  /** 广告销售额（行级 acos=|adsSpend|/adsSales 逐位验证；adsItemSales 是"广告商品销售额"另一口径） */
  adsSales: number;
  naturalOrders: number;
  orders: number;
}

interface InvRow {
  sku: string;
  warehouseId: number;
  warehouseName: string;
  warehouseType: string;
  availableQty: number;
  inTransitQty: number;
  reservedQuantity: number;
  productName: string;
  singleQuantity: number;
  /** 计采交合计 plPoLnQty（ERP"计采交合计量"列 = PL/PO/LN Qty：
   *  计划量+采购量+交货量；purchasePlanQuantity 是旧口径不再计入） */
  plPoLnQty: number;
  /** 调拨发运管线四阶段（按目的仓行归属，2026-09-08 口径）：
   *  待出库（单已建未出库，货仍在源仓）/ 待出运（已出库未发运，不在任何在途里）/
   *  已发货 / 待入库（已到目的仓部分入库） */
  erpWorking?: number;
  erpWaitShipped?: number;
  erpShipped?: number;
  erpReceiving?: number;
}

// --- Summary type ---

export interface AsinSummary {
  asin: string;
  sku: string;
  msku: string;
  productName: string;
  marketName: string;
  /** 市场口径：page = 运营指定的页面目标市场；group = 按汇总组聚合；
   *  top-market = 该 ASIN 销量最高市场（目标市场未指定/未匹配时的兜底） */
  marketScope?: 'page' | 'group' | 'top-market';
  /** 命中的是内置欧洲组（EU 区域码兜底、设置未配置）——UI 需向用户明示 */
  marketGroupBuiltin?: boolean;
  sellingPrice: number;
  singleQuantity: number;

  // Domestic inventory
  domesticWarehouses: Array<{ name: string; available: number; inTransit: number; purchaseQty?: number; reserved?: number }>;
  domesticAvailable: number;
  /** 国内仓预占合计（availableQty 未扣预占，可动用 = 可用 − 预占） */
  domesticReserved: number;
  domesticInTransit: number;
  /** 计采交合计（国内仓 计划量+采购量）——调拨量公式不并项，供 AI 判断调拨来源（未来的货） */
  purchaseInTransit: number;

  // FBA inventory
  fbaAvailable: number;
  /** 2026-09-08 管线口径（结论二）：= rowFutureInTransit + 本仓待出库 erpWorking
   *  （调入仓"已建单将流入"计入——调拨 S 不含国内仓无双计；代价：草稿/驳回单
   *  也计入，作废会少调，已知）。面板公式 I 直接用此值。 */
  fbaInTransit: number;
  fbaReserved: number;
  /** 匹配 FBA 仓的管线分量（展示用：已发货/待入库/待出运/待出库） */
  fbaPipeline?: { shipped: number; receiving: number; waitShipped: number; working: number };
  /** 全仓 Σ 调拨待出运（含 THIRD 中转行）——已计入 fbaInTransit，仅参考展示 */
  transferWaitShippedTotal: number;
  invAgeList: Array<{ label: string; value: number }>;

  // Sales multi-period
  avgDaily7d: number;
  avgDaily14d: number;
  avgDaily30d: number;
  avgDaily60d: number;
  avgDaily90d: number;

  // Traffic multi-period（null=该窗口接口未回传，渲染"缺失"≠0）
  sessions7d: number | null;
  sessions14d: number | null;
  sessions30d: number | null;
  sessions60d: number | null;
  sessions90d: number | null;
  cvr7d: number | null;
  cvr14d: number | null;
  cvr30d: number | null;
  cvr60d: number | null;
  cvr90d: number | null;
  buyBox7d: number | null;
  buyBox14d: number | null;
  buyBox30d: number | null;
  buyBox60d: number | null;
  buyBox90d: number | null;

  // Ads multi-period
  adsSpend7d: number;
  adsSpend14d: number;
  adsSpend30d: number;
  adsSpend60d: number;
  adsSpend90d: number;
  acos7d: number;
  acos14d: number;
  acos30d: number;
  acos60d: number;
  acos90d: number;
  roas7d: number;
  roas14d: number;
  roas30d: number;
  roas60d: number;
  roas90d: number;
  adsOrders7d: number;
  adsOrders14d: number;
  adsOrders30d: number;
  adsOrders60d: number;
  adsOrders90d: number;
  naturalOrders7d: number;
  naturalOrders14d: number;
  naturalOrders30d: number;
  naturalOrders60d: number;
  naturalOrders90d: number;

  // BSR (latest from 30d) — 口径内逐市场列出（排名是各站独立序数，不可加/不可比）
  bsrByMarket: Array<{
    market: string; mainCategory: string; mainRank: number;
    subCategory: string; subRank: number;
  }>;
  /** 无报表行的周期（零销量周期整行缺失 ≠ 数值为 0） */
  missingPeriods: string[];
  /** 代表市场（口径内销量最高）原币种 */
  currency: string;

  // Quality (latest from 30d)
  star: number;
  reviewQuantity: number;
  returnsRate: number;
  refundsRate: number;

  // Operator inputs (applied before analysis)
  shippingDays?: number;
  sellUntilDate?: string;
  bufferDays?: number;
  operatorQty?: number;
  operatorNote?: string;
  missingGroupMarkets?: string[];
}

/** Fetch one sales period. Returns per-market data: Map<asin, Map<marketName, SalesRow>>.
 *  行 = ASIN×市场（asinView，与 ERP"销售表现"页面同源——variationAsinView 对 UK
 *  丢流量字段且部分市场 sessions 偏低，2026-08-28 弃用）。 */
async function fetchSalesPeriod(
  asins: string[],
  beginDays: number,
  token: string,
  signal?: AbortSignal,
): Promise<Map<string, Map<string, SalesRow>>> {
  const rows = await fetchAsinViewRows<SalesRow>({ asinList: asins, beginDays, token, signal });

  const map = new Map<string, Map<string, SalesRow>>();
  for (const row of rows) {
    const market = row.marketName || '_unknown';
    let asinMap = map.get(row.asin);
    if (!asinMap) { asinMap = new Map(); map.set(row.asin, asinMap); }
    if (!asinMap.has(market)) asinMap.set(market, row);
  }
  return map;
}

/** Sum additive fields across markets */
function aggregateTransferRow(markets: Map<string, SalesRow> | undefined): SalesRow | null {
  if (!markets || markets.size === 0) return null;
  let merged: SalesRow | null = null;
  // sessions 类型含 null（未回传），局部变量累加避免 null 算术；
  // 全部市场均未回传时保持 null（缺失≠0，与采购侧 mergeMarketRows 同语义）
  let sessionsSum = 0;
  let sessionsAllNull = true;
  for (const row of markets.values()) {
    if (!merged) {
      merged = {
        ...row,
        unitsOrdered: row.unitsOrdered || 0,
        sessions: row.sessions || 0,
        adsSpend: row.adsSpend || 0,
        adsOrders: row.adsOrders || 0,
        naturalOrders: row.naturalOrders || 0,
        adsImpressions: row.adsImpressions || 0,
        fbaQuantity: row.fbaQuantity || 0,
        inboundQuantity: row.inboundQuantity || 0,
        reservedCustomerOrders: row.reservedCustomerOrders || 0,
        reservedTransfers: row.reservedTransfers || 0,
        reservedProcessing: row.reservedProcessing || 0,
        orders: row.orders || 0,
        adsItemSales: row.adsItemSales || 0,
        adsSales: row.adsSales || 0,
        adsClicks: row.adsClicks || 0,
        reviewQuantity: row.reviewQuantity || 0,
      };
      sessionsSum = row.sessions || 0;
      if (row.sessions != null) sessionsAllNull = false;
      continue;
    }
    merged.unitsOrdered += row.unitsOrdered || 0;
    sessionsSum += row.sessions || 0;
    if (row.sessions != null) sessionsAllNull = false;
    merged.adsSpend += row.adsSpend || 0;
    merged.adsOrders += row.adsOrders || 0;
    merged.naturalOrders += row.naturalOrders || 0;
    merged.adsImpressions += row.adsImpressions || 0;
    merged.fbaQuantity += row.fbaQuantity || 0;
    merged.inboundQuantity += row.inboundQuantity || 0;
    merged.reservedCustomerOrders += row.reservedCustomerOrders || 0;
    merged.reservedTransfers += row.reservedTransfers || 0;
    merged.reservedProcessing += row.reservedProcessing || 0;
    merged.orders += row.orders || 0;
    merged.adsItemSales += row.adsItemSales || 0;
    merged.adsSales += row.adsSales || 0;
    merged.adsClicks += row.adsClicks || 0;
    merged.reviewQuantity += row.reviewQuantity || 0;
  }
  if (!merged) return null;
  merged.sessions = sessionsAllNull ? null : sessionsSum;
  // Recompute non-additive fields. 广告花费 adsSpend 接口为负（CNY 记账支出为负），
  // 比率一律取绝对值；广告销售额用 adsSales（与 ERP 行级 acos/roas 口径逐位吻合）
  const spendAbs = Math.abs(merged.adsSpend);
  const sess = merged.sessions || 0;
  if (sess > 0) merged.cvr = merged.orders / sess * 100;
  if (merged.adsImpressions > 0) merged.ctr = merged.adsClicks / merged.adsImpressions * 100;
  if (merged.adsClicks > 0) merged.cpc = spendAbs / merged.adsClicks;
  if (merged.adsSales > 0) merged.acos = spendAbs / merged.adsSales * 100;
  if (spendAbs > 0) merged.roas = merged.adsSales / spendAbs;
  return merged;
}

/** Extract market code from full market name (e.g. "Amazon:DE" -> "DE") */
function extractMarketCode(marketName: string): string {
  const parts = marketName.toUpperCase().split(':');
  return parts[parts.length - 1] || '';
}

/** Filter a market map to only include markets in the group */
function filterTransferByGroup(
  markets: Map<string, SalesRow> | undefined,
  group: MarketGroup
): Map<string, SalesRow> | undefined {
  if (!markets || markets.size === 0) return undefined;
  const filtered = new Map<string, SalesRow>();
  const upperCodes = group.markets.map(function(m) { return m.toUpperCase(); });
  for (const [name, row] of markets) {
    if (upperCodes.includes(extractMarketCode(name))) {
      filtered.set(name, row);
    }
  }
  return filtered.size > 0 ? filtered : undefined;
}

/** 找目标国家的行（marketName = 店铺:国家）。多店铺命中时优先目标店铺的行 */
function findMarketRow(
  markets: Map<string, SalesRow> | undefined,
  country: string,
  store?: string,
): string | null {
  let fallback: string | null = null;
  for (const mn of markets?.keys() ?? []) {
    if (extractMarketCode(mn) !== country) continue;
    if (store && mn.toUpperCase().split(':')[0] === store.toUpperCase()) return mn;
    if (!fallback) fallback = mn;
  }
  return fallback;
}

/** 代表市场：口径内销量最高（map 按销量降序插入）；有目标店铺时优先该店的行 */
function representativeMarketName(
  markets: Map<string, SalesRow> | undefined,
  store?: string | null,
): string | null {
  let fallback: string | null = null;
  for (const mn of markets?.keys() ?? []) {
    if (!store) return mn;
    if (mn.toUpperCase().split(':')[0] === store.toUpperCase()) return mn;
    if (!fallback) fallback = mn;
  }
  return fallback;
}

function firstRow(markets: Map<string, SalesRow> | undefined): SalesRow | undefined {
  return markets?.values().next().value as SalesRow | undefined;
}

// Domestic warehouse detection now uses the warehouse tree API via api-client.ts

export async function fetchAndSummarizeTransfer(
  asins: string[],
  skus: string[],
  signal?: AbortSignal,
  doc?: Document,
  marketGroups?: MarketGroup[],
  /** 页面目标市场（国家码，如 "DE"，来自表单站点控件或手动输入）。优先按此口径取数 */
  targetMarket?: string,
  /** 目标店铺（来自表单站点控件，如 "Yaoshu"）。用于跨店铺 FBA 仓归属 */
  targetStore?: string,
): Promise<AsinSummary[]> {
  const token = getAuthToken(doc);
  if (!token) throw new Error('未找到 x-auth-token，请刷新页面后重试');

  // --- Parallel: fetch warehouse tree + 5 sales periods + domestic inventory ---
  // allSettled：全部跑完后一次性列出所有无法访问的数据集（快速失败 + 完整清单）
  const settled = await Promise.allSettled([
    fetchDomesticWarehouseIds(token),
    fetchSalesPeriod(asins, 7, token, signal),
    fetchSalesPeriod(asins, 14, token, signal),
    fetchSalesPeriod(asins, 30, token, signal),
    fetchSalesPeriod(asins, 60, token, signal),
    fetchSalesPeriod(asins, 90, token, signal),
    // 库存行 = SKU×仓库，fetchInventoryRows 内翻页取满
    fetchInventoryRows<InvRow>(skus, token, signal),
  ]);
  const DATASETS = ['仓库列表', '销售分析数据', '销售分析数据', '销售分析数据', '销售分析数据', '销售分析数据', '库存数据'];
  const failures: ErpApiError[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const r = s.reason;
      failures.push(r instanceof ErpApiError
        ? r
        : new ErpApiError('api', [DATASETS[i]!], String((r as Error)?.message || r)));
    }
  });
  if (failures.length > 0) throw ErpApiError.aggregate(failures);

  const [domesticIds, s7, s14, s30, s60, s90, invRows] = settled.map(
    s => (s as PromiseFulfilledResult<never>).value,
  ) as unknown as [Set<number>, Map<string, Map<string, SalesRow>>, Map<string, Map<string, SalesRow>>,
      Map<string, Map<string, SalesRow>>, Map<string, Map<string, SalesRow>>,
      Map<string, Map<string, SalesRow>>, InvRow[]];
  // 星级/评论快照回退（变体合并期间 30d 行归零 → 取 60d/90d 同市场行的值）
  backfillQualitySnapshots(s30, s60, s90);

  // Build domestic inventory per SKU
  const domesticBySku = new Map<string, { available: number; reserved: number; inTransit: number; purchasePlan: number; warehouses: Array<{ name: string; available: number; inTransit: number; purchaseQty?: number; reserved?: number }> }>();
  const boxBySku = new Map<string, number>();
  for (const row of invRows) {
    if (row.singleQuantity && row.singleQuantity > 0) boxBySku.set(row.sku, row.singleQuantity);
    if (!isDomesticWarehouse(row.warehouseId, domesticIds)) continue;
    let entry = domesticBySku.get(row.sku);
    if (!entry) {
      entry = { available: 0, reserved: 0, inTransit: 0, purchasePlan: 0, warehouses: [] };
      domesticBySku.set(row.sku, entry);
    }
    const planPurchase = row.plPoLnQty || 0;
    entry.available += row.availableQty || 0;
    entry.reserved += row.reservedQuantity || 0;
    entry.inTransit += row.inTransitQty || 0;
    entry.purchasePlan += planPurchase;
    entry.warehouses.push({
      name: row.warehouseName, available: row.availableQty || 0, reserved: row.reservedQuantity || 0,
      inTransit: row.inTransitQty || 0, purchaseQty: planPurchase,
    });
  }

  // FBA 仓明细（按 SKU）。欧盟 EFN 共享池在销售快照里会被复制到每个欧洲站点
  // （fbaQuantity 与 reservedTransfers 都是复制值），FBA 库存/预留必须以这里的仓行求和为准。
  // TIKTOK_FBT 语义相当于 FBA/WFS（用户口径，FBT 虚拟仓已弃用）一并归属；
  // 行携带调拨发运管线分量（在途桶与公式走 rowFutureInTransit 未来口径）
  const fbaWhBySku = new Map<string, Array<{
    name: string; available: number; inTransit: number; reserved: number;
    shipped: number; receiving: number; waitShipped: number; working: number;
  }>>();
  const waitShippedBySku = new Map<string, number>();
  for (const row of invRows) {
    waitShippedBySku.set(row.sku, (waitShippedBySku.get(row.sku) || 0) + (row.erpWaitShipped || 0));
    if (row.warehouseType !== 'FBA' && row.warehouseType !== 'WFS' && row.warehouseType !== 'TIKTOK_FBT') continue;
    let list = fbaWhBySku.get(row.sku);
    if (!list) { list = []; fbaWhBySku.set(row.sku, list); }
    list.push({
      name: row.warehouseName, available: row.availableQty || 0,
      inTransit: row.inTransitQty || 0, reserved: row.reservedQuantity || 0,
      shipped: row.erpShipped || 0, receiving: row.erpReceiving || 0,
      waitShipped: row.erpWaitShipped || 0, working: row.erpWorking || 0,
    });
  }

  // Build summaries
  const summaries: AsinSummary[] = [];

  for (const asin of asins) {
    const asinMarkets7 = s7.get(asin);
    const asinMarkets14 = s14.get(asin);
    const asinMarkets30 = s30.get(asin);
    const asinMarkets60 = s60.get(asin);
    const asinMarkets90 = s90.get(asin);

    // 市场口径：目标市场优先且**组解析与行存在解耦**——目标国家命中汇总组即按组聚合
    // （该国家无行时由 missingGroupMarkets 报告，不因缺行回落到无关市场）；
    // 无目标、或目标完全无法匹配时回落"销量最高市场"（请求按 unitsOrdered 降序）。
    // marketName 同时是"代表市场"（组内销量最高/目标店铺优先），派生字段都取自它。
    const any30d = asinMarkets30?.values().next().value as SalesRow | undefined;
    const targetCountry = targetMarket ? targetMarket.toUpperCase() : '';
    let marketName = any30d?.marketName || '';
    let marketScope: 'page' | 'group' | 'top-market' = 'top-market';
    let matchedGroup: MarketGroup | undefined;

    if (targetCountry) {
      // 组解析优先级：配置组（组员或组名匹配）> 内置欧洲组（EU 区域码兜底，27 国不含 UK）
      let g = resolveMarketGroup(targetCountry, marketGroups || []);
      if (!g && targetCountry === 'EU') {
        g = { name: 'EU', markets: Array.from(EU_COUNTRIES), builtin: true };
      }
      const scoped30 = g ? filterTransferByGroup(asinMarkets30, g) : undefined;
      if (g && scoped30) {
        matchedGroup = g;
        marketScope = 'group';
        marketName = representativeMarketName(scoped30, targetStore) || marketName;
      } else if (!g) {
        const mn = findMarketRow(asinMarkets30, targetCountry, targetStore);
        if (mn) { marketName = mn; marketScope = 'page'; }
      }
      // 目标命中组但组内无行 / 目标单市场无行 → 保持 top-market 回落（UI 层告警）
    } else {
      const g = resolveMarketGroup(extractMarketCode(marketName), marketGroups || []);
      const scoped30 = g ? filterTransferByGroup(asinMarkets30, g) : undefined;
      if (g && scoped30) {
        matchedGroup = g;
        marketScope = 'group';
        marketName = representativeMarketName(scoped30, null) || marketName;
      }
    }

    // 每周期的取数集合：组口径 = 组内过滤；单市场 = 该行（包成单元素 Map 统一走聚合）
    const scoped = function (m: Map<string, SalesRow> | undefined): Map<string, SalesRow> | undefined {
      if (!m) return undefined;
      if (matchedGroup) return filterTransferByGroup(m, matchedGroup);
      const row = m.get(marketName);
      return row ? new Map([[marketName, row]]) : undefined;
    };
    const sc7 = scoped(asinMarkets7);
    const sc14 = scoped(asinMarkets14);
    const sc30 = scoped(asinMarkets30);
    const sc60 = scoped(asinMarkets60);
    const sc90 = scoped(asinMarkets90);
    const r7 = aggregateTransferRow(sc7);
    const r14 = aggregateTransferRow(sc14);
    const r30 = aggregateTransferRow(sc30);
    const r60 = aggregateTransferRow(sc60);
    const r90 = aggregateTransferRow(sc90);
    const rep30 = firstRow(sc30) || any30d;
    const rawMarketCode = marketName ? extractMarketCode(marketName) : '';

    const displayMarket = matchedGroup
      ? (matchedGroup.builtin
          ? matchedGroup.name + '（欧洲站汇总）'
          : matchedGroup.name + '（' + matchedGroup.markets.join('+') + '）')
      : rawMarketCode;
    let groupMissing: string[] | undefined;
    if (matchedGroup && !matchedGroup.builtin) {
      const foundCodes = new Set<string>();
      for (const mn of asinMarkets30?.keys() ?? []) {
        foundCodes.add(extractMarketCode(mn));
      }
      const missing = matchedGroup.markets.filter(function(m) { return !foundCodes.has(m.toUpperCase()); });
      if (missing.length > 0) groupMissing = missing;
    }

    const sku = r30?.sku || any30d?.sku || '';
    const dom = domesticBySku.get(sku);

    // 质量/BSR/售价等派生字段一律取自**口径内**数据（组内过滤或单市场行）——
    // 未过滤的全市场集合可能混入跨站点跟卖行（如 AE），会污染这些字段。
    // 星级/退货率/售价/货币 = 代表市场（口径内销量最高）；BSR 逐市场列出。
    const bsrByMarket: AsinSummary['bsrByMarket'] = [];
    for (const [name, row] of sc30 ?? []) {
      const r = row.sellingSalesRank;
      if (!r?.mainCategoryRank) continue;
      bsrByMarket.push({
        market: extractMarketCode(name),
        mainCategory: r.mainCategory || '',
        mainRank: r.mainCategoryRank,
        subCategory: r.subCategory || '',
        subRank: r.subCategoryRank || 0,
      });
    }
    const missingPeriods: string[] = [];
    if (!r7) missingPeriods.push('7d');
    if (!r14) missingPeriods.push('14d');
    if (!r30) missingPeriods.push('30d');
    if (!r60) missingPeriods.push('60d');
    if (!r90) missingPeriods.push('90d');

    const summary: AsinSummary = {
      asin,
      sku,
      msku: '',
      productName: r30?.productName || any30d?.productName || '',
      marketName: displayMarket,
      marketScope,
      sellingPrice: rep30?.sellingPrice || 0,
      currency: rep30?.currency || '',
      singleQuantity: boxBySku.get(sku) || 1,

      goodQty: 0,
      transferableQty: 0,
      maxTransferableQty: 0,
      processedReserved: 0,
      unprocessedReserved: 0,
      shortage: 0,

      domesticWarehouses: dom?.warehouses || [],
      domesticAvailable: dom?.available || 0,
      domesticReserved: dom?.reserved || 0,
      domesticInTransit: dom?.inTransit || 0,
      purchaseInTransit: dom?.purchasePlan || 0,

      // FBA 库存/预留从库存仓按 店铺+国家归属（EU 共享池只计一次）。store 优先用表单
      // 声明的目标店铺；无 FBA 库存行时兜底 = 代表市场单站快照（组内复制快照不可求和）。
      // 2026-09-08 管线口径（结论二）：在途 = rowFutureInTransit（max 去重 + 待出运）
      // + 本仓待出库 erpWorking（调入仓视角"已建单将流入"，无双计）
      ...(() => {
        const tfba = attributedFba(
          fbaWhBySku.get(sku),
          targetStore || (marketName.includes(':') ? marketName.split(':')[0]! : null),
          matchedGroup ? matchedGroup.markets : (rawMarketCode ? [rawMarketCode] : []),
          rep30?.fbaQuantity || 0, rep30?.inboundQuantity || 0,
          (rep30?.reservedCustomerOrders || 0) + (rep30?.reservedTransfers || 0) + (rep30?.reservedProcessing || 0));
        return {
          fbaAvailable: tfba.available,
          fbaInTransit: tfba.inTransit + tfba.working,
          fbaReserved: tfba.reserved,
          fbaPipeline: {
            shipped: tfba.shipped, receiving: tfba.receiving,
            waitShipped: tfba.waitShipped, working: tfba.working,
          },
          transferWaitShippedTotal: waitShippedBySku.get(sku) || 0,
        };
      })(),
      invAgeList: r30?.invAgeList || [],

      avgDaily7d: r7 ? r7.unitsOrdered / 7 : 0,
      avgDaily14d: r14 ? r14.unitsOrdered / 14 : 0,
      avgDaily30d: r30 ? r30.unitsOrdered / 30 : 0,
      avgDaily60d: r60 ? r60.unitsOrdered / 60 : 0,
      avgDaily90d: r90 ? r90.unitsOrdered / 90 : 0,

      sessions7d: r7?.sessions ?? null,
      sessions14d: r14?.sessions ?? null,
      sessions30d: r30?.sessions ?? null,
      sessions60d: r60?.sessions ?? null,
      sessions90d: r90?.sessions ?? null,
      cvr7d: r7?.cvr ?? null,
      cvr14d: r14?.cvr ?? null,
      cvr30d: r30?.cvr ?? null,
      cvr60d: r60?.cvr ?? null,
      cvr90d: r90?.cvr ?? null,
      buyBox7d: firstRow(sc7)?.buyBoxPercentage ?? null,
      buyBox14d: firstRow(sc14)?.buyBoxPercentage ?? null,
      buyBox30d: firstRow(sc30)?.buyBoxPercentage ?? null,
      buyBox60d: firstRow(sc60)?.buyBoxPercentage ?? null,
      buyBox90d: firstRow(sc90)?.buyBoxPercentage ?? null,

      adsSpend7d: r7?.adsSpend || 0,
      adsSpend14d: r14?.adsSpend || 0,
      adsSpend30d: r30?.adsSpend || 0,
      adsSpend60d: r60?.adsSpend || 0,
      adsSpend90d: r90?.adsSpend || 0,
      acos7d: r7?.acos || 0,
      acos14d: r14?.acos || 0,
      acos30d: r30?.acos || 0,
      acos60d: r60?.acos || 0,
      acos90d: r90?.acos || 0,
      roas7d: r7?.roas || 0,
      roas14d: r14?.roas || 0,
      roas30d: r30?.roas || 0,
      roas60d: r60?.roas || 0,
      roas90d: r90?.roas || 0,
      adsOrders7d: r7?.adsOrders || 0,
      adsOrders14d: r14?.adsOrders || 0,
      adsOrders30d: r30?.adsOrders || 0,
      adsOrders60d: r60?.adsOrders || 0,
      adsOrders90d: r90?.adsOrders || 0,
      naturalOrders7d: r7?.naturalOrders || 0,
      naturalOrders14d: r14?.naturalOrders || 0,
      naturalOrders30d: r30?.naturalOrders || 0,
      naturalOrders60d: r60?.naturalOrders || 0,
      naturalOrders90d: r90?.naturalOrders || 0,

      bsrByMarket,
      missingPeriods,

      star: rep30?.star || 0,
      reviewQuantity: r30?.reviewQuantity || 0,
      // 退货/退款率按口径内销量加权（≈退货量/销量；单市场=自身值），不取代表市场单站值
      returnsRate: (() => {
        let w = 0, u = 0;
        for (const row of sc30?.values() ?? []) { w += (row.returnsRate || 0) * (row.unitsOrdered || 0); u += row.unitsOrdered || 0; }
        return u > 0 ? w / u : (rep30?.returnsRate || 0);
      })(),
      refundsRate: (() => {
        let w = 0, u = 0;
        for (const row of sc30?.values() ?? []) { w += (row.refundsRate || 0) * (row.unitsOrdered || 0); u += row.unitsOrdered || 0; }
        return u > 0 ? w / u : (rep30?.refundsRate || 0);
      })(),
      marketGroupBuiltin: matchedGroup?.builtin ? true : undefined,
      missingGroupMarkets: groupMissing,
    };

    summaries.push(summary);
  }

  return summaries;
}

function fmtCurrency(n: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€'
    : currency === 'GBP' ? '£' : (currency === 'JPY' || currency === 'CNY') ? '¥'
    : (currency ? currency + ' ' : '');
  return sym + n.toFixed(0);
}

/** 调出仓状态行（feature/suggestion-update）：用户表单所选调出仓在此 SKU 的国内仓
 *  库存状态。缺货/全部被预占 → 标注"缺货"并触发提示词顺序指令（先提示缺货，再荐
 *  替代仓）；有货 → 安静信息行（界面灰字 + AI 优先从该仓荐）。
 *  匹配失败的两种走向（评审 #1 防御）：label 是裸国内仓名（CN/GZ 前缀、仅字母数字
 *  与_-，如 CN_C_CA）而库存查无行 → 真没货（接口 filterQuantity 不回零量行），判缺货；
 *  label 非裸名格式（带前缀/装饰，如 Yaoshu:CN_B_UK）→ 返回 null 整体静默——
 *  宁可少说一句，不冒假缺货警报（错误方向不对称）。未选调出仓同样返回 null。 */
export function sourceWarehouseStatus(
  name: string | undefined,
  warehouses: Array<{ name: string; available?: number; inTransit?: number; reserved?: number }> | undefined,
): string | null {
  const n = (name || '').trim();
  if (!n) return null;
  const row = (warehouses || []).find(function (w) {
    return (w.name || '').trim().toLowerCase() === n.toLowerCase();
  });
  if (!row) {
    const bareDomesticName = /^(cn|gz)[-_][A-Za-z0-9_-]*$/i.test(n);
    if (!bareDomesticName) return null;
    return '调出仓(用户所选): ' + n + ' 无库存记录(该SKU在此仓无货) —— 缺货';
  }
  const avail = row.available || 0;
  const reserved = row.reserved || 0;
  const movable = transferSourceCapacity(avail, reserved, 0);
  if (movable > 0) {
    return '调出仓(用户所选): ' + row.name + ' 可用' + avail + ' 预占' + reserved + ' 可动用' + movable;
  }
  if (avail > 0) {
    return '调出仓(用户所选): ' + row.name + ' 可用' + avail + ' 预占' + reserved +
      ' 可动用0(全部被预占) —— 缺货';
  }
  return '调出仓(用户所选): ' + row.name + ' 可用0 —— 缺货';
}

/** 卡片前端状态行 HTML（feature/suggestion-update）：sourceWarehouseStatus 结果 →
 *  纯文字行渲染（无背景框/边框——用户要求，避免全宽色块抢眼）。缺货=红色 ⚠ 文字；
 *  有货=安静灰字；null=不渲染。事实性结论不依赖 LLM 遵守格式。 */
export function sourceWarehouseBadgeHtml(status: string | null): string {
  if (!status) return '';
  const esc = status.replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c;
  });
  if (status.includes('缺货')) {
    return '<div style="display:inline-block;font-size:10px;color:#dc2626;font-weight:600;' +
      'padding:1px 0;">⚠ ' + esc + '</div>';
  }
  return '<div style="display:inline-block;font-size:10px;color:#64748b;padding:1px 0;">' + esc + '</div>';
}

/** 确定性结论句（评审 #2，2026-09-21）：所选调出仓缺货且需调拨时，由前端补充
 *  「结论：建议调拨，所选调出仓X缺货，建议从Y调出约Z件」——不依赖 LLM 复述
 *  （提示词同时禁 AI 输出结论行）。Y = 可动用最大的国内仓（跳过不可借组）；
 *  Z = 公式调拨量。其余情形返回 null 不加。 */
export function shortageConclusionLine(
  sourceWarehouse: string | undefined,
  warehouses: Array<{ name: string; available?: number; inTransit?: number; reserved?: number }> | undefined,
  nonLendableGroups: ReadonlySet<DomesticSiteGroup> | undefined,
  qty: number,
): string | null {
  const status = sourceWarehouseStatus(sourceWarehouse, warehouses);
  if (!status || !status.includes('缺货') || !(qty > 0)) return null;
  const n = (sourceWarehouse || '').trim();
  const fallback = pickFallbackSourceWarehouse(warehouses, nonLendableGroups ?? new Set<DomesticSiteGroup>());
  return '结论：建议调拨，所选调出仓' + n + '缺货，' +
    (fallback ? '建议从' + fallback.name + '调出约' + qty + '件' : '国内暂无有货仓可调');
}

export function buildTransferPrompt(
  s: AsinSummary,
  nonLendableGroups?: Set<DomesticSiteGroup>,
  sourceWarehouse?: string,
): string {
  const shippingDays = s.shippingDays ?? 25;
  const bufferDays = s.bufferDays ?? 15;
  // 国内不可借（2026-09-08 借用排除）：勾选组的仓行标 [不可借]，合计行切换可借口径
  const nlGroups = nonLendableGroups ?? new Set<DomesticSiteGroup>();
  const nonLend = domesticNonLendable(s.domesticWarehouses, nlGroups);
  // 调出仓状态（feature/suggestion-update）：缺货时强制"先提示缺货、再荐替代仓"
  const srcStatus = sourceWarehouseStatus(sourceWarehouse, s.domesticWarehouses);
  const srcShort = !!srcStatus && srcStatus.includes('缺货');
  const domesticList = s.domesticWarehouses
    .map(function (w) {
      const g = parseDomesticSiteGroup(w.name);
      return '  ' + w.name + ': 可用' + w.available + ' 预占' + (w.reserved || 0) + ' 在途' + w.inTransit +
        ((w.purchaseQty || 0) > 0 ? ' 计采' + w.purchaseQty : '') +
        (g && nlGroups.has(g) ? ' [不可借]' : '');
    })
    .join('\n');

  const invAge = s.invAgeList
    .filter(function (a) { return a.value > 0; })
    .map(function (a) { return a.label + ': ' + a.value; })
    .join(', ') || '无数据';

  // 发运管线分量（无库存行时兜底全 0——快照兜底口径没有管线明细）
  const pipe = s.fbaPipeline || { shipped: 0, receiving: 0, waitShipped: 0, working: 0 };

  // 趋势：缺行周期（≠0）跳过——用首个可用短周期 vs 首个可用长周期
  const dailyBy: Record<string, number> = {
    '7d': s.avgDaily7d, '14d': s.avgDaily14d, '30d': s.avgDaily30d,
    '60d': s.avgDaily60d, '90d': s.avgDaily90d,
  };
  const hasP = function (p: string) { return !s.missingPeriods.includes(p); };
  const shortP = ['7d', '14d', '30d'].find(hasP);
  const longP = ['90d', '60d', '30d'].find(hasP);
  let trend = '数据不足';
  if (shortP && longP && shortP !== longP) {
    const sv = dailyBy[shortP]!, lv = dailyBy[longP]!;
    if (sv > lv * 1.15) trend = '上升';
    else if (sv < lv * 0.85) trend = '下降';
    else trend = '平稳';
  }
  // 周期值渲染：缺行 → "X=数据缺失"
  const pd = function (p: string) {
    return hasP(p) ? p + ':' + dailyBy[p]!.toFixed(1) : p + '=数据缺失';
  };
  const sessBy: Record<string, number | null> = {
    '7d': s.sessions7d, '14d': s.sessions14d, '30d': s.sessions30d,
    '60d': s.sessions60d, '90d': s.sessions90d,
  };
  const ps = function (p: string) {
    return hasP(p) && sessBy[p] != null ? p + '=' + sessBy[p]! : p + '=数据缺失';
  };
  // 流量比率窗口渲染：null（接口未回传）→ "缺失"，不得伪 0 或 toFixed 崩溃
  const fp = function (v: number | null) {
    return v == null ? '缺失' : v.toFixed(1) + '%';
  };

  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  let timeNote = '';
  if (month === 7 && day <= 20) timeNote = 'Prime Day刚过，售后流量可能偏高，未来一个月需量或有回落';
  else if (month >= 9 && month <= 11) timeNote = 'Q4旺季临近，需量预计上升，建议提前备货';
  else if (month === 12) timeNote = '圣诞季，需量高峰';
  else if (month >= 10 && month <= 12) timeNote = '黑五/圣诞季，需量高峰';

  // Operator prediction section
  let operatorSection = '';
  if ((s.operatorQty != null && s.operatorQty > 0) || s.operatorNote) {
    operatorSection = '\n【运营预测】';
    if (s.operatorQty != null && s.operatorQty > 0) operatorSection += '\n预测调拨量: ' + s.operatorQty;
    if (s.operatorNote) operatorSection += '\n备注: ' + s.operatorNote;
    operatorSection += '\n';
  }

  return '你是跨境ERP调拨分析助手。根据以下ASIN数据给出调拨建议。\n' +
    '\n【基础信息】' +
    '\nASIN: ' + s.asin + ' | SKU: ' + s.sku + ' | 产品名: ' + s.productName +
    '\n站点: ' + s.marketName +
      (s.marketScope === 'top-market' && s.marketName ? '（口径：该ASIN当前销量最高的市场，非页面目标市场，解读数据时请注意）' : '') +
      ' | 售价: ' + fmtCurrency(s.sellingPrice, s.currency) + ' | 单箱数量: ' + s.singleQuantity +
      ' | 头程需' + (s.shippingDays ?? 25) + '天 | 卖到' + (s.sellUntilDate || '未设置') + ' | 冗余' + (s.bufferDays ?? 15) + '天' +
      (s.bsrByMarket[0] ? '\n品类: ' + s.bsrByMarket[0].mainCategory + ' > ' + s.bsrByMarket[0].subCategory : '') +
    operatorSection +
    '\n═══════════════════════════════════' +
    '\n【国内仓库存】' +
    (srcStatus ? '\n' + srcStatus : '') +
    (domesticList ? '\n' + domesticList : '\n无国内仓库存') +
    '\n国内仓合计: 可用' + s.domesticAvailable +
    (nonLend > 0 ? '（可借 ' + (s.domesticAvailable - nonLend) + ' / 不可借 ' + nonLend + '）' : '') +
    ' 预占' + s.domesticReserved +
    ' 可动用' + (nonLend > 0
      ? (s.domesticAvailable - nonLend - s.domesticReserved) + '(=可借−预占)'
      : (s.domesticAvailable - s.domesticReserved) + '(=可用−预占)') +
    ' | 在途' + s.domesticInTransit + '(内部调拨入)' +
    ' 计采交合计(计划量+采购量+交货量,未来的货): ' + s.purchaseInTransit + '\n' +
    '\n【FBA仓库存】' +
    '\n可用: ' + s.fbaAvailable + ' | 在途(含已发货+待入库+待出运+待出库): ' + s.fbaInTransit + ' | 预留: ' + s.fbaReserved +
    '\n发运管线: 已发货' + pipe.shipped + ' 待入库' + pipe.receiving + ' 待出库' + pipe.working + '(已计入) 待出运' + (s.transferWaitShippedTotal || 0) + '(全仓参考)' +
    '\n库龄分布: ' + invAge + '\n' +
    '\n═══════════════════════════════════' +
    '\n【销量（日均）】' +
    '\n' + pd('7d') + ' ' + pd('14d') + ' ' + pd('30d') + ' ' + pd('60d') + ' ' + pd('90d') +
    ' | 趋势:' + trend +
    '\n' +
    '\n【流量】' +
    '\nSessions: ' + ps('7d') + ' ' + ps('14d') + ' ' + ps('30d') + ' ' + ps('60d') + ' ' + ps('90d') +
    (s.missingPeriods.length > 0
      ? '\n（' + s.missingPeriods.join('/') + ' 周期无报表行，标"数据缺失"，不代表真实为0）'
      : '') +
    '\nCVR: 7d=' + fp(s.cvr7d) + ' 14d=' + fp(s.cvr14d) + ' 30d=' + fp(s.cvr30d) + ' 60d=' + fp(s.cvr60d) + ' 90d=' + fp(s.cvr90d) +
    '\nBuyBox: 7d=' + fp(s.buyBox7d) + ' 14d=' + fp(s.buyBox14d) + ' 30d=' + fp(s.buyBox30d) + ' 60d=' + fp(s.buyBox60d) + ' 90d=' + fp(s.buyBox90d) +
    '\n数据说明："缺失"=该窗口接口未回传或无报表行，不代表真实为0，请结合其他窗口与销量/广告数据判断。' +
    (s.bsrByMarket.length > 0
      ? '\nBSR: ' + s.bsrByMarket.map(function (b) { return b.market + ' #' + b.mainRank; }).join(' / ')
      : '\nBSR: 无数据') +
    '\n' +
    '\n【广告】' +
    '\n花费: 7d=' + fmtCurrency(s.adsSpend7d, 'USD') + ' 14d=' + fmtCurrency(s.adsSpend14d, 'USD') + ' 30d=' + fmtCurrency(s.adsSpend30d, 'USD') + ' 60d=' + fmtCurrency(s.adsSpend60d, 'USD') + ' 90d=' + fmtCurrency(s.adsSpend90d, 'USD') +
    '\nACOS: 7d=' + s.acos7d.toFixed(1) + '% 14d=' + s.acos14d.toFixed(1) + '% 30d=' + s.acos30d.toFixed(1) + '% 60d=' + s.acos60d.toFixed(1) + '% 90d=' + s.acos90d.toFixed(1) + '%' +
    '\nROAS: 7d=' + s.roas7d.toFixed(1) + ' 14d=' + s.roas14d.toFixed(1) + ' 30d=' + s.roas30d.toFixed(1) + ' 60d=' + s.roas60d.toFixed(1) + ' 90d=' + s.roas90d.toFixed(1) +
    '\n广告订单: 7d=' + s.adsOrders7d + ' 14d=' + s.adsOrders14d + ' 30d=' + s.adsOrders30d + ' 60d=' + s.adsOrders60d + ' 90d=' + s.adsOrders90d +
    '\n自然订单: 7d=' + s.naturalOrders7d + ' 14d=' + s.naturalOrders14d + ' 30d=' + s.naturalOrders30d + ' 60d=' + s.naturalOrders60d + ' 90d=' + s.naturalOrders90d + '\n' +
    '\n【质量】' +
    '\n星级:' + s.star + ' | 评论:' + s.reviewQuantity +
    ' | 退货率(30d):' + s.returnsRate.toFixed(1) + '%' +
    ' | 退款率(30d):' + s.refundsRate.toFixed(1) + '%' +
    '\n' +
    '\n【时间】' + now.getFullYear() + '/' + month + '/' + day + (timeNote ? ' ' + timeNote : '') + '\n' +
    '\n═══════════════════════════════════' +
    '\n你是ERP调拨分析助手。根据以上数据给出调拨建议，回复需包含推理过程。' +
    ((s.operatorQty != null && s.operatorQty > 0) ? '\n运营提供了预测调拨量' + s.operatorQty + (s.operatorNote ? '，备注：' + s.operatorNote : '') + '。请与你的建议对比，偏差>20%时指出。' : '') +
    '\n' +
    '\n推理格式（每条80字左右）：' +
    '\n1. 判断：引用关键数据（7d/14d/30d日均变化、Sessions走势、CVR、BSR、时间节点），说明趋势' +
    '\n2. 预测：给出 predictedDailySales（预测日均，可带小数）并说明理由（季节/趋势/listing阶段）。' +
    '\n   最终调拨量按以下公式自动计算（你无需算出具体数字）：' +
    '\n   覆盖天数 = (卖到日期' + (s.sellUntilDate || '未设置') + ' − 今天) 按自然日天数差 + 冗余天数' + bufferDays +
    '\n   R = max(0, FBA可用 + FBA在途 − 预测日均 × 头程天数' + shippingDays + ')（到货时剩余库存）' +
    '\n   D = 预测日均 × max(0, 覆盖天数 − 头程天数)（到货后需求）' +
    '\n   调拨量 = max(0, ceil((D − R) ÷ 单箱数量' + s.singleQuantity + ') × 单箱数量)（按箱规发货）' +
    '\n3. 调拨来源：若建议调拨，指明从哪个仓调出；若不建议调拨，说明原因（如国内仓/FBA库存充足）' +
    (srcShort
      ? '\n   ⚠ 所选调出仓缺货：结论中必须先提示缺货，再指明可调出的有货仓库，顺序固定（先缺货，后替代来源）。' +
        '\n   结论行不要输出——系统将自动补充确定性结论句，你只写判断与预测。'
      : '') +
    '\n4. （风险等级和调拨量由前端自动计算。）' +
    '\n' +
    '\nsuggestedQty 字段统一填 0（具体数量无需你计算）。' +
    '\npredictedDailySales必须填真实数字（禁止保留占位符0）。' +
    '\n' +
    '\nsuggestion文本格式要求（务必遵守）。\n不要在suggestion里提及前端、公式、计算过程等实现细节，直接给结论；不要写具体调拨数字：' +
    // 缺货态结论句由系统补充（见上"结论行不要输出"）——格式行同步去掉结论槽，避免两条指令打架
    (srcShort
      ? '\n判断+预测日均+调拨来源（结论行系统补充，你不要写）'
      : '\n判断+预测日均+结论（是否建议调拨）+调拨来源') +
    '\n' +
    '\n返回纯JSON（suggestion内用\\n换行，不要markdown代码块）：' +
    '[{"sku":"' + s.sku + '","suggestion":"...","suggestedQty":0,"predictedDailySales":9.9}]';
}
