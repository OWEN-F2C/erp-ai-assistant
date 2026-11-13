// shared/jijia-data.ts
// Fetches inventory + multi-period sales data from 积加 APIs and builds AI-ready summaries.

import { getAuthToken } from './auth';
import { fetchDomesticWarehouseIds, isDomesticWarehouse } from './api-client';
import { fetchAsinViewRows, fetchInventoryRows, localDaysAgo } from './jijia-api';
import { ErpApiError } from './erp-errors';
import { parseFbaWarehouse, isRegionOfCountry } from './fba-warehouse';
import { rowFutureInTransit } from './inventory-pipeline';
import { domesticNonLendable, parseDomesticSiteGroup, type DomesticSiteGroup } from './domestic-pool';
import type { MarketGroup } from './types';
import type { PlatformMarket, MultiChannelRow } from './api-client';
import { fetchMultiChannelSales, platformMarketWarehouses } from './api-client';

// --- Raw API row types ---

interface InvRow {
  sku: string; warehouseId: number; warehouseName: string; warehouseType: string;
  availableQty: number; onHandQty: number; inTransitQty: number;
  erpWorking: number; erpWaitShipped: number; erpShipped: number; erpReceiving: number;
  reservedQuantity: number; productDeliveryDays: number; singleQuantity: number;
  /** 计采交合计（ERP"计采交合计量"列，i18n 实锤 = PL/PO/LN Qty）：
   *  计划量 planQuantity + 采购量 orderQuantity + 交货量 lotNoQuantity；
   *  purchasePlanQuantity 是"采购计划量"旧口径，不再计入 */
  plPoLnQty: number;
  listingState: string[] | null; productName: string;
}

export interface SalesRow {
  sku: string; marketName: string; unitsOrdered: number;
  /** 流量四字段：接口未回传时为 null（如 UK 2026-08 起 Sessions 停止同步、
   *  新 listing 未产生数据）。渲染层须显示"缺失"，不得当 0 参与比率。 */
  sessions: number | null; pageViews: number | null;
  cvr: number | null; buyBoxPercentage: number | null;
  star: number; reviewQuantity: number;
  returnsRate: number; refundsRate: number;
  sellersRank: Array<{ rank: number; title: string }> | null;
  fbaQuantity: number; inboundQuantity: number;
  reservedCustomerOrders: number; reservedTransfers: number; reservedProcessing: number;
  invAgeList: Array<{ label: string; value: number }>;
  adsSpend: number; acos: number; roas: number; adsOrders: number; naturalOrders: number;
  adsImpressions: number; cpc: number; ctr: number; orders: number;
  /** 广告点击数与广告销售额（接口已返回，用于跨市场重算 cpc/ctr/acos/roas）。
   * adsSales 才是 acos/roas 的分母（行级 acos=|spend|/adsSales 逐位验证）；adsItemSales 是另一口径 */
  adsClicks: number; adsItemSales: number; adsSales: number;
}

// --- Site data (same period fields as SkuSummary, for a single marketplace) ---

export interface SiteData {
  site: string;
  avgDaily7d: number; avgDaily14d: number; avgDaily30d: number; avgDaily60d: number; avgDaily90d: number;
  sessions7d: number | null; sessions14d: number | null; sessions30d: number | null; sessions60d: number | null; sessions90d: number | null;
  pageViews7d: number | null; pageViews14d: number | null; pageViews30d: number | null; pageViews60d: number | null; pageViews90d: number | null;
  cvr7d: number | null; cvr14d: number | null; cvr30d: number | null; cvr60d: number | null; cvr90d: number | null;
  buyBox7d: number | null; buyBox14d: number | null; buyBox30d: number | null; buyBox60d: number | null; buyBox90d: number | null;
  adsSpend7d: number; adsSpend14d: number; adsSpend30d: number; adsSpend60d: number; adsSpend90d: number;
  acos7d: number; acos14d: number; acos30d: number; acos60d: number; acos90d: number;
  roas7d: number; roas14d: number; roas30d: number; roas60d: number; roas90d: number;
  adsOrders7d: number; adsOrders14d: number; adsOrders30d: number; adsOrders60d: number; adsOrders90d: number;
  naturalOrders7d: number; naturalOrders14d: number; naturalOrders30d: number; naturalOrders60d: number; naturalOrders90d: number;
  adsImpressions7d: number; adsImpressions14d: number; adsImpressions30d: number; adsImpressions60d: number; adsImpressions90d: number;
  cpc7d: number; cpc14d: number; cpc30d: number; cpc60d: number; cpc90d: number;
  ctr7d: number; ctr14d: number; ctr30d: number; ctr60d: number; ctr90d: number;
  star: number; reviewQuantity: number; returnsRate: number; refundsRate: number;
  bestBsrTitle: string | null; bestBsrRank: number | null;
  /** 跨市场口径（全站点汇总/组）逐市场 BSR——各站独立序数不可取最小值；单站点块不设 */
  bsrByMarket?: Array<{ market: string; mainRank: number; title: string }>;
  fbaAvailable: number; fbaInTransit: number; fbaReserved: number;
  invAgeList: Array<{ label: string; value: number }>;
  /** 非亚马逊平台站点：无流量/广告/质量数据，提示词相应块显示"无数据" */
  multichannelOnly?: boolean;
}

// --- Per-SKU summary ---

export interface SkuSummary {
  sku: string; productName: string; singleQuantity: number;
  productionDays: number; shippingDays: number; sellUntilDate: string; bufferDays: number;
  operatorQty?: number; operatorNote?: string;
  domesticAvailable: number; domesticInTransit: number; domesticReserved: number;
  /** 计采交合计（国内仓 计划量+采购量 求和，未来的货）——并入公式在途项防重复采购 */
  purchaseInTransit: number;
  domesticWarehouses: Array<{ name: string; available: number; inTransit: number; purchaseQty?: number; reserved?: number }>;
  fbaAvailable: number; fbaInTransit: number; fbaReserved: number;
  /** Overseas self-operated warehouses (e.g. US-Tiktok-FBT虚拟仓, type SELF,
   *  non-domestic) — counted into 全渠道 totals only. THIRD（中转三方仓：鸿宸/云途）
   *  2026-09-08 起同入 other 桶（旧 else-if 链落不进任何桶，对公式完全不可见）。 */
  otherAvailable: number; otherInTransit: number;
  invAgeList: Array<{ label: string; value: number }>;
  totalAvailable: number; totalInTransit: number; totalReserved: number;
  /** 全仓 Σ 调拨待出运（已出库未发运，货在中转）。已计入各桶在途（未来口径），
   *  此字段仅作结论块/提示词的参考行展示 */
  transferWaitShippedTotal: number;
  avgDaily7d: number; avgDaily14d: number; avgDaily30d: number; avgDaily60d: number; avgDaily90d: number;
  sessions7d: number | null; sessions14d: number | null; sessions30d: number | null; sessions60d: number | null; sessions90d: number | null;
  pageViews7d: number | null; pageViews14d: number | null; pageViews30d: number | null; pageViews60d: number | null; pageViews90d: number | null;
  cvr7d: number | null; cvr14d: number | null; cvr30d: number | null; cvr60d: number | null; cvr90d: number | null;
  buyBox7d: number | null; buyBox14d: number | null; buyBox30d: number | null; buyBox60d: number | null; buyBox90d: number | null;
  adsSpend7d: number; adsSpend14d: number; adsSpend30d: number; adsSpend60d: number; adsSpend90d: number;
  acos7d: number; acos14d: number; acos30d: number; acos60d: number; acos90d: number;
  roas7d: number; roas14d: number; roas30d: number; roas60d: number; roas90d: number;
  adsOrders7d: number; adsOrders14d: number; adsOrders30d: number; adsOrders60d: number; adsOrders90d: number;
  naturalOrders7d: number; naturalOrders14d: number; naturalOrders30d: number; naturalOrders60d: number; naturalOrders90d: number;
  adsImpressions7d: number; adsImpressions14d: number; adsImpressions30d: number; adsImpressions60d: number; adsImpressions90d: number;
  cpc7d: number; cpc14d: number; cpc30d: number; cpc60d: number; cpc90d: number;
  ctr7d: number; ctr14d: number; ctr30d: number; ctr60d: number; ctr90d: number;
  star: number; reviewQuantity: number; returnsRate: number; refundsRate: number;
  bestBsrTitle: string | null; bestBsrRank: number | null;
  /** 跨市场口径（全站点汇总/组）逐市场 BSR——各站独立序数不可取最小值 */
  bsrByMarket?: Array<{ market: string; mainRank: number; title: string }>;
  listingStates: string[];
  siteDatas?: SiteData[];
  /** 每个仓库的可用/在途/采购计划明细（含平台仓与虚拟仓），供多渠道站点行取数。
   *  2026-09-08 起携带调拨发运管线分量：inTransit 保持货件口径原值，管线字段为
   *  已发货/待入库/待出运/待出库（aggregation 桶与 attributedFba 走 rowFutureInTransit） */
  warehouseDetail?: Array<{
    name: string; available: number; inTransit: number; purchasePlanQty?: number;
    shipped?: number; receiving?: number; waitShipped?: number; working?: number;
  }>;
  missingGroupMarkets?: string[];
}

