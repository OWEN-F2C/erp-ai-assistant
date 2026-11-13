// shared/api-client.ts
import { readErpJson } from './erp-errors';
const JIJIA_GATEWAY = 'https://gateway.apist.gerpgo.com';

// --- Domestic warehouse detection via warehouse tree API ---

interface WhTreeNode {
  key: number;
  title: string;
  type: string | null;
  children: WhTreeNode[] | null;
  isLeaf: boolean;
}

let domesticWhIdCache: Set<number> | null = null;

/** Fetch warehouse tree and extract domestic warehouse IDs from level-2 titles.
 *  Level 1: 平台仓 / 自营仓 / 三方仓 / 供应商仓
 *  Level 2: 国内-自营仓 / 海外-自营仓 / 国内-三方仓 / 海外-三方仓 ...
 *  Level 3: specific warehouse leaves with numeric key (matching inventory API's warehouseId)
 */
export async function fetchDomesticWarehouseIds(token: string): Promise<Set<number>> {
  if (domesticWhIdCache) return domesticWhIdCache;

  const resp = await fetch(
    `${JIJIA_GATEWAY}/gipx/common/warehouseSelection/universal/dropdown/newBox`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      // 无超时的挂起会让 loadSites / fetchAndSummarize 的 Promise.all 永远不返回
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        fba: true, wfs: true,
        selfDomestic: true, selfOverseas: true,
        supplierDomestic: true, supplierOverseas: true,
        thirdDomestic: true, thirdOverseas: true,
        filterDisableStatus: true, showDeleteMarket: true,
        warehousePermissionFlag: true, platformInitFlag: true,
        thirdInitFlag: true, amazonAwd: true,
      }),
    },
  );
  const json = await readErpJson(resp, '仓库列表');
  const roots = json.data as WhTreeNode[];
  const ids = new Set<number>();

  function walk(nodes: WhTreeNode[], inDomesticBranch: boolean): void {
    for (const node of nodes) {
      const isDomesticL2 = node.title.startsWith('国内');
      const isOverseasL2 = node.title.startsWith('海外');
      const nextDomestic = node.key < 0
        ? (isDomesticL2 ? true : isOverseasL2 ? false : inDomesticBranch)
        : inDomesticBranch;

      if (node.children) {
        walk(node.children, nextDomestic);
      } else if (node.isLeaf && nextDomestic) {
        ids.add(node.key);
      }
    }
  }

  walk(roots, false);
  if (ids.size > 0) domesticWhIdCache = ids;
  return ids;
}

/** Check if a warehouse is domestic by its ID (from inventory API's warehouseId = tree node key) */
export function isDomesticWarehouse(warehouseId: number, domesticIds: Set<number>): boolean {
  return domesticIds.has(warehouseId);
}

// --- Country / store server listing ---

export interface CountryServer {
  /** Leaf title: "DE:Yaoshu", "US:SUPRENT_Global" */
  title: string;
  /** Country code: "DE", "US", "FR" */
  country: string;
  /** Store numeric ID from the API (leaf node data field) */
  storeId: number;
}

/**
 * Fetch the list of active store servers from 积加's country/server API.
 * Returns flat list of leaf (store-level) entries filtered to active/enabled only.
 */
