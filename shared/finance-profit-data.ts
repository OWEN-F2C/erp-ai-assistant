// shared/finance-profit-data.ts
import { readErpJson } from './erp-errors';
import { cache } from './cache';

const JIJIA_GATEWAY = 'https://gateway.apist.gerpgo.com';
const PROFIT_CACHE_VERSION_KEY = 'profitCacheVersion';
const CURRENT_CACHE_VERSION = 5; // v5: use EFPCR calcFormula from findColumnsByDimension API
/** Return current month in YYYY-MM format using local time (not UTC). */
function getLocalMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const HISTORICAL_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Raw row from financialAnalysisList API.
 *  EFPCR-prefixed fields are formula components whose values
 *  are summed to compute netProfit. The set of relevant EFPCR
 *  keys is determined at runtime via the formula config APIs. */
export interface ProfitApiRow {
  sku: string;
  productName: string;
  brand: string;
  category: string;
  sellingManagerName: string;
  platformCode: string;
  platformName: string;
  marketName: string;
  /** Sum of all EFPCR formula component values for this row */
  netProfit: number;
  salesMoney: number;
}

/** Aggregated profit summary for one SKU across all months and platforms */
export interface SkuProfitSummary {
  sku: string;
  productName: string;
  brand: string;
  category: string;
  sellingManagerName: string;
  /** month (YYYY-MM) -> net profit summed across platforms */
  monthlyProfit: Record<string, number>;
  /** month -> { platformCode: netProfit } */
  channelBreakdown: Record<string, Record<string, number>>;
  cumulativeProfit: number;
  avgMonthlyProfit: number;
  /** ((avgLast3 - avgPrior3) / |avgPrior3|) * 100, null if < 6 months data */
  trend: number | null;
}

export interface MonthProfitData {
  month: string;
  rows: ProfitApiRow[];
  fromCache: boolean;
}

export interface FetchProgress {
  month: string;
  status: 'fetching' | 'cached' | 'done' | 'error';
}

function profitCacheKey(month: string): string {
  return `profitCache_${month}`;
}

async function ensureCacheVersion(): Promise<void> {
  const stored = await chrome.storage.local.get(PROFIT_CACHE_VERSION_KEY);
  if (stored[PROFIT_CACHE_VERSION_KEY] !== CURRENT_CACHE_VERSION) {
    await cache.invalidate('profitCache_');
    await chrome.storage.local.set({ [PROFIT_CACHE_VERSION_KEY]: CURRENT_CACHE_VERSION });
  }
}

async function getCachedProfitMonth(month: string): Promise<Record<string, ProfitApiRow> | null> {
  await ensureCacheVersion();
  return cache.get<Record<string, ProfitApiRow>>(profitCacheKey(month));
}

async function setCachedProfitMonth(month: string, data: Record<string, ProfitApiRow>): Promise<void> {
  const currentMonth = getLocalMonth();
  const isHistorical = month < currentMonth;
  const ttl = isHistorical ? HISTORICAL_TTL : 0;
  await cache.set(profitCacheKey(month), data, ttl);
}

export async function clearProfitCache(): Promise<void> {
  await cache.invalidate('profitCache_');
}

// ---- Step 2: Formula discovery ----

/** Hardcoded fallback EFPCR fields for 销售净利, in case the column config API fails.
 *  These are the standard calcFormula fields from findColumnsByDimension. */
const FALLBACK_NET_PROFIT_FIELDS = [
  'EFPCR23060200139', 'EFPCR23060200055', 'EFPCR23060200065',
  'EFPCR23060200076', 'EFPCR23060200091', 'EFPCR23060200060',
  'EFPCR23060200061', 'EFPCR23060200062', 'EFPCR23060200088',
  'EFPCR23060200089',
];

/** Fetch the actual calcFormula from the column configuration API.
 *  Returns the list of EFPCR field names that sum to 销售净利.
 *  Falls back to hardcoded fields if the API is unreachable. */
async function fetchNetProfitFields(token: string): Promise<string[]> {
  try {
    const resp = await fetch(
      `${JIJIA_GATEWAY}/finance/baseconfig/profit/findColumnsByDimension?dimension=sku&isKingdeeApi=false`,
      { headers: { 'x-auth-token': token } },
    );
    if (!resp.ok) throw new Error(`Column config API ${resp.status}`);

    const json = await resp.json();
    const regions: Array<{ columnsVOS?: Array<{ columnName?: string; calcFormula?: string; columns?: unknown[] }> }> = json.data || [];

    // Search for the 销售净利 column
    function findNetProfitCol(cols: unknown[]): string | null {
      for (const col of cols) {
        const c = col as Record<string, unknown>;
        if (c.columnName === '销售净利' && c.calcFormula) {
          return c.calcFormula as string;
        }
        if (c.columns) {
          const result = findNetProfitCol(c.columns as unknown[]);
          if (result) return result;
        }
      }
      return null;
    }

    for (const region of regions) {
      const formula = findNetProfitCol((region.columnsVOS || []) as unknown[]);
      if (formula) {
        // Extract EFPCR field codes from calcFormula (e.g. "EFPCR23060200139+EFPCR23060200055+...")
        const fields = [...formula.matchAll(/EFPCR\d+/g)].map(m => m[0]);
        if (fields.length > 0) {
          console.log(`[finance-profit] net profit formula: ${fields.length} EFPCR fields`);
          return fields;
        }
      }
    }

    console.warn('[finance-profit] 销售净利 column not found in config, using fallback');
  } catch (err) {
    console.warn('[finance-profit] column config API failed, using fallback:', err);
  }
  return FALLBACK_NET_PROFIT_FIELDS;
}