// --- Helpers ---

export interface PeriodFields {
  avgDaily7d: number; avgDaily14d: number; avgDaily30d: number; avgDaily60d: number; avgDaily90d: number;
  sessions7d: number | null; sessions14d: number | null; sessions30d: number | null; sessions60d: number | null; sessions90d: number | null;
  pageViews7d: number | null; pageViews14d: number | null; pageViews30d: number | null; pageViews60d: number | null; pageViews90d: number | null;
  cvr7d: number | null; cvr14d: number | null; cvr30d: number | null; cvr60d: number | null; cvr90d: number | null;
  buyBox7d: number | null; buyBox14d: number | null; buyBox30d: number | null; buyBox60d: number | null; buyBox90d: number | null;
  adsSpend7d: number; adsSpend14d: number; adsSpend30d: number; adsSpend60d: number; adsSpend90d: number;
  acos7d: number; acos14d: number; acos30d: number; acos60d: number; acos90d: number;
  roas7d: number; roas14d: number; roas30d: number; roas60d: number; roas90d: number;
  adsOrders7d: number; adsOrders14d: number; adsOrders30d: number; adsOrders60d: number; adsOrders90d: number;
  naturalOrders7d: number; naturalOrders14d: number; naturalOrders30d: number; naturalOrders60d: number; naturalOrders90d: number;
  adsImpressions7d: number; adsImpressions14d: number; adsImpressions30d: number; adsImpressions60d: number; adsImpressions90d: number;
  cpc7d: number; cpc14d: number; cpc30d: number; cpc60d: number; cpc90d: number;
  ctr7d: number; ctr14d: number; ctr30d: number; ctr60d: number; ctr90d: number;
  fbaAvailable: number; fbaInTransit: number; fbaReserved: number;
  star: number; reviewQuantity: number; returnsRate: number; refundsRate: number;
  bestBsrTitle: string | null; bestBsrRank: number | null;
  /** 跨市场口径（全站点汇总/组）逐市场 BSR——各站独立序数不可取最小值 */
  bsrByMarket?: Array<{ market: string; mainRank: number; title: string }>;
  invAgeList: Array<{ label: string; value: number }>;
}

function daysAgo(n: number): string { return localDaysAgo(n); }

/** 同 SKU×市场的多 listing 行合并为一行（asinView 行 = ASIN×市场，同 SKU 同市场
 *  可能有多个 ASIN，实测 498 组中 27 组；旧 first-wins 去重会静默丢掉次要行销量）。
 *  规则（2026-08-28 与用户确认）：量的字段求和（多 listing 各自独立 FBA 库存与库龄，
 *  也求和）；比率按求和分量重算或按销量加权；星级/评论/BSR/BuyBox 是 listing 身份
 *  属性，取销量最高行（主力 listing）代表——与旧行为呈现语义一致。 */
export function mergeMarketRows(rows: SalesRow[]): SalesRow {
  if (rows.length === 1) return rows[0]!;
  const dominant = rows.reduce(function (a, b) {
    return (b.unitsOrdered || 0) > (a.unitsOrdered || 0) ? b : a;
  });
  const merged: SalesRow = { ...dominant };
  const sum = function (pick: (r: SalesRow) => number | null): number {
    return rows.reduce(function (acc, r) { return acc + (pick(r) || 0); }, 0);
  };
  merged.unitsOrdered = sum(r => r.unitsOrdered);
  // 全部行都未回传时保持 null（渲染"缺失"），任一行有值则求和
  merged.sessions = rows.every(r => r.sessions == null) ? null : sum(r => r.sessions);
  merged.pageViews = rows.every(r => r.pageViews == null) ? null : sum(r => r.pageViews);
  merged.orders = sum(r => r.orders);
  merged.adsSpend = sum(r => r.adsSpend);
  merged.adsOrders = sum(r => r.adsOrders);
  merged.naturalOrders = sum(r => r.naturalOrders);
  merged.adsImpressions = sum(r => r.adsImpressions);
  merged.adsClicks = sum(r => r.adsClicks);
  merged.adsItemSales = sum(r => r.adsItemSales);
  merged.adsSales = sum(r => r.adsSales);
  // 多 listing = 多份独立库存（实测 PC715SX UK 58+13），求和而非取 max
  merged.fbaQuantity = sum(r => r.fbaQuantity);
  merged.inboundQuantity = sum(r => r.inboundQuantity);
  merged.reservedCustomerOrders = sum(r => r.reservedCustomerOrders);
  merged.reservedTransfers = sum(r => r.reservedTransfers);
  merged.reservedProcessing = sum(r => r.reservedProcessing);
  // 库龄按档位求和（主力行单独的库龄会丢次要 listing 的老库存）
  const ageByLabel = new Map<string, number>();
  for (const r of rows) {
    for (const a of r.invAgeList || []) {
      ageByLabel.set(a.label, (ageByLabel.get(a.label) || 0) + (a.value || 0));
    }
  }
  merged.invAgeList = Array.from(ageByLabel, function ([label, value]) { return { label, value }; });
  // 比率：分量重算（cvr=订单/sessions，acos=|花费|/adsSales）；退货退款率按销量加权
  const sessions = merged.sessions || 0;
  const spendAbs = Math.abs(merged.adsSpend);
  if (sessions > 0) merged.cvr = merged.orders / sessions * 100;
  if (merged.adsImpressions > 0) merged.ctr = merged.adsClicks / merged.adsImpressions * 100;
  if (merged.adsClicks > 0) merged.cpc = spendAbs / merged.adsClicks;
  if (merged.adsSales > 0) merged.acos = spendAbs / merged.adsSales * 100;
  if (spendAbs > 0) merged.roas = merged.adsSales / spendAbs;
  if (merged.unitsOrdered > 0) {
    merged.returnsRate = sum(r => (r.returnsRate || 0) * (r.unitsOrdered || 0)) / merged.unitsOrdered;
    merged.refundsRate = sum(r => (r.refundsRate || 0) * (r.unitsOrdered || 0)) / merged.unitsOrdered;
  }
  return merged;
}

/** Fetch one sales period. Returns per-market data: Map<sku, Map<marketName, SalesRow>>.
 *  行 = ASIN×市场（asinView）；同 SKU×市场的多行（多 listing）合并为一行。 */
async function fetchSalesPeriod(
  skus: string[], beginDays: number, token: string, signal?: AbortSignal,
): Promise<Map<string, Map<string, SalesRow>>> {
  const rows = await fetchAsinViewRows<SalesRow>({ skuList: skus, beginDays, token, signal });

  const grouped = new Map<string, Map<string, SalesRow[]>>();
  for (const row of rows) {
    const market = row.marketName || '_unknown';
    let skuMap = grouped.get(row.sku);
    if (!skuMap) { skuMap = new Map(); grouped.set(row.sku, skuMap); }
    let arr = skuMap.get(market);
    if (!arr) { arr = []; skuMap.set(market, arr); }
    arr.push(row);
  }
  const map = new Map<string, Map<string, SalesRow>>();
  for (const [sku, skuMap] of grouped) {
    const merged = new Map<string, SalesRow>();
    for (const [market, arr] of skuMap) merged.set(market, mergeMarketRows(arr));
    map.set(sku, merged);
  }
  return map;
}

/** Aggregate all markets into a single SalesRow (summing additive fields,
 *  recomputing ratio fields from summed components) */