export async function fetchCountryServers(token: string): Promise<CountryServer[]> {
  const resp = await fetch(
    `${JIJIA_GATEWAY}/v2/common/authorize/countrysAndServers?showDeleteMarket=true&showMarketState=true&showData=true`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const json = await readErpJson(resp, '店铺/站点列表');
  const data: unknown[] = json.data || [];
  const result: CountryServer[] = [];

  interface ApiNode {
    key: string; title: string; leaf: boolean;
    deleteMarket?: number; disabledMarket?: number;
    data?: number; children?: ApiNode[];
  }

  function walk(nodes: ApiNode[], country: string): void {
    for (const node of nodes) {
      const isCountry = node.children && node.children.length > 0 && !node.leaf;
      if (isCountry) {
        walk(node.children, node.title);
      } else if (node.leaf) {
        if (node.deleteMarket !== 1 && node.disabledMarket !== 1) {
          result.push({
            title: node.title,
            country: country || node.title,
            storeId: node.data ?? 0,
          });
        }
      }
    }
  }

  walk(data as ApiNode[], '');
  // Sort: by country code then by store title
  result.sort((a, b) => {
    const cmp = a.country.localeCompare(b.country);
    return cmp !== 0 ? cmp : a.title.localeCompare(b.title);
  });
  return result;
}

// --- Purchase plan generator: SKU search ---

/** A product row returned by the purchase plan SKU search API.
 *  Fields the API does not provide (asin/fnsku/stock/sales) are placeholders;
 *  real stock and sales data comes from fetchAndSummarize in a later task. */
export interface SkuProduct {
  sku: string;
  productName: string;
  asin: string;
  fnsku: string;
  msku: string;
  singleQuantity: number;
  category: string;
  brand: string;
  availableQty: number;
  inTransitQty: number;
  avgDailySales: number;
  imageUrl: string;
  /** Production lead time in days, from product master data */
  productDeliveryDays: number;
  /** Minimum order quantity; null when the API returns no value */
  moq: number | null;
}

/**
 * Search purchasable products by keyword for a given arrival warehouse.
 * The planProductDataGrid API has no server-side keyword parameter — pages
 * are fetched (200 rows each, up to 5 pages) and filtered client-side on
 * `sku` / `skuName`. With a keyword, pagination stops as soon as matches are
 * found; without one, up to 1000 rows are collected. An empty keyword
 * returns all collected rows.
 */
export async function searchSkuProducts(
  keyword: string,
  warehouseId: number,
  token: string,
  signal: AbortSignal,
): Promise<SkuProduct[]> {
  const kw = keyword.trim().toLowerCase();
  const collected: Record<string, unknown>[] = [];
  const PAGE_SIZE = 200;
  const MAX_PAGES = 5;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetch(
      `${JIJIA_GATEWAY}/supply/srm/purchase/plan/planProductDataGrid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({
          page,
          pagesize: PAGE_SIZE,
          arrivalWarehouseId: warehouseId,
        }),
        signal,
      },
    );
    const json = await readErpJson(resp, 'SKU商品数据');
    const rows: Record<string, unknown>[] = json.data?.rows || json.data || [];

    if (kw) {
      const hits = rows.filter(
        (r) =>
          String(r.sku ?? '').toLowerCase().includes(kw) ||
          String(r.skuName ?? '').toLowerCase().includes(kw),
      );
      collected.push(...hits);
      if (rows.length < PAGE_SIZE) break;
    } else {
      collected.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
  }

  return collected.map((r) => {
    const mskuList = Array.isArray(r.mskuList) ? (r.mskuList as unknown[]) : [];
    return {
      sku: String(r.sku ?? ''),
      productName: String(r.skuName ?? r.productName ?? ''),
      asin: '', // not provided by this API
      fnsku: '', // not provided by this API
      msku: String(mskuList[0] ?? r.msku ?? ''),
      singleQuantity: 1, // placeholder; real box qty comes from fetchAndSummarize
      category: String(r.category ?? ''),
      brand: String(r.brand ?? ''),
      availableQty: 0, // placeholder
      inTransitQty: 0, // placeholder
      avgDailySales: 0, // placeholder
      imageUrl: String(r.image ?? r.imageUrl ?? ''),
      productDeliveryDays: Number(r.productDeliveryDays ?? 0),
      moq: r.moq == null ? null : Number(r.moq),
    };
  });
}

// --- Platform markets (全平台市场列表，来自全渠道销售表现页) ---

export interface PlatformMarket {
  id: string;            // market id, e.g. "43" (Amazon) / "1000051" (TikTok)
  text: string;          // display name, e.g. "SUPRENT PRO ACCU:US"
  group: string;         // "AMAZON" / "TIKTOK" / "TEMU_POP_MANAGED" / ...
  groupAlias: string;    // "Amazon" / "Tiktok自运营" / ...
  country: string;       // countryCode, e.g. "US"
  deleteMarket: number;  // 1 = deleted
}

export async function fetchPlatformMarkets(token: string, signal?: AbortSignal): Promise<PlatformMarket[]> {
  const resp = await fetch(
    `${JIJIA_GATEWAY}/v2/polymerize/market/polymerizeMarketAddShareAndPer`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      body: JSON.stringify({ showAuthAlias: true }),
      signal: signal || AbortSignal.timeout(15000),
    },
  );
  const json = await readErpJson(resp, '平台市场列表');
  const data: Array<Record<string, unknown>> = json.data || [];
  return data
    .filter((m) => Number(m.deleteMarket ?? 0) !== 1)
    .map((m) => ({
      id: String(m.id ?? ''),
      text: String(m.text ?? ''),
      group: String(m.group ?? ''),
      groupAlias: String(m.groupAlias ?? ''),
      country: String(m.countryCode ?? ''),
      deleteMarket: Number(m.deleteMarket ?? 0),
    }));
}

/** 站点 → 仓库映射（spec 4.3）。未知平台返回 null（不展示站点 pill）。 */
export function platformMarketWarehouses(
  m: Pick<PlatformMarket, 'group' | 'country'>,
): { domesticWh: string; overseasWh?: string } | null {
  const g = m.group.toUpperCase();
  const c = (m.country || '').toUpperCase();
  if (g === 'TIKTOK') {
    if (c === 'DE') return { domesticWh: 'CN_A_Tiktok', overseasWh: 'DE-Tiktok-FBT虚拟仓' };
    if (c === 'US') return { domesticWh: 'CN_A_Tiktok', overseasWh: 'US-Tiktok-FBT虚拟仓' };
    return null; // 未支持国家：不错配到其它国家的 FBT 虚拟仓
  }
  if (g.includes('TEMU')) return { domesticWh: 'CN_A_TEMU' };
  if (g.includes('WALMART')) return { domesticWh: 'CN_C_WMSP' };
  if (g.includes('SHOPIFY') || g.includes('INDEPENDENT')) return { domesticWh: 'CN-独立站' };
  return null;
}

// --- Multi-channel sales (全渠道销售表现页同款接口) ---

export interface MultiChannelRow {
  sku: string;
  marketId: number;
  marketName: string;
  platformCode: string;
  unitsOrdered: number;
  orders: number;
}

/** Query mskuSalesView with a date range. viewType MONTH aggregates the range
 *  into one row per SKU×market. platformMarketList filters to specific
 *  platform markets (TikTok stores etc.); omit for all. */
export async function fetchMultiChannelSales(
  skus: string[],
  beginDate: string,
  endDate: string,
  token: string,
  platformMarketList?: number[],
  signal?: AbortSignal,
  platformType: 'MULTI' | 'AMAZON' = 'MULTI',
): Promise<MultiChannelRow[]> {
  const all: Array<Record<string, unknown>> = [];
  let page = 1;
  while (page <= 20) {
    const body: Record<string, unknown> = {
      platformType,
      currency: 'CNY',
      keywordsSearch: { skuList: skus },
      beginDate,
      endDate,
      viewType: 'MONTH',
      sort: 'unitsOrdered',
      order: 'descend',
      page,
      pagesize: 500,
    };
    if (platformMarketList && platformMarketList.length > 0) {
      body.platformMarketList = platformMarketList;
    }
    const resp = await fetch(`${JIJIA_GATEWAY}/v3/statistics/analysisMultiChannel/mskuSalesView`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(15000),
    });
    const json = await readErpJson(resp, '多渠道销售数据');
    const rows: Array<Record<string, unknown>> = json.data?.rows || [];
    all.push(...rows);
    if (rows.length < 500) break;
    page++;
  }
  return all.map((r) => ({
    sku: String(r.sku ?? ''),
    marketId: Number(r.marketId ?? 0),
    marketName: String(r.marketName ?? ''),
    platformCode: String(r.platformCode ?? ''),
    unitsOrdered: Number(r.unitsOrdered ?? 0),
    orders: Number(r.orders ?? 0),
  }));
}
