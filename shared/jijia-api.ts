// shared/jijia-api.ts
import { readErpJson } from './erp-errors';

// 积加销售/库存接口的分页抓取。抽到一处供 jijia-data 与 jijia-transfer-data 共用，
// 修复两份拷贝各自漏掉翻页导致的多市场行静默截断（variationAsinView 每行 = SKU×市场，
// pageQuery 每行 = SKU×仓库，一页都取不满）。

const GATEWAY = 'https://gateway.apist.gerpgo.com';
const FETCH_TIMEOUT = 15_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

/** N 天前的日期（YYYY-MM-DD），按本地时区而非 UTC——团队在 UTC+8，
 *  toISOString() 在凌晨 0-8 点会给出"昨天"，导致统计窗口整体偏移一天。 */
export function localDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function postJson(url: string, body: unknown, token: string, dataset: string, signal?: AbortSignal): Promise<{
  data?: { rows?: unknown[] };
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(body),
    signal: signal || ctrl.signal,
  });
  clearTimeout(timer);
  // 401/403/权限消息 → 带数据集名的类型化错误，UI 据此提示找管理员
  return readErpJson(resp, dataset);
}

interface FetchRowsOpts {
  /** 按 SKU 查询（采购侧） */
  skuList?: string[];
  /** 按 ASIN 查询（调拨侧） */
  asinList?: string[];
  beginDays: number;
  token: string;
  signal?: AbortSignal;
}

/** 销售表现 asinView（ASIN维度），翻页直到短页。行 = ASIN×市场。
 *  2026-08-28 活体探针：variationAsinView（父ASIN维度）对 UK 自 08-01 起丢失
 *  sessions/pageViews/cvr/buyBox，且部分市场（DE 30d 2590 vs 页面 7119）流量偏低；
 *  asinView 与 ERP"销售表现"页面同源，数据完好。同 SKU×市场可能多行（多个 listing），
 *  由调用方按字段性质合并（见 jijia-data.mergeMarketRows）。 */
export async function fetchAsinViewRows<T = Record<string, unknown>>(
  opts: FetchRowsOpts,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await postJson(`${GATEWAY}/v3/statistics/salesAnalysis/asinView`, {
      currency: 'YUAN', groupByType: 'asin', isShowTotal: false,
      // ERP"近N天"口径 = 今天−(N−1) ~ 今天 的闭区间N天（2026-08-25 实测页面日期控件
      // 与 averageDailySales=units/N 双重印证）；多算一天会让 N 天均值偏大 ~1/N
      beginDate: localDaysAgo(Math.max(0, opts.beginDays - 1)), endDate: localDaysAgo(0),
      keywordsSearch: { selectType: 1, asinList: opts.asinList ?? [] },
      ...(opts.skuList ? { skuList: opts.skuList } : {}),
      isRingRatio: false, sort: 'unitsOrdered', order: 'descend',
      page, pagesize: PAGE_SIZE,
    }, opts.token, '销售分析数据', opts.signal);
    const pageRows = (json.data?.rows ?? []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }
  return rows;
}

/** 库存 pageQuery，翻页直到短页。行 = SKU×仓库。 */
export async function fetchInventoryRows<T = Record<string, unknown>>(
  skus: string[],
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await postJson(`${GATEWAY}/supply/gip/inv/warehouseProductInventory/pageQuery`, {
      productStatusList: [0], arriveCostSymbol: '0', purchaseCostSymbol: '0',
      storageCostAuthority: 'fifo', state: 1, filterQuantity: true, skuSummary: false,
      sellingManagerIdList: [], page, pagesize: PAGE_SIZE, skuList: skus,
    }, token, '库存数据', signal);
    const pageRows = (json.data?.rows ?? []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }
  return rows;
}