export function aggregateRow(markets: Map<string, SalesRow> | undefined): SalesRow | null {
  if (!markets || markets.size === 0) return null;
  let merged: SalesRow | null = null;
  // sessions/pageViews 属性类型含 null（未回传），用局部变量累加避免 null 算术；
  // 全部市场均未回传时保持 null（缺失≠0，与 mergeMarketRows 同款语义）
  let sessionsSum = 0, pageViewsSum = 0;
  let sessionsAllNull = true, pageViewsAllNull = true;
  for (const row of markets.values()) {
    if (!merged) {
      merged = {
        ...row,
        unitsOrdered: row.unitsOrdered || 0,
        sessions: row.sessions || 0,
        pageViews: row.pageViews || 0,
        adsSpend: row.adsSpend || 0,
        adsOrders: row.adsOrders || 0,
        naturalOrders: row.naturalOrders || 0,
        adsImpressions: row.adsImpressions || 0,
        adsClicks: row.adsClicks || 0,
        adsItemSales: row.adsItemSales || 0,
        adsSales: row.adsSales || 0,
        fbaQuantity: row.fbaQuantity || 0,
        inboundQuantity: row.inboundQuantity || 0,
        reservedCustomerOrders: row.reservedCustomerOrders || 0,
        reservedTransfers: row.reservedTransfers || 0,
        reservedProcessing: row.reservedProcessing || 0,
        orders: row.orders || 0,
        reviewQuantity: row.reviewQuantity || 0,
      };
      sessionsSum = row.sessions || 0;
      pageViewsSum = row.pageViews || 0;
      if (row.sessions != null) sessionsAllNull = false;
      if (row.pageViews != null) pageViewsAllNull = false;
      continue;
    }
    merged.unitsOrdered += row.unitsOrdered || 0;
    sessionsSum += row.sessions || 0;
    pageViewsSum += row.pageViews || 0;
    if (row.sessions != null) sessionsAllNull = false;
    if (row.pageViews != null) pageViewsAllNull = false;
    merged.adsSpend += row.adsSpend || 0;
    merged.adsOrders += row.adsOrders || 0;
    merged.naturalOrders += row.naturalOrders || 0;
    merged.adsImpressions += row.adsImpressions || 0;
    merged.adsClicks += row.adsClicks || 0;
    merged.adsItemSales += row.adsItemSales || 0;
    merged.adsSales += row.adsSales || 0;
    merged.fbaQuantity += row.fbaQuantity || 0;
    merged.inboundQuantity += row.inboundQuantity || 0;
    merged.reservedCustomerOrders += row.reservedCustomerOrders || 0;
    merged.reservedTransfers += row.reservedTransfers || 0;
    merged.reservedProcessing += row.reservedProcessing || 0;
    merged.orders += row.orders || 0;
    merged.reviewQuantity += row.reviewQuantity || 0;
  }
  if (!merged) return null;
  merged.sessions = sessionsAllNull ? null : sessionsSum;
  merged.pageViews = pageViewsAllNull ? null : pageViewsSum;
  // Recompute derived fields from summed components (ratio fields are not additive)
  // 广告花费 adsSpend 接口为负（CNY 记账支出为负），比率一律取绝对值；
  // 广告销售额用 adsSales（与 ERP 行级 acos/roas 口径逐位吻合）
  const spendAbs = Math.abs(merged.adsSpend);
  if (sessionsSum > 0) merged.cvr = merged.orders / sessionsSum * 100;
  if (merged.adsImpressions > 0) merged.ctr = merged.adsClicks / merged.adsImpressions * 100;
  if (merged.adsClicks > 0) merged.cpc = spendAbs / merged.adsClicks;
  if (merged.adsSales > 0) merged.acos = spendAbs / merged.adsSales * 100;
  if (spendAbs > 0) merged.roas = merged.adsSales / spendAbs;
  return merged;
}

/** Aggregate non-additive fields from all markets (star, BSR, etc.).
 *  reviewQuantity 已由 aggregateRow 求和后经 fillPeriodFields 写入 target，此处不再累加。 */
export function aggregateMarkets(markets: Map<string, SalesRow> | undefined, target: PeriodFields): void {
  if (!markets || markets.size === 0) return;
  // 退货/退款率按销量加权平均（≈ 退货量/销量 的渠道口径）。Math.max 会让 NL 这类
  // 4 单 25% 的小样本噪声直接顶掉全渠道值（2026-08-28 用户实测报 bug）
  let retW = 0, refW = 0, wTotal = 0;
  // BSR 各站独立序数、站点体量差异巨大（AE #150 ≪ DE #8000 含金量），不可跨市场
  // 取最小值——逐市场列出该站行内最优排名（2026-08-28 口径对齐，调拨侧同款）
  const bsrList: Array<{ market: string; mainRank: number; title: string }> = [];
  for (const [marketName, row] of markets.entries()) {
    if (row.star) target.star = Math.max(target.star, row.star);
    const u = row.unitsOrdered || 0;
    retW += (row.returnsRate || 0) * u;
    refW += (row.refundsRate || 0) * u;
    wTotal += u;
    if (row.sellersRank) {
      for (const r of row.sellersRank) {
        if (!target.bestBsrRank || r.rank < target.bestBsrRank) {
          target.bestBsrRank = r.rank; target.bestBsrTitle = r.title;
        }
      }
      const best = row.sellersRank.reduce((a, b) => (b.rank < a.rank ? b : a));
      const code = marketName.toUpperCase().split(':').pop() || marketName;
      bsrList.push({ market: code, mainRank: best.rank, title: best.title });
    }
  }
  bsrList.sort((a, b) => a.mainRank - b.mainRank);
  if (bsrList.length > 0) target.bsrByMarket = bsrList;
  if (wTotal > 0) {
    target.returnsRate = retW / wTotal;
    target.refundsRate = refW / wTotal;
  }
}

/** 星级/评论是实时快照，但挂在各窗口行上返回。listing 合并变体期间快照会暂时
 *  归零（用户口径：后续会恢复）；60d/90d 窗口行仍带着合并前的值（实测 HC586TX UK
 *  30d=0/0、60d=4.4/260）。30d 行为 0/null 时回退取长窗口同市场行的非零值。
 *  泛型约束只要求 star/reviewQuantity——采购与调拨两套 SalesRow 均可复用。 */
export function backfillQualitySnapshots<T extends { star: number; reviewQuantity: number }>(
  p30: Map<string, Map<string, T>> | undefined,
  p60: Map<string, Map<string, T>> | undefined,
  p90: Map<string, Map<string, T>> | undefined,
): void {
  if (!p30) return;
  for (const [sku, markets] of p30) {
    for (const [market, row] of markets) {
      if (row.star && row.reviewQuantity) continue;
      const f60 = p60?.get(sku)?.get(market);
      const f90 = p90?.get(sku)?.get(market);
      if (!row.star) row.star = (f60 && f60.star) || (f90 && f90.star) || row.star;
      if (!row.reviewQuantity) {
        row.reviewQuantity = (f60 && f60.reviewQuantity) || (f90 && f90.reviewQuantity) || row.reviewQuantity;
      }
    }
  }
}

/** Filter markets map to only those matching the group's market list */
function filterMarketsByGroup(
  markets: Map<string, SalesRow> | undefined,
  group: MarketGroup
): Map<string, SalesRow> | undefined {
  if (!markets || markets.size === 0) return undefined;
  const filtered = new Map<string, SalesRow>();
  const upperMarkets = group.markets.map(function(m) { return m.toUpperCase(); });
  for (const [marketName, row] of markets) {
    const parts = marketName.toUpperCase().split(':');
    const code = parts[parts.length - 1];
    if (upperMarkets.includes(code)) {
      filtered.set(marketName, row);
    }
  }
  return filtered.size > 0 ? filtered : undefined;
}

/** Fill period fields from a SalesRow */
function fillPeriodFields(target: PeriodFields, row: SalesRow, days: number): void {
  const avg = row.unitsOrdered / days;
  const sets: Record<number, () => void> = {
    7: () => {
      target.avgDaily7d = avg; target.sessions7d = row.sessions; target.pageViews7d = row.pageViews;
      target.cvr7d = row.cvr; target.buyBox7d = row.buyBoxPercentage;
      target.adsSpend7d = row.adsSpend; target.acos7d = row.acos; target.roas7d = row.roas;
      target.adsOrders7d = row.adsOrders; target.naturalOrders7d = row.naturalOrders;
      target.adsImpressions7d = row.adsImpressions; target.cpc7d = row.cpc; target.ctr7d = row.ctr;
    },
    14: () => {
      target.avgDaily14d = avg; target.sessions14d = row.sessions; target.pageViews14d = row.pageViews;
      target.cvr14d = row.cvr; target.buyBox14d = row.buyBoxPercentage;
      target.adsSpend14d = row.adsSpend; target.acos14d = row.acos; target.roas14d = row.roas;
      target.adsOrders14d = row.adsOrders; target.naturalOrders14d = row.naturalOrders;
      target.adsImpressions14d = row.adsImpressions; target.cpc14d = row.cpc; target.ctr14d = row.ctr;
    },
    30: () => {
      target.avgDaily30d = avg; target.sessions30d = row.sessions; target.pageViews30d = row.pageViews;
      target.cvr30d = row.cvr; target.buyBox30d = row.buyBoxPercentage;
      target.adsSpend30d = row.adsSpend; target.acos30d = row.acos; target.roas30d = row.roas;
      target.adsOrders30d = row.adsOrders; target.naturalOrders30d = row.naturalOrders;
      target.adsImpressions30d = row.adsImpressions; target.cpc30d = row.cpc; target.ctr30d = row.ctr;
      target.star = row.star || 0; target.reviewQuantity = row.reviewQuantity || 0;
      target.returnsRate = row.returnsRate || 0; target.refundsRate = row.refundsRate || 0;
      // 注意：FBA 库存不从销售快照取——欧盟 EFN 共享池会被复制到每个欧洲站点
      // 的 fbaQuantity 上，跨市场求和会把同一批货计 N 次。全局行用库存接口求和
      // （invRows 循环），站点行用 attributedFba() 按店铺+国家归属。
      if (row.sellersRank) {
        for (const r of row.sellersRank) {
          if (!target.bestBsrRank || r.rank < target.bestBsrRank) {
            target.bestBsrRank = r.rank; target.bestBsrTitle = r.title;
          }
        }
      }
      target.invAgeList = row.invAgeList || [];
    },
    60: () => {
      target.avgDaily60d = avg; target.sessions60d = row.sessions; target.pageViews60d = row.pageViews;
      target.cvr60d = row.cvr; target.buyBox60d = row.buyBoxPercentage;
      target.adsSpend60d = row.adsSpend; target.acos60d = row.acos; target.roas60d = row.roas;
      target.adsOrders60d = row.adsOrders; target.naturalOrders60d = row.naturalOrders;
      target.adsImpressions60d = row.adsImpressions; target.cpc60d = row.cpc; target.ctr60d = row.ctr;
    },
    90: () => {
      target.avgDaily90d = avg; target.sessions90d = row.sessions; target.pageViews90d = row.pageViews;
      target.cvr90d = row.cvr; target.buyBox90d = row.buyBoxPercentage;
      target.adsSpend90d = row.adsSpend; target.acos90d = row.acos; target.roas90d = row.roas;
      target.adsOrders90d = row.adsOrders; target.naturalOrders90d = row.naturalOrders;
      target.adsImpressions90d = row.adsImpressions; target.cpc90d = row.cpc; target.ctr90d = row.ctr;
    },
  };
  sets[days]?.();
}