// ---- Step 3: Single-month API fetch ----

async function fetchProfitMonthApi(
  month: string,
  platformCodes: string[],
  netProfitFields: string[],
  token: string,
  signal: AbortSignal,
): Promise<ProfitApiRow[]> {
  const allRows: ProfitApiRow[] = [];
  let page = 1;
  const pageSize = 200;

  while (true) {
    if (signal.aborted) throw new Error('Aborted');

    const resp = await fetch(
      `${JIJIA_GATEWAY}/finance/profit/financialProfitAnalysis/financialAnalysisList`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({
          queryType: 'sku',
          platformCodes,
          costValues: 2,
          allocationFlag: '0',
          currency: 'CNY',
          monthDate: month,
          dateType: 1,
          page,
          pagesize: pageSize,
          marketIds: [],
          country: [],
        }),
        signal,
      },
    );

    const json = await readErpJson(resp, '利润数据（' + month + '）');
    const rows: Record<string, unknown>[] = json.data?.rows || [];

    if (page === 1) {
      console.log(
        `[finance-profit] ${month} page 1: total=${json.data?.total}, ` +
        `rows=${rows.length}, netProfitFields=${netProfitFields.length}`,
      );
    }

    for (const r of rows) {
      // 销售净利 = sum of EFPCR fields from column config calcFormula
      let netProfit = 0;
      for (const f of netProfitFields) {
        netProfit += Number(r[f]) || 0;
      }

      allRows.push({
        sku: String(r.sku ?? ''),
        productName: String(r.productName ?? ''),
        brand: String(r.brand ?? ''),
        category: String(r.category ?? ''),
        sellingManagerName: String(r.sellingManagerName ?? ''),
        platformCode: String(r.platformCode ?? ''),
        platformName: String(r.platformName ?? ''),
        marketName: String(r.marketName ?? ''),
        netProfit,
        salesMoney: Number(r.salesMoney ?? 0),
      });
    }

    if (rows.length < pageSize) break;
    page++;
  }

  return allRows;
}

// ---- Step 4: getMonthsInRange helper ----