function emptyPeriodFields(target: PeriodFields): void {
  target.avgDaily7d = 0; target.avgDaily14d = 0; target.avgDaily30d = 0; target.avgDaily60d = 0; target.avgDaily90d = 0;
  // 流量四字段初始为 null：没有该窗口行 ≠ 0（零销量周期行会整体缺失），渲染"缺失"
  target.sessions7d = null; target.sessions14d = null; target.sessions30d = null; target.sessions60d = null; target.sessions90d = null;
  target.pageViews7d = null; target.pageViews14d = null; target.pageViews30d = null; target.pageViews60d = null; target.pageViews90d = null;
  target.cvr7d = null; target.cvr14d = null; target.cvr30d = null; target.cvr60d = null; target.cvr90d = null;
  target.buyBox7d = null; target.buyBox14d = null; target.buyBox30d = null; target.buyBox60d = null; target.buyBox90d = null;
  target.adsSpend7d = 0; target.adsSpend14d = 0; target.adsSpend30d = 0; target.adsSpend60d = 0; target.adsSpend90d = 0;
  target.acos7d = 0; target.acos14d = 0; target.acos30d = 0; target.acos60d = 0; target.acos90d = 0;
  target.roas7d = 0; target.roas14d = 0; target.roas30d = 0; target.roas60d = 0; target.roas90d = 0;
  target.adsOrders7d = 0; target.adsOrders14d = 0; target.adsOrders30d = 0; target.adsOrders60d = 0; target.adsOrders90d = 0;
  target.naturalOrders7d = 0; target.naturalOrders14d = 0; target.naturalOrders30d = 0; target.naturalOrders60d = 0; target.naturalOrders90d = 0;
  target.adsImpressions7d = 0; target.adsImpressions14d = 0; target.adsImpressions30d = 0; target.adsImpressions60d = 0; target.adsImpressions90d = 0;
  target.cpc7d = 0; target.cpc14d = 0; target.cpc30d = 0; target.cpc60d = 0; target.cpc90d = 0;
  target.ctr7d = 0; target.ctr14d = 0; target.ctr30d = 0; target.ctr60d = 0; target.ctr90d = 0;
  target.fbaAvailable = 0; target.fbaInTransit = 0; target.fbaReserved = 0;
  target.star = 0; target.reviewQuantity = 0; target.returnsRate = 0; target.refundsRate = 0;
  target.bestBsrTitle = null; target.bestBsrRank = null;
  target.invAgeList = [];
}

/** 从仓库明细按 店铺+国家 归属 FBA 库存（EU 共享池只计一次）。
 *  store 传 null 表示不限店铺（国家码站点/汇总组）；无匹配仓时回退销售快照单值。
 *  reserved 为 FBA 预留（销售快照的 reservedTransfers 是 EFN 复制值，跨市场求和会重复）。
 *  2026-09-08 管线口径：inTransit = Σ rowFutureInTransit（max(货件在途, 已发货+待入库)
 *  + 待出运，两套账去重）；erpWorking（待出库）单列于 working 不并入 inTransit——
 *  采购总盘视角排除（货仍在源仓可用量里），调拨调入仓视角由调用方加上。 */
export function attributedFba(
  detail: Array<{
    name: string; available: number; inTransit: number; reserved?: number;
    shipped?: number; receiving?: number; waitShipped?: number; working?: number;
  }> | undefined,
  store: string | null,
  country: string | string[],
  fallbackAvail = 0,
  fallbackTransit = 0,
  fallbackReserved = 0,
): {
  available: number; inTransit: number; reserved: number;
  /** 匹配仓 Σ 已发货 / 待入库 / 待出运 / 待出库（调拨侧展示与公式用） */
  shipped: number; receiving: number; waitShipped: number; working: number;
} {
  const countries = Array.isArray(country) ? country : [country];
  // 店铺比较忽略大小写：调用方（如表单站点解析）可能传大写，仓名是原始大小写
  const storeUpper = store ? store.toUpperCase() : null;
  let avail = 0, transit = 0, reserved = 0;
  let shipped = 0, receiving = 0, waitShipped = 0, working = 0;
  for (const w of detail ?? []) {
    const fw = parseFbaWarehouse(w.name);
    if (!fw) continue;
    if (storeUpper && fw.store.toUpperCase() !== storeUpper) continue;
    if (!countries.some(c => isRegionOfCountry(fw.region, c))) continue;
    avail += w.available; // 每个仓最多计一次——EU 共享池不会因组内多国而重复
    transit += rowFutureInTransit({
      inTransitQty: w.inTransit, erpShipped: w.shipped,
      erpReceiving: w.receiving, erpWaitShipped: w.waitShipped,
    });
    reserved += w.reserved || 0;
    shipped += w.shipped || 0;
    receiving += w.receiving || 0;
    waitShipped += w.waitShipped || 0;
    working += w.working || 0;
  }
  if (avail === 0 && transit === 0 && reserved === 0) {
    return {
      available: fallbackAvail, inTransit: fallbackTransit, reserved: fallbackReserved,
      shipped: 0, receiving: 0, waitShipped: 0, working: 0,
    };
  }
  return { available: avail, inTransit: transit, reserved, shipped, receiving, waitShipped, working };
}

function matchSiteMarket(siteCode: string, markets: Map<string, SalesRow> | undefined): string | null {
  if (!markets || markets.size === 0) return null;
  const upper = siteCode.toUpperCase();
  if (markets.has(upper)) return upper;
  for (const m of markets.keys()) {
    const parts = m.toUpperCase().split(':');
    if (parts[parts.length - 1] === upper) return m;
  }
  return null;
}

/** Resolve which market group (if any) a site code belongs to */
export function resolveMarketGroup(
  site: string,
  groups: MarketGroup[]
): MarketGroup | undefined {
  if (!groups || groups.length === 0) return undefined;
  const upper = site.toUpperCase();
  // 组名匹配：仓库区域码（如 EU_FBA → 'EU'）是组名而非组员国家码
  for (const g of groups) {
    if (g.name.toUpperCase() === upper) return g;
  }
  for (const g of groups) {
    if (g.markets.some(function(m) { return m.toUpperCase() === upper; })) {
      return g;
    }
  }
  return undefined;
}

// --- Public API ---

export async function fetchAndSummarize(
  skus: string[], doc?: Document, siteMap?: Map<string, string | string[]>,
  marketGroups?: MarketGroup[],
): Promise<SkuSummary[]> {
  const token = getAuthToken(doc);
  if (!token) throw new Error('未找到 x-auth-token，请刷新页面后重试');

  // allSettled：把并发请求全部跑完，一次性列出所有无法访问的数据集
  // （快速失败 + 完整清单——用户不用修一个再见一个）
  const settled = await Promise.allSettled([
    fetchDomesticWarehouseIds(token),
    fetchSalesPeriod(skus, 7, token), fetchSalesPeriod(skus, 14, token),
    fetchSalesPeriod(skus, 30, token), fetchSalesPeriod(skus, 60, token),
    fetchSalesPeriod(skus, 90, token),
    // 库存行 = SKU×仓库（FBA 各国仓 + 国内仓 + 虚拟仓），fetchInventoryRows 内翻页取满
    fetchInventoryRows<InvRow>(skus, token),
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

  const [domesticIds, p7, p14, p30, p60, p90, invRows] = settled.map(
    s => (s as PromiseFulfilledResult<never>).value,
  ) as unknown as [Set<number>, Map<string, Map<string, SalesRow>>, Map<string, Map<string, SalesRow>>,
      Map<string, Map<string, SalesRow>>, Map<string, Map<string, SalesRow>>,
      Map<string, Map<string, SalesRow>>, InvRow[]];
  // 星级/评论快照回退（变体合并期间 30d 行归零 → 取 60d/90d 同市场行的值）
  backfillQualitySnapshots(p30, p60, p90);
  const summaries = new Map<string, SkuSummary>();

  for (const sku of skus) {
    const today = new Date();
    today.setDate(today.getDate() + 90);
    const defaultSellUntil = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const s: SkuSummary = {
      sku, productName: '', singleQuantity: 1,
      productionDays: 30, shippingDays: 25, sellUntilDate: defaultSellUntil, bufferDays: 15,
      domesticAvailable: 0, domesticInTransit: 0, domesticReserved: 0,
      purchaseInTransit: 0,
      fbaAvailable: 0, fbaInTransit: 0, fbaReserved: 0,
      otherAvailable: 0, otherInTransit: 0, invAgeList: [],
      totalAvailable: 0, totalInTransit: 0, totalReserved: 0,
      transferWaitShippedTotal: 0,
      domesticWarehouses: [], listingStates: [], warehouseDetail: [],
    } as unknown as SkuSummary;
    emptyPeriodFields(s);
    summaries.set(sku, s);
  }

  for (const row of invRows) {
    const s = summaries.get(row.sku || '');
    if (!s) continue;
    if (!s.productName) {
      s.productName = row.productName || '';
      s.singleQuantity = row.singleQuantity || 1;
    }
    // 在途桶一律走未来口径（2026-09-08 结论二）：max(货件在途, 已发货+待入库)+待出运，
    // 两套账同货双记用 max 去重；待出库 erpWorking 不进（货仍在源仓可用量里，总盘双计）
    const futureInTransit = rowFutureInTransit(row);
    s.transferWaitShippedTotal += row.erpWaitShipped || 0;
    if (isDomesticWarehouse(row.warehouseId, domesticIds)) {
      const planPurchase = row.plPoLnQty || 0;
      s.domesticAvailable += row.availableQty || 0;
      s.domesticInTransit += futureInTransit;
      s.domesticReserved += row.reservedQuantity || 0;
      s.purchaseInTransit += planPurchase;
      if (row.availableQty > 0 || row.inTransitQty > 0 || planPurchase > 0) {
        s.domesticWarehouses.push({
          name: row.warehouseName, available: row.availableQty || 0,
          inTransit: row.inTransitQty || 0, purchaseQty: planPurchase,
          reserved: row.reservedQuantity || 0,
        });
      }
    } else if (row.warehouseType === 'FBA' || row.warehouseType === 'WFS' || row.warehouseType === 'TIKTOK_FBT') {
      // TIKTOK_FBT 语义相当于 FBA/WFS（用户口径，FBT 虚拟仓已弃用）
      s.fbaAvailable += row.availableQty || 0;
      s.fbaInTransit += futureInTransit;
      s.fbaReserved += row.reservedQuantity || 0;
    } else if (row.warehouseType === 'SELF' || row.warehouseType === 'THIRD') {
      // THIRD = 中转三方仓（鸿宸/云途），与海外自营仓同入 other 桶（仅全渠道合计）
      s.otherAvailable += row.availableQty || 0;
      s.otherInTransit += futureInTransit;
    }
    s.warehouseDetail!.push({
      name: row.warehouseName || '',
      available: row.availableQty || 0,
      inTransit: row.inTransitQty || 0,
      purchasePlanQty: row.plPoLnQty || 0,
      shipped: row.erpShipped || 0,
      receiving: row.erpReceiving || 0,
      waitShipped: row.erpWaitShipped || 0,
      working: row.erpWorking || 0,
    });
    if (row.listingState) {
      for (const ls of row.listingState) {
        const state = ls.includes(':') ? ls.split(':')[1] : ls;
        if (!s.listingStates.includes(state)) s.listingStates.push(state);
      }
    }
  }

  // Detect multi-site mode: siteMap values are string[] (multi) vs string (single)
  const isMultiSite = siteMap && siteMap.size > 0 &&
    [...siteMap.values()].some(function(v) { return Array.isArray(v); });

  for (const sku of skus) {
    const s = summaries.get(sku)!;
    const markets7 = p7.get(sku), markets14 = p14.get(sku), markets30 = p30.get(sku);
    const markets60 = p60.get(sku), markets90 = p90.get(sku);

    const agg7 = aggregateRow(markets7), agg14 = aggregateRow(markets14);
    const agg30 = aggregateRow(markets30), agg60 = aggregateRow(markets60), agg90 = aggregateRow(markets90);
    if (agg7) fillPeriodFields(s, agg7, 7);
    if (agg14) fillPeriodFields(s, agg14, 14);
    if (agg30) fillPeriodFields(s, agg30, 30);
    if (agg60) fillPeriodFields(s, agg60, 60);
    if (agg90) fillPeriodFields(s, agg90, 90);
    aggregateMarkets(markets30, s);

    if (isMultiSite) {
      // Multi-site path: iterate over the site identifier array
      const siteIdentifiers = siteMap!.get(sku) as string[];
      if (!siteIdentifiers || siteIdentifiers.length === 0) continue;

      const siteDatas: SiteData[] = [];
      for (const siteId of siteIdentifiers) {
        // siteId is a full identifier like "DE:Yaoshu". Market names come back
        // as "Yaoshu:DE" (StoreName:CountryCode), so match by reversing them:
        // Yaoshu:DE ↔ DE:Yaoshu. A bare country-code match is only a fallback.
        const cc = siteId.includes(':') ? siteId.split(':')[0]! : siteId;
        let siteName: string | null = null;
        if (markets30) {
          for (const mn of markets30.keys()) {
            const parts = mn.split(':');
            if (parts.length >= 2) {
              const reversed = parts.slice(1).join(':') + ':' + parts[0]; // Yaoshu:DE → DE:Yaoshu
              if (reversed === siteId) { siteName = mn; break; }
            }
            // Also try exact match and simple country match as fallback
            if (mn === siteId || parts[parts.length - 1] === cc) {
              if (!siteName) siteName = mn;
            }
          }
        }
        if (!siteName) continue; // no sales data for this site

        // Store the full identifier (e.g. "DE:Yaoshu"), not just the country code,
        // so selectedSites.includes(sd.site) and scope lookups match spec identifiers.
        const siteData: SiteData = { site: siteId } as SiteData;
        emptyPeriodFields(siteData);
        const sr7 = markets7?.get(siteName), sr14 = markets14?.get(siteName);
        const sr30 = markets30?.get(siteName), sr60 = markets60?.get(siteName), sr90 = markets90?.get(siteName);
        if (sr7) fillPeriodFields(siteData, sr7, 7);
        if (sr14) fillPeriodFields(siteData, sr14, 14);
        if (sr30) fillPeriodFields(siteData, sr30, 30);
        if (sr60) fillPeriodFields(siteData, sr60, 60);
        if (sr90) fillPeriodFields(siteData, sr90, 90);
        // 站点 FBA 从库存仓按 店铺+国家 归属（EU 共享池单份），无仓时回退快照
        const siteParts = siteId.split(':');
        const fba = attributedFba(s.warehouseDetail,
          siteParts.length >= 2 ? siteParts[1]! : null, siteParts[0]!,
          sr30?.fbaQuantity || 0, sr30?.inboundQuantity || 0);
        siteData.fbaAvailable = fba.available;
        siteData.fbaInTransit = fba.inTransit;
        siteDatas.push(siteData);
      }
      if (siteDatas.length > 0) s.siteDatas = siteDatas;
    } else {
      // Legacy single-site path (kept for backward compat)
      const siteCode = siteMap?.get(sku);
      if (siteCode) {
        const matchedGroup = resolveMarketGroup(siteCode as string, marketGroups || []);
        if (matchedGroup) {
          // Aggregate group markets into siteData
          const groupMarkets7 = filterMarketsByGroup(markets7, matchedGroup);
          const groupMarkets14 = filterMarketsByGroup(markets14, matchedGroup);
          const groupMarkets30 = filterMarketsByGroup(markets30, matchedGroup);
          const groupMarkets60 = filterMarketsByGroup(markets60, matchedGroup);
          const groupMarkets90 = filterMarketsByGroup(markets90, matchedGroup);

          const siteData: SiteData = {
            site: matchedGroup.name + '（' + matchedGroup.markets.join('+') + '）'
          } as SiteData;
          emptyPeriodFields(siteData);

          const ag7 = aggregateRow(groupMarkets7), ag14 = aggregateRow(groupMarkets14);
          const ag30 = aggregateRow(groupMarkets30), ag60 = aggregateRow(groupMarkets60), ag90 = aggregateRow(groupMarkets90);
          if (ag7) fillPeriodFields(siteData, ag7, 7);
          if (ag14) fillPeriodFields(siteData, ag14, 14);
          if (ag30) fillPeriodFields(siteData, ag30, 30);
          if (ag60) fillPeriodFields(siteData, ag60, 60);
          if (ag90) fillPeriodFields(siteData, ag90, 90);
          aggregateMarkets(groupMarkets30, siteData);
          // 组 FBA：按组内国家整组归属一次（EU 池不会被 DE+FR+IT+ES 数 4 次）
          const gfba = attributedFba(s.warehouseDetail, null, matchedGroup.markets,
            ag30?.fbaQuantity || 0, ag30?.inboundQuantity || 0);
          siteData.fbaAvailable = gfba.available;
          siteData.fbaInTransit = gfba.inTransit;

          // Detect missing group markets
          const foundCodes = new Set<string>();
          if (markets30) {
            for (const mn of markets30.keys()) {
              const parts = mn.toUpperCase().split(':');
              foundCodes.add(parts[parts.length - 1]);
            }
          }
          const missing = matchedGroup.markets.filter(function(m) { return !foundCodes.has(m.toUpperCase()); });
          if (missing.length > 0) s.missingGroupMarkets = missing;

          s.siteDatas = [siteData];
        } else {
          // Existing single-market behavior (unchanged)
          const siteName = matchSiteMarket(siteCode as string, markets30);
          if (siteName) {
            const siteCodeDisplay = siteName.includes(':') ? siteName.split(':').pop()! : siteName;
            const siteData: SiteData = { site: siteCodeDisplay } as SiteData;
            emptyPeriodFields(siteData);
            const sr7 = markets7?.get(siteName), sr14 = markets14?.get(siteName);
            const sr30 = markets30?.get(siteName), sr60 = markets60?.get(siteName), sr90 = markets90?.get(siteName);
            if (sr7) fillPeriodFields(siteData, sr7, 7);
            if (sr14) fillPeriodFields(siteData, sr14, 14);
            if (sr30) fillPeriodFields(siteData, sr30, 30);
            if (sr60) fillPeriodFields(siteData, sr60, 60);
            if (sr90) fillPeriodFields(siteData, sr90, 90);
            const sfba = attributedFba(s.warehouseDetail, null, siteCode as string,
              sr30?.fbaQuantity || 0, sr30?.inboundQuantity || 0);
            siteData.fbaAvailable = sfba.available;
            siteData.fbaInTransit = sfba.inTransit;
            s.siteDatas = [siteData];
          }
        }
      }
    }
  }

  for (const s of summaries.values()) {
    s.totalAvailable = s.domesticAvailable + s.fbaAvailable + s.otherAvailable;
    s.totalInTransit = s.domesticInTransit + s.fbaInTransit + s.otherInTransit;
    s.totalReserved = s.domesticReserved + s.fbaReserved;
  }

  return Array.from(summaries.values());
}

function fmtCurrency(n: number): string { return '$' + Math.abs(n).toFixed(0); }

/** 流量字段 null（接口该窗口未回传）渲染为"缺失"，不得显示 0 假值 */
function fmtNum(v: number | null | undefined): string { return v == null ? '缺失' : String(v); }
function fmtPct1(v: number | null | undefined): string { return v == null ? '缺失' : v.toFixed(1) + '%'; }

/** Render a single SiteData data block for the AI prompt */
function renderSiteData(sd: SiteData): string {
  if (sd.multichannelOnly) {
    let st = '平稳';
    if (sd.avgDaily7d > sd.avgDaily90d * 1.15) st = '上升';
    else if (sd.avgDaily7d < sd.avgDaily90d * 0.85) st = '下降';
    return `
═══════════════════════════════════
【${sd.site}站点数据】(多渠道平台)
═══════════════════════════════════
【销量（该站点日均）】
7d:${sd.avgDaily7d.toFixed(1)} 14d:${sd.avgDaily14d.toFixed(1)} 30d:${sd.avgDaily30d.toFixed(1)} 60d:${sd.avgDaily60d.toFixed(1)} 90d:${sd.avgDaily90d.toFixed(1)} | 趋势:${st}

【流量】无数据
【广告】无数据
【质量】无数据
FBA库存: 可用${sd.fbaAvailable} 在途${sd.fbaInTransit} 预留${sd.fbaReserved}`;
  }
  const siteAge = sd.invAgeList.filter(function(a) { return a.value > 0; })
    .map(function(a) { return a.label + ': ' + a.value; }).join(', ') || '无数据';
  let st = '平稳';
  if (sd.avgDaily7d > sd.avgDaily90d * 1.15) st = '上升';
  else if (sd.avgDaily7d < sd.avgDaily90d * 0.85) st = '下降';

  return `
═══════════════════════════════════
【${sd.site}站点数据】
═══════════════════════════════════
【销量（${sd.site}站点日均）】
7d:${sd.avgDaily7d.toFixed(1)} 14d:${sd.avgDaily14d.toFixed(1)} 30d:${sd.avgDaily30d.toFixed(1)} 60d:${sd.avgDaily60d.toFixed(1)} 90d:${sd.avgDaily90d.toFixed(1)} | 趋势:${st}

【流量】
Sessions: 7d=${fmtNum(sd.sessions7d)} 14d=${fmtNum(sd.sessions14d)} 30d=${fmtNum(sd.sessions30d)} 60d=${fmtNum(sd.sessions60d)} 90d=${fmtNum(sd.sessions90d)}
PageViews: 7d=${fmtNum(sd.pageViews7d)} 14d=${fmtNum(sd.pageViews14d)} 30d=${fmtNum(sd.pageViews30d)} 60d=${fmtNum(sd.pageViews60d)} 90d=${fmtNum(sd.pageViews90d)}
CVR: 7d=${fmtPct1(sd.cvr7d)} 14d=${fmtPct1(sd.cvr14d)} 30d=${fmtPct1(sd.cvr30d)} 60d=${fmtPct1(sd.cvr60d)} 90d=${fmtPct1(sd.cvr90d)}
BuyBox: 7d=${fmtPct1(sd.buyBox7d)} 14d=${fmtPct1(sd.buyBox14d)} 30d=${fmtPct1(sd.buyBox30d)} 60d=${fmtPct1(sd.buyBox60d)} 90d=${fmtPct1(sd.buyBox90d)}

【广告】
Impressions: 7d=${sd.adsImpressions7d} 14d=${sd.adsImpressions14d} 30d=${sd.adsImpressions30d} 60d=${sd.adsImpressions60d} 90d=${sd.adsImpressions90d}
花费: 7d=${fmtCurrency(sd.adsSpend7d)} 14d=${fmtCurrency(sd.adsSpend14d)} 30d=${fmtCurrency(sd.adsSpend30d)} 60d=${fmtCurrency(sd.adsSpend60d)} 90d=${fmtCurrency(sd.adsSpend90d)}
CPC: 7d=${sd.cpc7d.toFixed(2)} 14d=${sd.cpc14d.toFixed(2)} 30d=${sd.cpc30d.toFixed(2)} 60d=${sd.cpc60d.toFixed(2)} 90d=${sd.cpc90d.toFixed(2)}
CTR: 7d=${sd.ctr7d.toFixed(2)}% 14d=${sd.ctr14d.toFixed(2)}% 30d=${sd.ctr30d.toFixed(2)}% 60d=${sd.ctr60d.toFixed(2)}% 90d=${sd.ctr90d.toFixed(2)}%
ACOS: 7d=${sd.acos7d.toFixed(1)}% 14d=${sd.acos14d.toFixed(1)}% 30d=${sd.acos30d.toFixed(1)}% 60d=${sd.acos60d.toFixed(1)}% 90d=${sd.acos90d.toFixed(1)}%
ROAS: 7d=${sd.roas7d.toFixed(1)} 14d=${sd.roas14d.toFixed(1)} 30d=${sd.roas30d.toFixed(1)} 60d=${sd.roas60d.toFixed(1)} 90d=${sd.roas90d.toFixed(1)}
广告订单: 7d=${sd.adsOrders7d} 14d=${sd.adsOrders14d} 30d=${sd.adsOrders30d} 60d=${sd.adsOrders60d} 90d=${sd.adsOrders90d}
自然订单: 7d=${sd.naturalOrders7d} 14d=${sd.naturalOrders14d} 30d=${sd.naturalOrders30d} 60d=${sd.naturalOrders60d} 90d=${sd.naturalOrders90d}

【质量】
星级:${sd.star} | 评论:${sd.reviewQuantity} | 退货率:${sd.returnsRate.toFixed(1)}% | 退款率:${sd.refundsRate.toFixed(1)}%
${sd.bsrByMarket?.length
    ? 'BSR: ' + sd.bsrByMarket.map((b) => b.market + ' #' + b.mainRank).join(' / ')
    : sd.bestBsrRank ? 'BSR: ' + sd.bestBsrTitle + ' #' + sd.bestBsrRank : 'BSR: 无数据'}
FBA库存: 可用${sd.fbaAvailable} 在途${sd.fbaInTransit} 预留${sd.fbaReserved}
FBA库龄: ${siteAge}`;
}

/** Build the AI prompt for a SKU */
export function buildAiPrompt(s: SkuSummary, selectedSites?: string[], nonLendableGroups?: Set<DomesticSiteGroup>): string {
  // 国内不可借（2026-09-08 借用排除）：勾选组的仓行标 [不可借]，合计行切换可借口径
  const nlGroups = nonLendableGroups ?? new Set<DomesticSiteGroup>();
  const nonLend = domesticNonLendable(s.domesticWarehouses, nlGroups);
  const domesticList = s.domesticWarehouses
    .map((w) => {
      const g = parseDomesticSiteGroup(w.name);
      return `  ${w.name}: 可用${w.available} 预占${w.reserved ?? 0} 在途${w.inTransit}` +
        (g && nlGroups.has(g) ? ' [不可借]' : '');
    }).join('\n');
  const invAge = s.invAgeList.filter((a) => a.value > 0)
    .map((a) => a.label + ': ' + a.value).join(', ') || '无数据';

  let trend = '平稳';
  if (s.avgDaily7d > s.avgDaily90d * 1.15) trend = '上升';
  else if (s.avgDaily7d < s.avgDaily90d * 0.85) trend = '下降';

  const now = new Date();
  const month = now.getMonth() + 1, day = now.getDate();
  let timeNote = '';
  if (month === 7 && day <= 20) timeNote = 'Prime Day刚过，售后流量可能偏高，未来一个月需量或有回落';
  else if (month >= 9 && month <= 11) timeNote = 'Q4旺季临近，需量预计上升，建议提前备货';
  else if (month === 12) timeNote = '圣诞季，需量高峰';

  // Operator prediction
  let operatorSection = '';
  if (s.operatorQty != null || s.operatorNote) {
    operatorSection = '\n【运营预测】';
    if (s.operatorQty != null) operatorSection += '\n预测采购量: ' + s.operatorQty;
    if (s.operatorNote) operatorSection += '\n备注: ' + s.operatorNote;
    operatorSection += '\n';
  }

  // Multi-site: render each selected site's data block
  let multiSiteSection = '';
  let selectedSiteDatas: SiteData[] = [];
  if (selectedSites && s.siteDatas && s.siteDatas.length > 0) {
    selectedSiteDatas = s.siteDatas.filter(function(sd) { return selectedSites!.includes(sd.site); });
    for (const sd of selectedSiteDatas) {
      multiSiteSection += renderSiteData(sd);
    }
  }

  // Multi-site mode only when selectedSites are given AND per-site data blocks
  // actually exist; otherwise fall back to single-site instructions.
  const isMultiSite = !!(selectedSites && selectedSites.length > 0 && selectedSiteDatas.length > 0);

  // Site section (single-site backward compat: first entry in siteDatas acts as the single site)
  // Suppressed in multi-site mode — multiSiteSection already renders every site, including
  // siteDatas[0], so rendering it again here would duplicate the block.
  let siteSection = '';
  const firstSiteData = s.siteDatas && s.siteDatas.length > 0 ? s.siteDatas[0] : undefined;
  const hasSite = !!firstSiteData;
  if (hasSite && !isMultiSite) {
    siteSection = renderSiteData(firstSiteData!);
  }

  return `你是跨境ERP采购分析助手。根据以下SKU数据给出独立分析。

【基础信息】
SKU: ${s.sku} | 产品: ${s.productName}
单箱数量: ${s.singleQuantity} | 生产需${s.productionDays}天 | 头程需${s.shippingDays}天 | 卖到${s.sellUntilDate} | 冗余${s.bufferDays}天${operatorSection}
═══════════════════════════════════
【全局数据 — 全站点汇总】
═══════════════════════════════════
【库存】${domesticList ? '\n国内仓:\n' + domesticList : '\n国内仓: 无'}
国内仓合计: 可用${s.domesticAvailable}${nonLend > 0 ? `（可借 ${s.domesticAvailable - nonLend} / 不可借 ${nonLend}）` : ''} 预占${s.domesticReserved} 可动用${nonLend > 0 ? s.domesticAvailable - nonLend - s.domesticReserved + '(=可借−预占)' : s.domesticAvailable - s.domesticReserved + '(=可用−预占)'} 在途${s.domesticInTransit}(内部调拨入)
计采交合计(计划量+采购量+交货量,未来的货): ${s.purchaseInTransit}
FBA仓合计: 可用${s.fbaAvailable} 在途${s.fbaInTransit}(含已发货/待入库/待出运) 预留${s.fbaReserved}
调拨待出运(已出库未发运,中转): ${s.transferWaitShippedTotal}(已计入在途合计)
FBA库龄: ${invAge}
总计: 可用${s.totalAvailable} 在途${s.totalInTransit} 预留${s.totalReserved}

【销量（全渠道日均）】
7d:${s.avgDaily7d.toFixed(1)} 14d:${s.avgDaily14d.toFixed(1)} 30d:${s.avgDaily30d.toFixed(1)} 60d:${s.avgDaily60d.toFixed(1)} 90d:${s.avgDaily90d.toFixed(1)} | 趋势:${trend}

【流量】
Sessions: 7d=${fmtNum(s.sessions7d)} 14d=${fmtNum(s.sessions14d)} 30d=${fmtNum(s.sessions30d)} 60d=${fmtNum(s.sessions60d)} 90d=${fmtNum(s.sessions90d)}
PageViews: 7d=${fmtNum(s.pageViews7d)} 14d=${fmtNum(s.pageViews14d)} 30d=${fmtNum(s.pageViews30d)} 60d=${fmtNum(s.pageViews60d)} 90d=${fmtNum(s.pageViews90d)}
CVR: 7d=${fmtPct1(s.cvr7d)} 14d=${fmtPct1(s.cvr14d)} 30d=${fmtPct1(s.cvr30d)} 60d=${fmtPct1(s.cvr60d)} 90d=${fmtPct1(s.cvr90d)}
BuyBox: 7d=${fmtPct1(s.buyBox7d)} 14d=${fmtPct1(s.buyBox14d)} 30d=${fmtPct1(s.buyBox30d)} 60d=${fmtPct1(s.buyBox60d)} 90d=${fmtPct1(s.buyBox90d)}

【广告】
Impressions: 7d=${s.adsImpressions7d} 14d=${s.adsImpressions14d} 30d=${s.adsImpressions30d} 60d=${s.adsImpressions60d} 90d=${s.adsImpressions90d}
花费: 7d=${fmtCurrency(s.adsSpend7d)} 14d=${fmtCurrency(s.adsSpend14d)} 30d=${fmtCurrency(s.adsSpend30d)} 60d=${fmtCurrency(s.adsSpend60d)} 90d=${fmtCurrency(s.adsSpend90d)}
CPC: 7d=${s.cpc7d.toFixed(2)} 14d=${s.cpc14d.toFixed(2)} 30d=${s.cpc30d.toFixed(2)} 60d=${s.cpc60d.toFixed(2)} 90d=${s.cpc90d.toFixed(2)}
CTR: 7d=${s.ctr7d.toFixed(2)}% 14d=${s.ctr14d.toFixed(2)}% 30d=${s.ctr30d.toFixed(2)}% 60d=${s.ctr60d.toFixed(2)}% 90d=${s.ctr90d.toFixed(2)}%
ACOS: 7d=${s.acos7d.toFixed(1)}% 14d=${s.acos14d.toFixed(1)}% 30d=${s.acos30d.toFixed(1)}% 60d=${s.acos60d.toFixed(1)}% 90d=${s.acos90d.toFixed(1)}%
ROAS: 7d=${s.roas7d.toFixed(1)} 14d=${s.roas14d.toFixed(1)} 30d=${s.roas30d.toFixed(1)} 60d=${s.roas60d.toFixed(1)} 90d=${s.roas90d.toFixed(1)}
广告订单: 7d=${s.adsOrders7d} 14d=${s.adsOrders14d} 30d=${s.adsOrders30d} 60d=${s.adsOrders60d} 90d=${s.adsOrders90d}
自然订单: 7d=${s.naturalOrders7d} 14d=${s.naturalOrders14d} 30d=${s.naturalOrders30d} 60d=${s.naturalOrders60d} 90d=${s.naturalOrders90d}

【质量】
星级:${s.star} | 评论:${s.reviewQuantity} | 退货率:${s.returnsRate.toFixed(1)}% | 退款率:${s.refundsRate.toFixed(1)}%
${s.bsrByMarket?.length
    ? 'BSR: ' + s.bsrByMarket.map((b) => b.market + ' #' + b.mainRank).join(' / ')
    : s.bestBsrRank ? 'BSR: ' + s.bestBsrTitle + ' #' + s.bestBsrRank : 'BSR: 无数据'}
状态: ${s.listingStates.join('、') || '正常'}${siteSection}${multiSiteSection}

【时间】${now.getFullYear()}/${month}/${day}${timeNote ? ' ' + timeNote : ''}

═══════════════════════════════════
你是ERP采购分析助手。根据以上数据给出采购建议，回复需包含推理过程。
数据说明: 字段值"缺失"=该窗口接口未回传（如变体合并期间、同步延迟），请结合其他窗口与销量/广告数据判断。${isMultiSite ? `

必须为每个scope输出独立的一条JSON记录，共${1 + selectedSiteDatas.length}条（全局 + ${selectedSiteDatas.map(function(sd) { return sd.site; }).join('、')}）。每条记录必须包含scope字段标明分析范围（"global"或站点标识）。` : hasSite ? `

必须分别输出【全局】和【${firstSiteData!.site}】两份独立分析，缺一不可。` : ''}${s.operatorQty != null ? `
运营提供了${hasSite ? firstSiteData!.site : ''}预测采购量${s.operatorQty}${s.operatorNote ? '，备注：' + s.operatorNote : ''}。请与${hasSite ? '【' + firstSiteData!.site + '】' : '【全局】'}建议对比，偏差>20%时指出。` : ''}

推理格式（每条100字左右）：
1. 判断：引用关键数据（7d/14d/30d日均变化、Sessions走势、CVR、BSR、时间节点），说明趋势
2. 预测：给出 predictedDailySales（预测日均，可带小数）并说明理由（季节/趋势/listing阶段）
3. 结论：是否建议补货

suggestedQty 字段统一填 0（具体数量无需你计算）。

predictedDailySales必须填真实数字（禁止保留占位符0），suggestedQty统一填0。
${isMultiSite ? '每个scope独立给出predictedDailySales值（suggestedQty统一填0）。' : hasSite ? '【全局】和【' + firstSiteData!.site + '】两份分析必须各自给出predictedDailySales值，suggestedQty统一填0。' : ''}
predictedDailySales填预测日均（可带小数）。
（风险等级和补货日期由前端自动计算。）

suggestion文本格式要求（务必遵守）：
不要在suggestion里提及前端、公式、计算过程等实现细节，直接给结论；不要写具体采购数字。
库存/在途、可覆盖天数、补货提前期、建议采购日期、建议采购量等结论数字已固定展示，suggestion中不要重复输出这些数字行，只写判断、预测依据和结论。
${isMultiSite ? '每个scope独立一行：\\n' + selectedSiteDatas.map(function(sd) { return '【' + sd.site + '】判断+预测日均+结论（是否建议补货）'; }).join('\\n') + '\\n【全局】判断+预测日均+结论（是否建议补货）' : hasSite ? '【全局】判断+预测日均+结论（是否建议补货）\\n【' + firstSiteData!.site + '】判断+预测日均+结论（是否建议补货）' : '判断+预测日均+结论（是否建议补货）'}

返回纯JSON（suggestion内用\\n换行）：${isMultiSite ? '\n[{"sku":"' + s.sku + '","scope":"global","suggestion":"...","riskLevel":"yellow","suggestedQty":0,"predictedDailySales":5.5,"weeklyForecast":[...]}, ...]（每条记录必须包含scope字段）' : '\n[{"sku":"' + s.sku + '","suggestion":"...","suggestedQty":0,"predictedDailySales":5.5,"weeklyForecast":[...]}]'}

weeklyForecast要求（额外字段，用于未来库存曲线）：
- 长度${Math.max(1, Math.ceil((new Date(s.sellUntilDate).getTime() - Date.now()) / (7 * 86400000)))}，从下周起至卖到日期${s.sellUntilDate}止按自然周划分
- 基于历史销售趋势（7d/14d/30d/60d/90d日均）、季节性节点（Prime Day/Q4/圣诞）、listing生命周期阶段预测
- 每周都必须是正数，禁止任何一周填0：近期周取当前水平，远期周可随不确定性逐步衰减，但最后一周不得低于 predictedDailySales × 2
- 各周销量之和应约等于 predictedDailySales × 覆盖天数`;
}

// --- Multi-channel sales aggregation ---

export interface MultiChannelDaily {
  avgDaily7d: number; avgDaily14d: number; avgDaily30d: number; avgDaily60d: number; avgDaily90d: number;
}

function emptyMultiChannelDaily(): MultiChannelDaily {
  return { avgDaily7d: 0, avgDaily14d: 0, avgDaily30d: 0, avgDaily60d: 0, avgDaily90d: 0 };
}

/** 五个窗口（7/14/30/60/90 天）的多渠道日均。
 *  不带 platformMarketList = 全渠道口径；MULTI 视图不含 Amazon 行时
 *  自动追加 AMAZON 视图合并件数。带 platformMarketList = 单站点口径，不合并。 */
export async function fetchMultiChannelAverages(
  skus: string[],
  token: string,
  platformMarketList?: number[],
  signal?: AbortSignal,
): Promise<Map<string, MultiChannelDaily>> {
  const WINDOWS = [7, 14, 30, 60, 90];
  const result = new Map<string, MultiChannelDaily>();
  for (const sku of skus) result.set(sku, emptyMultiChannelDaily());

  // 五个时间窗口相互独立（各写各自的字段），并行抓取；
  // 窗口内的 AMAZON 补齐依赖同窗口 MULTI 的结果，保持窗口内串行
  await Promise.all(WINDOWS.map(async (days) => {
    const begin = daysAgo(days);
    const end = daysAgo(0);
    const totals = new Map<string, number>();
    const addRows = (rows: MultiChannelRow[]) => {
      for (const r of rows) {
        totals.set(r.sku, (totals.get(r.sku) ?? 0) + r.unitsOrdered);
      }
    };
    const rows = await fetchMultiChannelSales(skus, begin, end, token, platformMarketList, signal);
    addRows(rows);
    if (!platformMarketList) {
      const skusWithAmazon = new Set(rows.filter((r) => r.platformCode === 'AMAZON').map((r) => r.sku));
      const missing = skus.filter((sku) => !skusWithAmazon.has(sku));
      if (missing.length > 0) {
        addRows(await fetchMultiChannelSales(missing, begin, end, token, undefined, signal, 'AMAZON'));
      }
    }
    for (const [sku, total] of totals) {
      const entry = result.get(sku);
      if (!entry) continue;
      const avg = total / days;
      if (days === 7) entry.avgDaily7d = avg;
      else if (days === 14) entry.avgDaily14d = avg;
      else if (days === 30) entry.avgDaily30d = avg;
      else if (days === 60) entry.avgDaily60d = avg;
      else entry.avgDaily90d = avg;
    }
  }));
  return result;
}

/** 把多渠道数据并入 summaries：
 *  1) mcGlobal 覆盖全渠道日均字段（提示词全渠道数据块与 7d 回退用它）；
 *  2) mcSites 按平台市场追加 SiteData（multichannelOnly），库存 = 映射国内仓 + 海外虚拟仓。 */
export function applyMultiChannelToSummaries(
  summaries: SkuSummary[],
  mcGlobal: Map<string, MultiChannelDaily>,
  mcSites: Map<string, Map<string, MultiChannelDaily>>,
  markets: PlatformMarket[],
): void {
  for (const s of summaries) {
    const g = mcGlobal.get(s.sku);
    if (g) {
      s.avgDaily7d = g.avgDaily7d; s.avgDaily14d = g.avgDaily14d; s.avgDaily30d = g.avgDaily30d;
      s.avgDaily60d = g.avgDaily60d; s.avgDaily90d = g.avgDaily90d;
    }
    const siteDatas = s.siteDatas ?? [];
    for (const m of markets) {
      const mapping = platformMarketWarehouses(m);
      if (!mapping) continue;
      const mc = mcSites.get(m.id)?.get(s.sku);
      if (!mc) continue;
      let avail = 0;
      let transit = 0;
      for (const w of s.warehouseDetail ?? []) {
        if (w.name === mapping.domesticWh || (mapping.overseasWh && w.name === mapping.overseasWh)) {
          avail += w.available;
          // 在途走未来口径（映射仓可能是 THIRD/SELF 类型，raw inTransitQty 会漏发运管线）
          transit += rowFutureInTransit({
            inTransitQty: w.inTransit, erpShipped: w.shipped,
            erpReceiving: w.receiving, erpWaitShipped: w.waitShipped,
          }) + (w.purchasePlanQty || 0);
        }
      }
      const sd = { site: m.id } as SiteData;
      emptyPeriodFields(sd);
      sd.avgDaily7d = mc.avgDaily7d; sd.avgDaily14d = mc.avgDaily14d; sd.avgDaily30d = mc.avgDaily30d;
      sd.avgDaily60d = mc.avgDaily60d; sd.avgDaily90d = mc.avgDaily90d;
      sd.fbaAvailable = avail;
      sd.fbaInTransit = transit;
      sd.multichannelOnly = true;
      siteDatas.push(sd);
    }
    s.siteDatas = siteDatas;
  }
}