/** Generate array of YYYY-MM strings from startMonth to endMonth inclusive */
export function getMonthsInRange(startMonth: string, endMonth: string): string[] {
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  const months: string[] = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// ---- Step 5: fetchAllProfitMonths orchestrator ----

/** Fetch profit data for all months in the configured range.
 *  Issues one request per month (serialized). Checks cache first.
 *  Calls onProgress after each month completes.
 *  Single-month failures do not block other months;
 *  failed months are absent from the result. */
export async function fetchAllProfitMonths(
  startMonth: string,
  token: string,
  signal: AbortSignal,
  onProgress?: (p: FetchProgress) => void,
): Promise<MonthProfitData[]> {
  const endMonth = getLocalMonth();
  const months = getMonthsInRange(startMonth, endMonth);

  // Get enabled platform codes
  let platformCodes: string[] = ['Amazon'];
  try {
    const platResp = await fetch(
      `${JIJIA_GATEWAY}/finance/baseconfig/platform/set/getEnablePlatformCode`,
      { headers: { 'x-auth-token': token }, signal },
    );
    if (platResp.ok) {
      const platJson = await platResp.json();
      const rawPlatforms: unknown[] = platJson.data || [];
      platformCodes = rawPlatforms.map((p: unknown) =>
        typeof p === 'string' ? p : String((p as Record<string, unknown>).platformCode ?? ''),
      ).filter(Boolean);
    }
  } catch { /* use default */ }

  // Discover 销售净利 formula from column configuration
  const netProfitFields = await fetchNetProfitFields(token);

  const results: MonthProfitData[] = [];

  for (const month of months) {
    if (signal.aborted) break;

    onProgress?.({ month, status: 'fetching' });

    // Check cache
    const cached = await getCachedProfitMonth(month);
    if (cached) {
      results.push({ month, rows: Object.values(cached), fromCache: true });
      onProgress?.({ month, status: 'cached' });
      continue;
    }

    // Fetch from API
    try {
      const rows = await fetchProfitMonthApi(
        month, platformCodes, netProfitFields, token, signal,
      );
      const map: Record<string, ProfitApiRow> = {};
      for (const row of rows) {
        // Include marketName in key — same SKU+platform can appear in multiple markets
        const key = `${row.sku}::${row.platformCode}::${row.marketName}`;
        map[key] = row;
      }
      await setCachedProfitMonth(month, map);
      results.push({ month, rows, fromCache: false });
      onProgress?.({ month, status: 'done' });
    } catch (err) {
      // Stale-while-revalidate: try cached data on failure
      console.warn(`[finance-profit] fetch failed for ${month}:`, err);
      const stale = await getCachedProfitMonth(month);
      if (stale) {
        results.push({ month, rows: Object.values(stale), fromCache: true });
      }
      onProgress?.({ month, status: 'error' });
    }
  }

  return results;
}

// ---- Step 6: aggregateBySku ----

/** Strip variant suffixes (-DT-X-SA1, -SA1) to get the base SKU. */
function baseSku(sku: string): string {
  return sku.replace(/-DT-[A-Z]-SA1$/, '').replace(/-SA1$/, '');
}

/** Aggregate MonthProfitData[] into per-SKU summaries.
 *  Sums netProfit across all platformCodes for each SKU per month.
 *  Merges variant SKUs (e.g. HC586TX-DT-T-SA1) into the base SKU.
 *  Computes cumulativeProfit, avgMonthlyProfit, trend. */
export function aggregateBySku(data: MonthProfitData[]): SkuProfitSummary[] {
  const skuMap = new Map<string, {
    productName: string; brand: string; category: string; sellingManagerName: string;
    monthlyProfit: Record<string, number>;
    channelBreakdown: Record<string, Record<string, number>>;
  }>();

  for (const md of data) {
    for (const row of md.rows) {
      const key = baseSku(row.sku);
      let entry = skuMap.get(key);
      if (!entry) {
        entry = {
          productName: row.productName || row.sku,
          brand: row.brand,
          category: row.category,
          sellingManagerName: row.sellingManagerName,
          monthlyProfit: {},
          channelBreakdown: {},
        };
        skuMap.set(key, entry);
      }
      // Prefer a real productName over the SKU fallback, regardless of row order
      if (row.productName) {
        entry.productName = row.productName;
      }

      entry.monthlyProfit[md.month] =
        (entry.monthlyProfit[md.month] || 0) + row.netProfit;

      if (!entry.channelBreakdown[md.month]) {
        entry.channelBreakdown[md.month] = {};
      }
      entry.channelBreakdown[md.month][row.platformCode] =
        (entry.channelBreakdown[md.month][row.platformCode] || 0) + row.netProfit;
    }
  }

  const months = data.map(d => d.month).sort();

  const result: SkuProfitSummary[] = [];
  for (const [sku, e] of skuMap) {
    // 月均/趋势口径（07-30 设计）：值为 0 是有效数据（保本），"当月"是部分月剔除，
    // 无行的月份 = 未上架（无数据），不进分母也不参与趋势。
    const currentMonth = getLocalMonth();
    const hasData = (m: string) => m in e.monthlyProfit;

    let cumulativeProfit = 0; // 累计：全部月份（含当月部分月）
    let completedSum = 0, completedCount = 0;
    let firstProfitIdx = -1;
    const trendValues: number[] = [];
    months.forEach(function (m, i) {
      const v = e.monthlyProfit[m] || 0;
      cumulativeProfit += v;
      const isCurrent = m === currentMonth;
      const present = hasData(m);
      if (!isCurrent && present) {
        completedSum += v;
        completedCount++;
        if (firstProfitIdx < 0 && v > 0) firstProfitIdx = i;
      }
    });
    for (let i = 0; i < months.length; i++) {
      const m = months[i]!;
      if (m === currentMonth || !hasData(m) || i === firstProfitIdx) continue;
      trendValues.push(e.monthlyProfit[m] || 0);
    }
    const avgMonthlyProfit = completedCount > 0 ? completedSum / completedCount : 0;

    let trend: number | null = null;
    if (trendValues.length >= 6) {
      const last3 = trendValues.slice(-3);
      const prior3 = trendValues.slice(-6, -3);
      const avgLast3 = last3.reduce((a, b) => a + b, 0) / 3;
      const avgPrior3 = prior3.reduce((a, b) => a + b, 0) / 3;
      if (avgPrior3 !== 0) {
        trend = ((avgLast3 - avgPrior3) / Math.abs(avgPrior3)) * 100;
      }
    }

    result.push({
      sku, productName: e.productName, brand: e.brand,
      category: e.category, sellingManagerName: e.sellingManagerName,
      monthlyProfit: e.monthlyProfit,
      channelBreakdown: e.channelBreakdown,
      cumulativeProfit, avgMonthlyProfit, trend,
    });
  }

  result.sort((a, b) => b.cumulativeProfit - a.cumulativeProfit);
  return result;
}
