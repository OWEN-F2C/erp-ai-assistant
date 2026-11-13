import { getSettings } from '../../shared/settings';
import { getAuthToken } from '../../shared/auth';
import { mapWithLimit } from '../../shared/concurrency';
import { ErpApiError, erpErrorNoticeHtml, dataWarningHtml } from '../../shared/erp-errors';
import { searchSkuProducts, fetchCountryServers, fetchPlatformMarkets, platformMarketWarehouses } from '../../shared/api-client';
import type { SkuProduct, CountryServer, PlatformMarket } from '../../shared/api-client';
import { fetchAndSummarize, buildAiPrompt, fetchMultiChannelAverages, applyMultiChannelToSummaries } from '../../shared/jijia-data';
import type { SkuSummary, MultiChannelDaily } from '../../shared/jijia-data';
import { streamChat } from '../../shared/llm-client';
import { parseLlmResponse } from '../../shared/llm-parser';
import { addLog, updateLastLog } from '../../shared/analysis-log';
import { normalizeUiScale } from '../../shared/ui-scale';
import { versionBadgeHtml } from '../../shared/panel-version';
import { PANEL_BUILD } from '../../shared/panel-dedup';
import { renderCurve } from './visualization';
import type { CurveInput } from './visualization';
import { generatePdfReport } from './pdf';
import { submitAndReport } from './submit-plan';
import { loadHistory, saveHistory, deleteHistory, type HistoryEntry } from './history';
import type { LlmSuggestion } from '../types';
import type { MarketGroup } from '../../shared/types';
import { computePurchaseQty, padWeeklyForecast } from './quantity';
import { riskLevelFromRemainingDays } from '../../shared/qty-formula';

export interface GenResult {
  scope: string;  // "global" | "DE:Yaoshu" | ...
  suggestion: LlmSuggestion;
  productInfo: SkuProduct;
  /** Real FBA available stock from fetchAndSummarize (search API has none) */
  currentStock: number;
  /** Real FBA in-transit stock from fetchAndSummarize */
  inTransit: number;
  /** Real box quantity from fetchAndSummarize (search API placeholder is 1) */
  boxQty: number;
  planQty: number;
  boxes: number;
  /** Resolved predicted daily sales used by the quantity formula (0 = no sales). */
  daily: number;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PANEL_CSS = `
.erp-gen-panel {
  position: sticky; top: 8px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  font-size: 12px; color: #334155; overflow: hidden;
  margin-bottom: 12px;
}
.erp-gen-header {
  padding: 14px 18px; background: #fafbfc;
  border-bottom: 1px solid #f1f5f9;
  display: flex; align-items: center; gap: 10px;
}
.erp-gen-header h3 { margin:0; font-size:14px; font-weight:600; color:#1e293b; }
.erp-gen-badge {
  background: #e0e7ff; color: #6366f1;
  border-radius: 10px; font-size: 10px; font-weight: 600;
  padding: 2px 8px;
}
.erp-gen-section { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
.erp-gen-section-title {
  font-size: 11px; font-weight: 600; color: #64748b;
  margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;
}
.erp-gen-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.erp-gen-label { font-size: 11px; color: #64748b; white-space: nowrap; }
.erp-gen-input {
  border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 6px 10px; font-size: 12px; outline: none;
  background: #fff; color: #334155;
}
.erp-gen-input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
.erp-gen-wh-option--hover,
.erp-gen-wh-option:hover { background: #f1f5f9; }
.erp-gen-btn {
  padding: 8px 18px; border: none; border-radius: 8px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  transition: all 0.15s;
}
.erp-gen-btn-primary {
  background: #6366f1; color: #fff;
}
.erp-gen-btn-primary:hover { background: #4f46e5; }
.erp-gen-btn-primary:disabled { background: #94a3b8; cursor: not-allowed; }
.erp-gen-btn-secondary {
  background: #fff; color: #6366f1; border: 1px solid #e2e8f0;
}
.erp-gen-result-hidden { display: none; }
.erp-gen-platform-group {
  border-left: 3px solid var(--erp-pl-color, #cbd5e1);
  padding-left: 8px; margin-bottom: 8px;
}
.erp-gen-platform-head {
  display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
}
.erp-gen-platform-name { font-weight: 600; font-size: 11px; color: #1e293b; }
.erp-gen-platform-count { font-size: 9px; color: #94a3b8; }
.erp-gen-platform-all {
  font-size: 9px; color: #6366f1; cursor: pointer; user-select: none; margin-left: auto;
}
.erp-gen-country-row { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.erp-gen-pill:active { transform: scale(0.96); }
.erp-gen-sites-filter {
  width: 100%; box-sizing: border-box; border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 4px 8px; font-size: 11px; margin-bottom: 8px; outline: none; color: #334155;
}
.erp-gen-sites-filter:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
#erp-gen-sites-list { max-height: 320px; overflow-y: auto; padding-right: 4px; }
@media (prefers-reduced-motion: reduce) { .erp-gen-pill { transition: none; } }
`;

// === Module-level state (persists across SPA tab switches that destroy/recreate the panel) ===
let _mode = 'single';
let _warehouseId = '';
let _warehouseLabel = '';
let _productionDays = 30;
let _shippingDays = 25;
let _sellUntilDate = '';
let _bufferDays = 15;
const _selectedSkus = new Map<string, SkuProduct>();
const _selectedSites = new Set<string>();
let _countryServers: CountryServer[] = [];
let _platformMarkets: PlatformMarket[] = [];
const _siteLabels = new Map<string, string>();
let _allResults: GenResult[] = [];
let _hasResults = false;
let _resultsHTML = '';
let _curveSelection: string[] = ['__all__'];
let _curveUnmount: (() => void) | null = null;
// 每次 render()（SPA 重注入）的生命周期信号：abort 后自动移除上一次挂到
// document/window 级的监听器，避免闭包持有整棵旧 panel DOM 造成累积泄漏
let _panelLifecycle: AbortController | null = null;

/** Load the full warehouse tree into the custom dropdown (all warehouse types). */
type WarehouseOption = { label: string; id: string };

async function loadWarehouses(
  listEl: HTMLElement,
  warehouseMap: Map<string, string>,
  allOptions: WarehouseOption[],
  doc: Document,
): Promise<void> {
  try {
    const token = getAuthToken(doc);
    if (!token) throw new Error('no auth token');

    const resp = await fetch(
      'https://gateway.apist.gerpgo.com/gipx/common/warehouseSelection/universal/dropdown/newBox',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({
          fba: true, wfs: true,
          selfDomestic: true, selfOverseas: true,
          supplierDomestic: true, supplierOverseas: true,
          thirdDomestic: true, thirdOverseas: true,
          filterDisableStatus: true, showDeleteMarket: true,
          warehousePermissionFlag: true, platformInitFlag: true,
          thirdInitFlag: true, amazonAwd: true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!resp.ok) throw new Error(`Warehouse API ${resp.status}`);
    const json = await resp.json();
    const data: unknown[] = json.data || [];

    function walk(nodes: unknown[], path: string[]): void {
      for (const n of nodes) {
        const node = n as Record<string, unknown>;
        const title = String(node.title ?? node.label ?? '');
        const children = node.children as unknown[] | undefined;
        const key = node.key;
        if (children && children.length > 0) {
          walk(children, [...path, title]);
        } else if (key != null && title) {
          const label = [...path, title].join(' > ');
          warehouseMap.set(label, String(key));
          allOptions.push({ label, id: String(key) });
        }
      }
    }
    walk(data, []);

    renderWarehouseList(listEl, allOptions, '');
  } catch (e) {
    console.warn('[purchase-plan-generator] warehouse load failed:', e);
    listEl.innerHTML = '<div style="padding:12px;color:#94a3b8;text-align:center;font-size:12px;">加载仓库失败，请刷新重试</div>';
  }
}

function renderWarehouseList(listEl: HTMLElement, options: WarehouseOption[], filter: string): void {
  const q = filter.toLowerCase();
  const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:12px;color:#94a3b8;text-align:center;font-size:12px;">无匹配仓库</div>';
    return;
  }
  listEl.innerHTML = filtered.map(o => {
    // Highlight matching segments via naive case-insensitive highlight
    let html = o.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (q) {
      // Simple highlight: wrap matching substrings
      const idx = html.toLowerCase().indexOf(q);
      if (idx >= 0) {
        html = html.slice(0, idx) +
          '<b style="color:#6366f1;">' + html.slice(idx, idx + q.length) + '</b>' +
          html.slice(idx + q.length);
      }
    }
    return '<div class="erp-gen-wh-option" data-id="' + o.id + '" data-label="' +
      o.label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '" style="padding:6px 12px;cursor:pointer;font-size:12px;color:#334155;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'transition:background .15s;">' + html + '</div>';
  }).join('');
}

// Module-level: persist the entire panel container across SPA tab switches
let _savedContainer: HTMLElement | null = null;

export function render(_container: HTMLElement, ctx: unknown, doc?: Document): void {
  const d = doc || document;

  _panelLifecycle?.abort();
  _panelLifecycle = new AbortController();
  const lifecycle = { signal: _panelLifecycle.signal };

  // Inject CSS once
  if (!d.getElementById('erp-gen-css')) {
    const style = d.createElement('style');
    style.id = 'erp-gen-css';
    style.textContent = PANEL_CSS;
    d.head.appendChild(style);
  }

  // Find the page content container
  const pageRoot = d.querySelector('.srm-pe-body-table') ||
    d.querySelector('.arco-form')?.parentElement ||
    d.body;

  const container = d.createElement('div');

  const panel = d.createElement('div');
  panel.className = 'erp-gen-panel';
  panel.dataset.erpBuild = PANEL_BUILD;
  // 面板整体缩放（设置→界面；ctx 由 content.ts 注入 settings 快照）
  panel.style.zoom = String(normalizeUiScale(
    ((ctx as { settings?: { uiScale?: number } })?.settings)?.uiScale ?? 1));
  panel.innerHTML = `
    <div class="erp-gen-header">
      <h3>采购计划生成器</h3>
      <span class="erp-gen-badge">BETA</span>
      ${versionBadgeHtml()}
    </div>
    <div class="erp-gen-section" id="erp-gen-history-section">
      <div class="erp-gen-section-title">历史记录</div>
      <div id="erp-gen-history-list" style="margin-top:4px;max-height:none;overflow-y:visible;font-size:11px;color:#94a3b8;">暂无记录</div>
    </div>
    <div class="erp-gen-section">
      <div class="erp-gen-section-title">模式</div>
      <div class="erp-gen-row">
        <label style="font-size:12px;cursor:pointer;">
          <input type="radio" name="erp-gen-mode" value="single" checked> 单仓计划
        </label>
        <label style="font-size:12px;color:#94a3b8;cursor:not-allowed;">
          <input type="radio" name="erp-gen-mode" value="multi" disabled> 多仓计划(待开放)
        </label>
      </div>
    </div>
    <div class="erp-gen-section">
      <div class="erp-gen-section-title">目的仓</div>
      <div class="erp-gen-input" id="erp-gen-warehouse-trigger"
           style="display:flex;align-items:center;cursor:pointer;padding-right:28px;
                  position:relative;user-select:none;">
        <span id="erp-gen-warehouse-text" style="color:#94a3b8;overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap;">请选择目的仓</span>
        <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);
          color:#94a3b8;font-size:10px;transition:transform .2s;" id="erp-gen-warehouse-arrow">▼</span>
      </div>
      <input type="hidden" id="erp-gen-warehouse-id">
    </div>
    <div class="erp-gen-section" id="erp-gen-search-section" style="display:none;">
      <div class="erp-gen-section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>搜索SKU</span>
        <button id="erp-gen-clear-skus" style="font-size:10px;padding:2px 8px;border:1px solid #e2e8f0;
          border-radius:4px;background:#fff;color:#94a3b8;cursor:pointer;display:none;">清空已选</button>
      </div>
      <input class="erp-gen-input" id="erp-gen-search" type="text"
        placeholder="输入SKU或产品名搜索…" style="width:100%;box-sizing:border-box;" disabled>
      <div id="erp-gen-search-results" style="max-height:200px;overflow-y:auto;margin-top:8px;"></div>
    </div>
    <div class="erp-gen-section" id="erp-gen-params-section" style="display:none;">
      <div class="erp-gen-section-title">参数设置</div>
      <div class="erp-gen-row">
        <span class="erp-gen-label">生产</span>
        <input class="erp-gen-input" id="erp-gen-production" type="number" value="30" min="0" max="365" style="width:52px;">
        <span class="erp-gen-label">天 头程</span>
        <input class="erp-gen-input" id="erp-gen-shipping" type="number" value="25" min="0" max="365" style="width:52px;">
        <span class="erp-gen-label">天 卖到</span>
        <input class="erp-gen-input" id="erp-gen-selluntil" type="date" style="width:130px;">
        <span class="erp-gen-label">冗余</span>
        <input class="erp-gen-input" id="erp-gen-buffer" type="number" value="15" min="0" max="365" style="width:52px;">
        <span class="erp-gen-label">天</span>
      </div>
    </div>
    <div class="erp-gen-section" id="erp-gen-sites-section" style="display:none;">
      <div class="erp-gen-section-title">站点选择（全渠道仅供图表参考，站点计划可提交）</div>
      <input class="erp-gen-sites-filter" id="erp-gen-sites-filter" type="text" placeholder="筛选店铺…">
      <div id="erp-gen-sites-list"></div>
    </div>
    <div class="erp-gen-section">
      <button class="erp-gen-btn erp-gen-btn-primary" id="erp-gen-generate" disabled>
        请先选择仓库并搜索SKU
      </button>
    </div>
    <div id="erp-gen-results" class="erp-gen-result-hidden"></div>
  `;

  container.appendChild(panel);
  pageRoot.insertBefore(container, pageRoot.firstChild);

  // Default sellUntil date = today + 90 days (use saved state if available)
  const sellUntilInput = panel.querySelector('#erp-gen-selluntil') as HTMLInputElement;
  if (_sellUntilDate) {
    sellUntilInput.value = _sellUntilDate;
  } else {
    const today = new Date();
    today.setDate(today.getDate() + 90);
    sellUntilInput.value =
      today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
  }

  // Warehouse loading
  const warehouseTrigger = panel.querySelector('#erp-gen-warehouse-trigger') as HTMLElement;
  const warehouseText = panel.querySelector('#erp-gen-warehouse-text') as HTMLElement;
  const warehouseArrow = panel.querySelector('#erp-gen-warehouse-arrow') as HTMLElement;
  const warehouseIdInput = panel.querySelector('#erp-gen-warehouse-id') as HTMLInputElement;

  // === History records（持久化在 ./history.ts，含配额保护） ===
  async function saveHistoryAndRefresh(entry: Parameters<typeof saveHistory>[0]) {
    try {
      renderHistoryList(await saveHistory(entry));
    } catch (e: any) {
      addLog('warn', '历史记录保存失败（存储配额不足？）: ' + (e.message || ''));
    }
  }

  async function deleteHistoryAndRefresh(id: number) {
    renderHistoryList(await deleteHistory(id));
  }

  // Render history list UI
  const historyList = panel.querySelector('#erp-gen-history-list') as HTMLElement;

  function renderHistoryList(history: HistoryEntry[]) {
    if (history.length === 0) {
      historyList.innerHTML = '<span style="color:#94a3b8;">暂无记录</span>';
      return;
    }
    historyList.innerHTML = history.map(h => {
      const d = new Date(h.createdAt);
      const dateStr = String(d.getMonth() + 1).padStart(2, '0') + '/' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
      return '<div style="display:inline-flex;align-items:center;gap:4px;' +
        'padding:3px 8px 3px 10px;margin:0 4px 4px 0;border-radius:14px;' +
        'background:#f1f5f9;border:1px solid #e2e8f0;font-size:11px;white-space:nowrap;">' +
        '<span style="color:#475569;" title="' + h.label + '">' + h.label + '</span>' +
        '<span style="color:#94a3b8;">' + dateStr + '</span>' +
        '<button class="erp-gen-history-fill" data-id="' + h.id +
        '" style="font-size:10px;padding:1px 6px;border:1px solid #6366f1;color:#6366f1;' +
        'background:#fff;border-radius:8px;cursor:pointer;">填充</button>' +
        '<button class="erp-gen-history-del" data-id="' + h.id +
        '" style="font-size:11px;padding:0 4px;border:none;color:#94a3b8;' +
        'background:transparent;cursor:pointer;line-height:1;">×</button>' +
        '</div>';
    }).join('');

    // Wire fill buttons
    historyList.querySelectorAll('.erp-gen-history-fill').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number((btn as HTMLElement).dataset.id);
        const h = (await loadHistory()).find(x => x.id === id);
        if (!h) return;
        // Fill mode
        const modeRadio = panel.querySelector('input[name="erp-gen-mode"][value="' + h.mode + '"]') as HTMLInputElement;
        if (modeRadio) modeRadio.checked = true;
        _mode = h.mode;
        // Fill warehouse
        warehouseIdInput.value = h.warehouseId;
        warehouseText.textContent = h.warehouseLabel || '请选择目的仓';
        warehouseText.style.color = '#1e293b';
        _warehouseId = h.warehouseId;
        _warehouseLabel = h.warehouseLabel;
        // Fill params
        _productionDays = h.productionDays;
        _shippingDays = h.shippingDays;
        _sellUntilDate = h.sellUntilDate;
        _bufferDays = h.bufferDays;
        (panel.querySelector('#erp-gen-production') as HTMLInputElement).value = String(h.productionDays);
        (panel.querySelector('#erp-gen-shipping') as HTMLInputElement).value = String(h.shippingDays);
        (panel.querySelector('#erp-gen-selluntil') as HTMLInputElement).value = h.sellUntilDate;
        (panel.querySelector('#erp-gen-buffer') as HTMLInputElement).value = String(h.bufferDays);
        // Fill sites — show sections, load sites if needed, then click pills
        updateParamsVisibility();
        selectedSites.clear();
        if (countryServers.length === 0) await loadSites();
        // Click each saved site's pill to properly trigger selection state
        for (const s of h.selectedSites) {
          const pill = sitesList.querySelector('.erp-gen-pill[data-site="' + CSS.escape(s) + '"]') as HTMLElement;
          if (pill) pill.click();
        }
        // Fill SKUs — render directly from saved data
        if (h.selectedSkus.length > 0) {
          selectedSkus.clear();
          for (const s of h.selectedSkus) selectedSkus.set(s.sku, { sku: s.sku, productName: s.productName, asin: s.asin });
          const searchSection = panel.querySelector('#erp-gen-search-section') as HTMLElement;
          searchSection.style.display = '';
          searchInput.disabled = false;
          // Render saved SKUs as checked checkboxes
          searchResultsDiv.innerHTML = h.selectedSkus.map(p =>
            '<label style="display:flex;align-items:center;gap:8px;padding:8px 0;' +
            'border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:11px;">' +
            '<input type="checkbox" data-sku="' + escapeAttr(p.sku) + '" checked>' +
            '<span>' + escapeHtml(p.sku) + '</span>' +
            '<span style="color:#94a3b8;margin-left:auto;">' + escapeHtml(p.productName) + '</span>' +
            '</label>'
          ).join('');
          searchResultsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
              const sku = (cb as HTMLInputElement).dataset.sku!;
              if ((cb as HTMLInputElement).checked) {
                const s = h.selectedSkus.find(x => x.sku === sku);
                if (s) selectedSkus.set(sku, s);
              } else {
                selectedSkus.delete(sku);
              }
              updateGenerateButton();
            });
          });
        }
        updateGenerateButton();
        updateParamsVisibility();
        // Auto-trigger search to show matching SKU variants in the results list
        if (h.selectedSkus.length > 0) {
          searchInput.value = h.selectedSkus[0].sku;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Restore previously generated results
        if (h.resultsHTML) {
          const dataSource = h.allResults?.length ? h.allResults : _allResults;
          _resultsHTML = h.resultsHTML;
          if (h.allResults?.length) _allResults = h.allResults;
          _hasResults = true;
          resultsDiv.className = 'erp-gen-section';
          resultsDiv.innerHTML = h.resultsHTML;
          // Re-render curve — restore saved filter selection and re-wire changes
          if (dataSource.length > 0) {
            const curveContainer = resultsDiv.querySelector('#erp-gen-curve-container') as HTMLElement;
            const filterSelect = resultsDiv.querySelector('#erp-gen-curve-filter') as HTMLSelectElement;
            if (curveContainer && filterSelect) {
              applyCurveSelection(filterSelect);
              filterSelect.addEventListener('change', () => renderFilteredCurve(curveContainer, filterSelect, dataSource));
              setTimeout(() => renderFilteredCurve(curveContainer, filterSelect, dataSource), 300);
            }
          }
          // Re-wire row expansion + submit buttons in restored results
          wireResultRows(resultsDiv, dataSource);
        }
      });
    });

    // Wire delete buttons
    historyList.querySelectorAll('.erp-gen-history-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number((btn as HTMLElement).dataset.id);
        await deleteHistoryAndRefresh(id);
      });
    });
  }

  // Load initial history
  loadHistory().then(renderHistoryList);

  const warehouseMap = new Map<string, string>(); // label → id
  const warehouseOptions: WarehouseOption[] = [];

  // Build the dropdown portal element (appended to body on open)
  const dropdownEl = d.createElement('div');
  dropdownEl.id = 'erp-gen-warehouse-dropdown';
  dropdownEl.style.cssText =
    'display:none;position:fixed;z-index:2147483640;background:#fff;' +
    'border:1px solid #e2e8f0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.12);' +
    'max-height:340px;overflow:hidden;';
  dropdownEl.innerHTML =
    '<div style="padding:8px;border-bottom:1px solid #f1f5f9;">' +
      '<input id="erp-gen-warehouse-search" placeholder="搜索仓库…" ' +
        'style="width:100%;border:1px solid #e2e8f0;border-radius:4px;' +
        'padding:6px 10px;font-size:12px;outline:none;box-sizing:border-box;">' +
    '</div>' +
    '<div id="erp-gen-warehouse-list" style="max-height:270px;overflow-y:auto;padding:4px 0;"></div>';
  const warehouseSearch = dropdownEl.querySelector('#erp-gen-warehouse-search') as HTMLInputElement;
  const warehouseList = dropdownEl.querySelector('#erp-gen-warehouse-list') as HTMLElement;

  loadWarehouses(warehouseList, warehouseMap, warehouseOptions, d);

  // Custom dropdown open/close (portal to body)
  let warehouseOpen = false;
  function repositionDropdown(): void {
    const rect = warehouseTrigger.getBoundingClientRect();
    dropdownEl.style.top = (rect.bottom + 4) + 'px';
    dropdownEl.style.left = rect.left + 'px';
    dropdownEl.style.width = rect.width + 'px';
  }
  function openWarehouseDropdown(): void {
    warehouseOpen = true;
    repositionDropdown();
    dropdownEl.style.display = '';
    d.body.appendChild(dropdownEl);
    warehouseArrow.style.transform = 'translateY(-50%) rotate(180deg)';
    warehouseSearch.value = '';
    renderWarehouseList(warehouseList, warehouseOptions, '');
    setTimeout(() => warehouseSearch.focus(), 50);
  }
  function closeWarehouseDropdown(): void {
    warehouseOpen = false;
    dropdownEl.style.display = 'none';
    if (dropdownEl.parentNode) dropdownEl.parentNode.removeChild(dropdownEl);
    warehouseArrow.style.transform = 'translateY(-50%) rotate(0deg)';
  }
  warehouseTrigger.addEventListener('click', () => {
    warehouseOpen ? closeWarehouseDropdown() : openWarehouseDropdown();
  });
  warehouseSearch.addEventListener('input', () => {
    renderWarehouseList(warehouseList, warehouseOptions, warehouseSearch.value);
  });
  // Click option
  warehouseList.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest('.erp-gen-wh-option') as HTMLElement | null;
    if (!opt) return;
    const label = opt.dataset.label!;
    const id = opt.dataset.id!;
    warehouseText.textContent = label;
    warehouseText.style.color = '#334155';
    warehouseIdInput.value = id;
    _warehouseId = id;
    _warehouseLabel = label;
    const hintEl = panel.querySelector('#erp-gen-wh-hint') as HTMLElement | null;
    if (hintEl) hintEl.remove();
    closeWarehouseDropdown();
    searchSection.style.display = '';
    searchInput.disabled = false;
    searchInput.placeholder = '输入SKU或产品名搜索…';
  });
  // Hover highlight
  warehouseList.addEventListener('mouseover', (e) => {
    const prev = warehouseList.querySelector('.erp-gen-wh-option--hover');
    if (prev) prev.classList.remove('erp-gen-wh-option--hover');
    const opt = (e.target as HTMLElement).closest('.erp-gen-wh-option');
    if (opt) opt.classList.add('erp-gen-wh-option--hover');
  });
  // Click outside to close
  d.addEventListener('click', (e) => {
    if (warehouseOpen && !warehouseTrigger.contains(e.target as Node) && !dropdownEl.contains(e.target as Node)) {
      closeWarehouseDropdown();
    }
  }, lifecycle);
  // Reposition on scroll/resize (don't reset search)
  d.defaultView?.addEventListener('scroll', () => repositionDropdown(), { capture: true, ...lifecycle });
  d.defaultView?.addEventListener('resize', () => repositionDropdown(), lifecycle);
  // Keyboard
  warehouseSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeWarehouseDropdown(); warehouseTrigger.focus(); }
    if (e.key === 'Enter') {
      const first = warehouseList.querySelector('.erp-gen-wh-option') as HTMLElement | null;
      if (first) first.click();
    }
  });

  // Wire warehouse change → enable search
  const searchSection = panel.querySelector('#erp-gen-search-section') as HTMLElement;
  const paramsSection = panel.querySelector('#erp-gen-params-section') as HTMLElement;
const searchInput = panel.querySelector('#erp-gen-search') as HTMLInputElement;
  const generateBtn = panel.querySelector('#erp-gen-generate') as HTMLButtonElement;

  // Save param changes to module-level state (survives tab switches)
  (panel.querySelector('#erp-gen-production') as HTMLInputElement).addEventListener('input', function () {
    _productionDays = parseInt(this.value, 10) || 30;
  });
  (panel.querySelector('#erp-gen-shipping') as HTMLInputElement).addEventListener('input', function () {
    _shippingDays = parseInt(this.value, 10) || 25;
  });
  sellUntilInput.addEventListener('input', function () {
    _sellUntilDate = this.value;
  });
  (panel.querySelector('#erp-gen-buffer') as HTMLInputElement).addEventListener('input', function () {
    _bufferDays = parseInt(this.value, 10) || 15;
  });
  // Save mode changes
  panel.querySelectorAll('input[name="erp-gen-mode"]').forEach(radio => {
    radio.addEventListener('change', function () {
      _mode = (this as HTMLInputElement).value;
    });
  });

  // --- SKU Search ---
  const searchResultsDiv = panel.querySelector('#erp-gen-search-results') as HTMLElement;
  const selectedSkus = _selectedSkus;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0; // guards against stale responses overwriting newer ones

  searchInput.addEventListener('input', () => {
    const kw = searchInput.value.trim();
    if (kw.length < 2) {
      searchResultsDiv.innerHTML = '';
      return;
    }
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(kw), 300);
  });

  async function doSearch(keyword: string): Promise<void> {
    const seq = ++searchSeq;
    searchResultsDiv.innerHTML = '<div style="padding:8px;color:#94a3b8;font-size:11px;">搜索中…</div>';
    try {
      const token = getAuthToken(d);
      if (!token) throw new Error('no auth token');
      const warehouseId = Number(warehouseIdInput.value);
      const products = await searchSkuProducts(keyword, warehouseId, token, AbortSignal.timeout(15000));
      if (seq !== searchSeq) return; // stale response — a newer search superseded this one
      if (products.length === 0) {
        searchResultsDiv.innerHTML = '<div style="padding:8px;color:#94a3b8;font-size:11px;">无匹配结果</div>';
        return;
      }
      renderSearchResults(products);
    } catch (e: any) {
      if (seq !== searchSeq) return;
      searchResultsDiv.innerHTML =
        '<div style="padding:8px;color:#ef4444;font-size:11px;">搜索失败: ' +
        escapeHtml(e.message || '未知错误') + '</div>';
    }
  }

  function renderSearchResults(products: SkuProduct[]): void {
    let html = '';
    for (const p of products) {
      const checked = selectedSkus.has(p.sku) ? 'checked' : '';
      html +=
        '<label style="display:flex;align-items:center;gap:8px;padding:8px 0;' +
        'border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:11px;">' +
          '<input type="checkbox" data-sku="' + escapeAttr(p.sku) + '" ' + checked + '>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:500;color:#1e293b;">' + escapeHtml(p.sku) + '</div>' +
            '<div style="color:#94a3b8;">' + escapeHtml(p.productName) + '</div>' +
          '</div>' +
        '</label>';
    }
    searchResultsDiv.innerHTML = html;

    // Wire checkboxes
    searchResultsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const sku = (cb as HTMLInputElement).dataset.sku!;
        if ((cb as HTMLInputElement).checked) {
          const prod = products.find(p => p.sku === sku);
          if (prod) selectedSkus.set(sku, prod);
        } else {
          selectedSkus.delete(sku);
        }
        updateGenerateButton();
        updateParamsVisibility();
      });
    });

    updateGenerateButton();
    updateParamsVisibility();
  }

  // Clear SKU button
  const clearSkusBtn = panel.querySelector('#erp-gen-clear-skus') as HTMLButtonElement;
  clearSkusBtn.addEventListener('click', () => {
    selectedSkus.clear();
    searchResultsDiv.innerHTML = '';
    updateGenerateButton();
    updateParamsVisibility();
  });

  function updateGenerateButton(): void {
    clearSkusBtn.style.display = selectedSkus.size > 0 ? '' : 'none';
    if (selectedSkus.size > 0) {
      generateBtn.disabled = false;
      const scopes = selectedSites.size > 0 ? (selectedSites.size + 1) : 1;
      generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU × ' + scopes + ' 范围)';
    } else {
      generateBtn.disabled = true;
      generateBtn.textContent = '请先选择仓库并搜索SKU';
    }
  }

  function updateParamsVisibility(): void {
    paramsSection.style.display = selectedSkus.size > 0 ? '' : 'none';
    if (selectedSkus.size > 0 && countryServers.length === 0) {
      loadSites();
    }
    sitesSection.style.display = selectedSkus.size > 0 ? '' : 'none';
  }

  // --- Site selection (multi-scope support) ---
  let countryServers = _countryServers;
  let platformMarkets = _platformMarkets;
  const sitesSection = panel.querySelector('#erp-gen-sites-section') as HTMLElement;
  const sitesList = panel.querySelector('#erp-gen-sites-list') as HTMLElement;
  const selectedSites = _selectedSites;

  /** 降级继续类数据警告：点名缺失数据 + 对分析口径的影响，插在结果区上方 */
  function showDataWarning(title: string, consequence: string): void {
    let box = panel.querySelector('#erp-gen-data-warning') as HTMLElement | null;
    if (!box) {
      const results = panel.querySelector('#erp-gen-results') as HTMLElement | null;
      box = d.createElement('div');
      box.id = 'erp-gen-data-warning';
      if (results?.parentElement) results.parentElement.insertBefore(box, results);
      else panel.appendChild(box);
    }
    box.insertAdjacentHTML('beforeend', dataWarningHtml(title, consequence));
  }

  async function loadSites(): Promise<void> {
    const token = getAuthToken(d);
    if (!token) return;
    try {
      _countryServers = countryServers = await fetchCountryServers(token);
      for (const cs of countryServers) _siteLabels.set(cs.title, cs.title);
    } catch (e: any) {
      const reason = e instanceof ErpApiError && e.kind === 'permission' ? '疑似无权限' : (e.message || '网络错误');
      console.warn('[purchase-plan-generator] country servers load failed:', e);
      addLog('warn', '店铺/站点列表获取失败（' + reason + '）');
      showDataWarning('店铺/站点列表获取失败（' + reason + '）', '站点选择不可用，无法按站点生成计划');
    }
    try {
      _platformMarkets = platformMarkets = await fetchPlatformMarkets(token);
      for (const m of platformMarkets) _siteLabels.set(m.id, m.text);
    } catch (e: any) {
      const reason = e instanceof ErpApiError && e.kind === 'permission' ? '疑似无权限' : (e.message || '网络错误');
      console.warn('[purchase-plan-generator] platform markets load failed:', e);
      addLog('warn', '平台市场列表获取失败（' + reason + '）');
      showDataWarning('平台市场列表获取失败（' + reason + '）', '非亚马逊平台（TikTok 等）无法作为站点选择');
    }
    renderSiteCheckboxes();
  }

  /** Platform brand accent for group rails — encodes the platform's
   *  warehouse/submission semantics at a glance. */
  function platformColor(m: Pick<PlatformMarket, 'group'>): string {
    const g = m.group.toUpperCase();
    if (g.includes('TIKTOK')) return '#E0457B';
    if (g.includes('TEMU')) return '#D9480F';
    if (g.includes('SHOPIFY') || g.includes('INDEPENDENT')) return '#2F9E44';
    if (g.includes('WALMART')) return '#0071CE';
    return '#94a3b8';
  }

  function renderSiteCheckboxes(): void {
    let html = '<div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">' +
      '<span class="erp-gen-pill erp-gen-pill-on" style="font-size:10px;padding:2px 8px;border-radius:10px;' +
      'background:#6366f1;color:#fff;cursor:default;">全渠道</span>' +
      '<span style="font-size:10px;color:#94a3b8;">汇总数据，仅供图表参考</span></div>';

    const pillHtml = (site: string, label: string, extraAttr: string): string =>
      '<label class="erp-gen-pill" data-site="' + escapeAttr(site) + '"' + extraAttr +
        ' style="display:inline-block;font-size:10px;padding:2px 8px;border-radius:10px;' +
        'background:#f1f5f9;color:#64748b;cursor:pointer;transition:all .12s;' +
        'border:1px solid #e2e8f0;user-select:none;white-space:nowrap;">' +
        escapeHtml(label) + '</label>';

    // --- Amazon platform group: country sub-rows inside ---
    let amazonBody = '';
    const countryMap = new Map<string, CountryServer[]>();
    for (const cs of countryServers) {
      let list = countryMap.get(cs.country);
      if (!list) { list = []; countryMap.set(cs.country, list); }
      list.push(cs);
    }
    let ci = 0;
    for (const [country, stores] of countryMap) {
      const cid = 'erp-gen-country-' + (ci++);
      amazonBody += '<div class="erp-gen-country-row">' +
        '<div style="display:flex;align-items:center;gap:4px;min-width:56px;">' +
          '<span style="font-weight:600;font-size:10px;color:#475569;">' + escapeHtml(country) + '</span>' +
          '<span style="font-size:9px;color:#94a3b8;">' + stores.length + '</span>' +
          '<label style="font-size:9px;color:#6366f1;cursor:pointer;margin-left:2px;user-select:none;">' +
          '<input type="checkbox" class="erp-gen-country-cb" data-country="' + cid + '" style="display:none;">全选</label>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;flex:1;">';
      for (const cs of stores) {
        amazonBody += pillHtml(cs.title, cs.title.split(':').pop()!, ' data-country="' + cid + '"');
      }
      amazonBody += '</div></div>';
    }
    if (amazonBody) {
      html += '<div class="erp-gen-platform-group" data-platform="amazon" style="--erp-pl-color:#E47911;">' +
        '<div class="erp-gen-platform-head">' +
          '<span class="erp-gen-platform-name">Amazon</span>' +
          '<span class="erp-gen-platform-count">' + countryServers.length + ' 店</span>' +
          '<label class="erp-gen-platform-all">' +
          '<input type="checkbox" class="erp-gen-platform-cb" data-platform="amazon" style="display:none;">全选</label>' +
        '</div>' + amazonBody + '</div>';
    }

    // --- Non-Amazon platform groups (scope = market id; unmapped platforms hidden) ---
    const nonAmazon = platformMarkets.filter(
      (m) => m.group !== 'AMAZON' && platformMarketWarehouses(m) !== null,
    );
    const platformMap = new Map<string, PlatformMarket[]>();
    for (const m of nonAmazon) {
      const key = m.groupAlias || m.group;
      let list = platformMap.get(key);
      if (!list) { list = []; platformMap.set(key, list); }
      list.push(m);
    }
    let pi = 0;
    for (const [alias, list] of platformMap) {
      const pkey = 'erp-gen-platform-' + (pi++);
      const color = platformColor(list[0]);
      html += '<div class="erp-gen-platform-group" data-platform="' + pkey + '" style="--erp-pl-color:' + color + ';">' +
        '<div class="erp-gen-platform-head">' +
          '<span class="erp-gen-platform-name">' + escapeHtml(alias) + '</span>' +
          '<span class="erp-gen-platform-count">' + list.length + ' 店</span>' +
          '<label class="erp-gen-platform-all">' +
          '<input type="checkbox" class="erp-gen-platform-cb" data-platform="' + pkey + '" style="display:none;">全选</label>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
      for (const m of list) {
        html += pillHtml(m.id, (m.text.split(':')[0] || m.text), '');
      }
      html += '</div></div>';
    }
    sitesList.innerHTML = html;

    // De-emphasize abnormal stores (授权异常/已停用/已删除 suffixes)
    sitesList.querySelectorAll('.erp-gen-pill[data-site]').forEach(p => {
      const pill = p as HTMLElement;
      if (/异常|已停用|已删除/.test(pill.textContent || '')) pill.style.opacity = '0.55';
    });

    // Pill click toggles — preserve persisted selections across re-renders
    const pillEls = [...sitesList.querySelectorAll('.erp-gen-pill[data-site]')] as HTMLElement[];
    const savedSites = new Set(selectedSites);
    selectedSites.clear();

    for (const pill of pillEls) {
      // Restore persisted selection state
      if (savedSites.has(pill.dataset.site!)) {
        pill.classList.add('erp-gen-pill-on');
        pill.style.background = '#6366f1';
        pill.style.color = '#fff';
        pill.style.borderColor = '#6366f1';
        selectedSites.add(pill.dataset.site!);
      }
      pill.addEventListener('click', () => {
        const site = pill.dataset.site!;
        const on = pill.classList.toggle('erp-gen-pill-on');
        if (on) {
          selectedSites.add(site);
          pill.style.background = '#6366f1';
          pill.style.color = '#fff';
          pill.style.borderColor = '#6366f1';
        } else {
          selectedSites.delete(site);
          pill.style.background = '#f1f5f9';
          pill.style.color = '#64748b';
          pill.style.borderColor = '#e2e8f0';
        }
        maybeHintWarehouse(site, on);
        updateGenerateButton();
      });
    }

    // Country "全选" toggles
    sitesList.querySelectorAll('.erp-gen-country-cb').forEach(ccb => {
      ccb.addEventListener('change', () => {
        const cid = (ccb as HTMLInputElement).dataset.country!;
        const checked = (ccb as HTMLInputElement).checked;
        const pills = sitesList.querySelectorAll('.erp-gen-pill[data-country="' + cid + '"]');
        pills.forEach(p => {
          const pill = p as HTMLElement;
          if (checked) {
            pill.classList.add('erp-gen-pill-on');
            pill.style.background = '#6366f1';
            pill.style.color = '#fff';
            pill.style.borderColor = '#6366f1';
            selectedSites.add(pill.dataset.site!);
          } else {
            pill.classList.remove('erp-gen-pill-on');
            pill.style.background = '#f1f5f9';
            pill.style.color = '#64748b';
            pill.style.borderColor = '#e2e8f0';
            selectedSites.delete(pill.dataset.site!);
          }
        });
        updateGenerateButton();
      });
    });

    // Platform "全选" toggles
    sitesList.querySelectorAll('.erp-gen-platform-cb').forEach(pcb => {
      pcb.addEventListener('change', () => {
        const pkey = (pcb as HTMLInputElement).dataset.platform!;
        const checked = (pcb as HTMLInputElement).checked;
        const container = sitesList.querySelector(
          '.erp-gen-platform-group[data-platform="' + pkey + '"]',
        ) as HTMLElement | null;
        if (!container) return;
        container.querySelectorAll('.erp-gen-pill[data-site]').forEach(p => {
          const pill = p as HTMLElement;
          const isOn = pill.classList.contains('erp-gen-pill-on');
          if (checked && !isOn) {
            pill.classList.add('erp-gen-pill-on');
            pill.style.background = '#6366f1';
            pill.style.color = '#fff';
            pill.style.borderColor = '#6366f1';
            selectedSites.add(pill.dataset.site!);
          } else if (!checked && isOn) {
            pill.classList.remove('erp-gen-pill-on');
            pill.style.background = '#f1f5f9';
            pill.style.color = '#64748b';
            pill.style.borderColor = '#e2e8f0';
            selectedSites.delete(pill.dataset.site!);
          }
        });
        updateGenerateButton();
      });
    });

    // Store filter
    const filterInput = panel.querySelector('#erp-gen-sites-filter') as HTMLInputElement | null;
    if (filterInput) {
      filterInput.value = '';
      filterInput.oninput = () => {
        const q = filterInput.value.trim().toLowerCase();
        sitesList.querySelectorAll('.erp-gen-pill[data-site]').forEach(p => {
          const pill = p as HTMLElement;
          pill.style.display = !q || (pill.textContent || '').toLowerCase().includes(q) ? '' : 'none';
        });
        sitesList.querySelectorAll('.erp-gen-country-row').forEach(row => {
          const rowEl = row as HTMLElement;
          const visible = [...rowEl.querySelectorAll('.erp-gen-pill[data-site]')]
            .some(pill => (pill as HTMLElement).style.display !== 'none');
          rowEl.style.display = visible ? '' : 'none';
        });
        sitesList.querySelectorAll('.erp-gen-platform-group').forEach(g => {
          const gEl = g as HTMLElement;
          const visible = [...gEl.querySelectorAll('.erp-gen-pill[data-site]')]
            .some(pill => (pill as HTMLElement).style.display !== 'none');
          gEl.style.display = visible ? '' : 'none';
        });
      };
    }
    updateGenerateButton();
  }

  // Suggest the mapped domestic warehouse when a non-Amazon site is selected.
  function maybeHintWarehouse(site: string, on: boolean): void {
    const hint = panel.querySelector('#erp-gen-wh-hint') as HTMLElement | null;
    if (!on) {
      if (hint) hint.remove();
      return;
    }
    const m = platformMarkets.find((x) => x.id === site);
    if (!m) return;
    const mapping = platformMarketWarehouses(m);
    if (!mapping) return;
    if (_warehouseId) {
      if (hint) hint.remove();
      return;
    }
    if (!hint) {
      const newHint = d.createElement('div');
      newHint.id = 'erp-gen-wh-hint';
      newHint.style.cssText =
        'margin-top:6px;font-size:11px;color:#b45309;background:#fffbeb;' +
        'border:1px solid #fde68a;border-radius:6px;padding:6px 10px;cursor:pointer;';
      warehouseTrigger.parentElement!.insertBefore(newHint, warehouseTrigger.nextSibling);
      newHint.textContent = '建议目的仓：' + mapping.domesticWh +
        (mapping.overseasWh ? '（海外虚拟仓：' + mapping.overseasWh + '）' : '') + ' — 点击选择';
      newHint.onclick = () => {
        openWarehouseDropdown();
        const opt = [...warehouseList.querySelectorAll('.erp-gen-wh-option')]
          .find((o) => (o as HTMLElement).dataset.label?.includes(mapping.domesticWh)) as HTMLElement | undefined;
        if (opt) opt.click();
      };
      return;
    }
    hint.textContent = '建议目的仓：' + mapping.domesticWh +
      (mapping.overseasWh ? '（海外虚拟仓：' + mapping.overseasWh + '）' : '') + ' — 点击选择';
    hint.onclick = () => {
      openWarehouseDropdown();
      const opt = [...warehouseList.querySelectorAll('.erp-gen-wh-option')]
        .find((o) => (o as HTMLElement).dataset.label?.includes(mapping.domesticWh)) as HTMLElement | undefined;
      if (opt) opt.click();
    };
  }

  function collectParams(): { productionDays: number; shippingDays: number; sellUntilDate: string; bufferDays: number } | null {
    const productionDays = parseInt((panel.querySelector('#erp-gen-production') as HTMLInputElement).value, 10);
    const shippingDays = parseInt((panel.querySelector('#erp-gen-shipping') as HTMLInputElement).value, 10);
    const sellUntilDate = (panel.querySelector('#erp-gen-selluntil') as HTMLInputElement).value;
    const bufferDays = parseInt((panel.querySelector('#erp-gen-buffer') as HTMLInputElement).value, 10);

    if (Number.isNaN(productionDays) || Number.isNaN(shippingDays) || Number.isNaN(bufferDays) || !sellUntilDate) {
      return null;
    }

    // Warn if sell date is too close
    const sellUntil = new Date(sellUntilDate);
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + productionDays + shippingDays);
    if (sellUntil < minDate) {
      const confirmed = confirm(
        '卖到日期过近，建议至少覆盖生产+头程周期（' +
        (productionDays + shippingDays) + '天）。\n当前卖到日期：' + sellUntilDate +
        '\n推荐卖到日期：' + minDate.toISOString().slice(0, 10) +
        '\n\n是否仍要继续生成？'
      );
      if (!confirmed) return null;
    }

    return { productionDays, shippingDays, sellUntilDate, bufferDays };
  }

  // Scope display name — panel scope so the tab-switch / history restore submit
  // handlers (which live outside renderResults) can resolve it too.
  const scopeLabel = (scope: string): string =>
    scope === 'global' ? '全渠道' : (_siteLabels.get(scope) || scope);

  // Arrival date = order date + production + shipping, from the live module
  // state (inputs update these on change; history fill / tab restore set them).
  const toArrivalDate = (orderDate: string): string => {
    if (!orderDate) return '';
    const d = new Date(orderDate + 'T00:00:00');
    d.setDate(d.getDate() + _productionDays + _shippingDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  /** 结果表格的事件接线：行展开（点击行显示完整建议）+ 逐行提交（API 直连存草稿）。
   *  renderResults / 历史恢复 / tab 切换恢复三条路径共用，避免三份拷贝漂移。 */
  function wireResultRows(resultsDiv: HTMLElement, dataSource: GenResult[]): void {
    // --- Row expand/collapse ---
    const tbody = resultsDiv.querySelector('tbody');
    if (tbody) {
      let expandedRow: HTMLTableRowElement | null = null;
      let expandedIdx = -1;
      tbody.querySelectorAll('.erp-gen-result-row').forEach(row => {
        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.erp-gen-submit-row')) return;
          const tr = row as HTMLTableRowElement;
          const idx = parseInt(tr.dataset.rowIdx || '', 10);
          if (expandedRow) { expandedRow.remove(); expandedRow = null; }
          if (expandedIdx === idx) { expandedIdx = -1; return; }
          const r = dataSource[idx];
          if (!r) return;
          const detail = document.createElement('tr');
          detail.className = 'erp-gen-expanded-row';
          detail.innerHTML = '<td colspan="8" style="padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">' +
            '<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">' + escapeHtml(r.suggestion.sku) + ' · ' + escapeHtml(scopeLabel(r.scope)) + ' · 完整建议</div>' +
            '<div style="font-size:11px;color:#334155;line-height:1.6;white-space:pre-wrap;">' + escapeHtml(r.suggestion.suggestion) + '</div></td>';
          tr.after(detail);
          expandedRow = detail as HTMLTableRowElement;
          expandedIdx = idx;
        });
      });
    }

    // --- Per-row submit — calls API directly to save as draft ---
    resultsDiv.querySelectorAll('.erp-gen-submit-row').forEach(btn => {
      btn.addEventListener('click', async () => {
        const scope = (btn as HTMLElement).dataset.scope!;
        const sku = (btn as HTMLElement).dataset.sku!;
        const row = dataSource.find(r => r.scope === scope && r.suggestion.sku === sku);
        if (!row) return;

        const token = getAuthToken(d);
        if (!token) { alert('未获取到登录凭证，请刷新页面后重试'); return; }

        const origText = (btn as HTMLElement).textContent || '提交';
        (btn as HTMLButtonElement).disabled = true;
        (btn as HTMLButtonElement).textContent = '保存中…';

        const remark = '【' + scopeLabel(row.scope) + '】AI采购建议: ' +
          row.suggestion.sku + ' ' + row.productInfo.productName + ' * ' + row.planQty + '件\n' +
          row.suggestion.suggestion;
        const result = await submitAndReport(
          Number(warehouseIdInput.value),
          warehouseText.textContent || '',
          row.scope,
          _countryServers.find(cs => cs.title === scope)?.storeId ?? 0,
          remark,
          [{
            sku: row.suggestion.sku,
            productName: row.productInfo.productName,
            planQty: row.planQty,
            deliveryDate: toArrivalDate(row.suggestion.restockDate || ''),
            productNote: '',
            boxQty: row.boxQty,
          }],
          token,
        );

        if (result.success) {
          alert('草稿已保存！\n计划编号: ' + result.planIds.join(', ') + '\n\n可在采购计划列表查看和提交。');
        } else {
          alert(result.message);
        }
        (btn as HTMLButtonElement).disabled = false;
        (btn as HTMLButtonElement).textContent = origText;
      });
    });
  }

  // Apply the saved filter selection to a freshly restored select. Falls back
  // to __all__ when none of the saved values exist (e.g. different history entry).
  const applyCurveSelection = (filterSelect: HTMLSelectElement): void => {
    const opts = [...filterSelect.options];
    let any = false;
    for (const o of opts) {
      const on = _curveSelection.includes(o.value);
      o.selected = on;
      if (on) any = true;
    }
    if (!any) {
      _curveSelection = ['__all__'];
      for (const o of opts) o.selected = o.value === '__all__';
    }
  };

  // Shared curve renderer — fresh render, history fill, and tab-switch restore
  // all go through it so the filter selection survives and keeps working.
  const renderFilteredCurve = (
    container: HTMLElement, filterSelect: HTMLSelectElement, results: GenResult[],
  ): void => {
    if (_curveUnmount) { _curveUnmount(); _curveUnmount = null; }
    const selected = [...filterSelect.selectedOptions].map(o => o.value);
    _curveSelection = selected;
    if (selected.length === 0) return;

    const toCurveQty = (wf: number[], planQty: number) =>
      planQty > 0 ? planQty : (wf.length > 0 ? wf.reduce((a, b) => a + b, 0) : 0);

    const build = (r: GenResult): CurveInput => ({
      sku: r.suggestion.sku,
      label: r.suggestion.sku + ' · ' + scopeLabel(r.scope),
      currentStock: r.currentStock,
      inTransit: r.inTransit,
      weeklyForecast: r.suggestion.weeklyForecast || [],
      suggestedQty: toCurveQty(r.suggestion.weeklyForecast || [], r.planQty),
      restockDate: r.suggestion.restockDate || '',
      arrivalDate: toArrivalDate(r.suggestion.restockDate || ''),
      tailFillPerWeek: ((r as GenResult).daily || 0) * 7,
    });

    // __all__ selected: overlay every sku+scope curve
    if (selected.includes('__all__')) {
      _curveUnmount = renderCurve(container, results.map(build), undefined);
      return;
    }

    // Multi-select: overlay selected sku::scope curves
    const inputs: CurveInput[] = [];
    for (const val of selected) {
      const [sku, scope] = val.split('::');
      const r = results.find(r2 => r2.suggestion.sku === sku && r2.scope === scope);
      if (r) inputs.push(build(r));
    }
    if (inputs.length > 0) _curveUnmount = renderCurve(container, inputs, undefined);
  };

  // Wire generate button click
  let allResults = _allResults;
  const resultsDiv = panel.querySelector('#erp-gen-results') as HTMLElement;

  generateBtn.addEventListener('click', async () => {
    const params = collectParams();
    if (!params) {
      alert('请完整填写所有参数');
      return;
    }

    // Used by computePurchaseQty inside the try block below
    const leadDays = params.productionDays + params.shippingDays;

    // Save to history
    const modeRadio = panel.querySelector('input[name="erp-gen-mode"]:checked') as HTMLInputElement;
    // Show loading
    const abortCtrl = new AbortController();
    resultsDiv.className = 'erp-gen-section';
    resultsDiv.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;padding:28px 0;gap:10px;">' +
        '<div style="display:flex;gap:7px;">' +
          '<span style="width:5px;height:5px;border-radius:50%;background:#6366f1;animation:erp-dot-pulse 1.2s infinite;"></span>' +
          '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;animation:erp-dot-pulse 1.2s infinite .2s;"></span>' +
          '<span style="width:5px;height:5px;border-radius:50%;background:#a5b4fc;animation:erp-dot-pulse 1.2s infinite .4s;"></span>' +
        '</div>' +
        '<span id="erp-gen-spinner-text" style="font-size:12px;color:#64748b;">AI 正在分析采购数据…</span>' +
        '<button id="erp-gen-cancel" style="border:none;background:transparent;color:#94a3b8;' +
        'font-size:11px;cursor:pointer;text-decoration:underline;">取消</button>' +
      '</div>' +
      '<style>@keyframes erp-dot-pulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1.2)}}</style>';

    resultsDiv.querySelector('#erp-gen-cancel')?.addEventListener('click', () => {
      abortCtrl.abort();
    });

    generateBtn.disabled = true;
    generateBtn.textContent = '分析中…';

    let reasoningText = '';
    let firstContentByte = false;
    let reasoningSec = 0;
    let reasoningTimer: ReturnType<typeof setInterval> | null = null;

    try {
      const skus = [...selectedSkus.keys()];
      panel.querySelector('#erp-gen-data-warning')?.remove();
      addLog('sku_detect', '已选择 ' + skus.length + ' 个SKU: ' + skus.join(', '));

      const settings = await getSettings();
      const marketGroups = settings.marketGroups;

      // Fetch data using existing pipeline — per-SKU site list for multi-scope analysis
      const siteMap = new Map<string, string[]>();
      for (const sku of skus) {
        if (selectedSites.size > 0) siteMap.set(sku, [...selectedSites]);
      }
      addLog('sales_fetch', '正在获取库存和销售数据…');
      const startFetch = Date.now();
      const summaries = await fetchAndSummarize(skus, d, siteMap, marketGroups);
      addLog('sales_done', '数据获取完成 (' + summaries.length + '/' + skus.length + ' SKU, ' + (Date.now() - startFetch) + 'ms)');

      // Apply operator inputs
      for (const s of summaries) {
        s.productionDays = params.productionDays;
        s.shippingDays = params.shippingDays;
        s.sellUntilDate = params.sellUntilDate;
        s.bufferDays = params.bufferDays;
      }

      // Multi-channel daily sales: global (全渠道) + selected non-Amazon platform sites
      const nonAmazonMarkets = platformMarkets.filter(
        (m) => m.group !== 'AMAZON' && platformMarketWarehouses(m) !== null && selectedSites.has(m.id),
      );
      let mcGlobal = new Map<string, MultiChannelDaily>();
      const mcSites = new Map<string, Map<string, MultiChannelDaily>>();
      try {
        addLog('mc_fetch', '正在获取全渠道销售数据…');
        const mcToken = getAuthToken(d);
        // 全渠道 + 站点口径并行抓取；站点间并发上限 3（+1 全渠道 ≈ 4 路并发）
        const [, siteResults] = await Promise.all([
          fetchMultiChannelAverages(skus, mcToken, undefined, abortCtrl.signal).then((m) => { mcGlobal = m; }),
          mapWithLimit(nonAmazonMarkets, 3, async (m) =>
            [m.id, await fetchMultiChannelAverages(skus, mcToken, [Number(m.id)], abortCtrl.signal)] as const),
        ]);
        for (const [id, daily] of siteResults) mcSites.set(id, daily);
        addLog('mc_done', '全渠道销售数据获取完成 (' + nonAmazonMarkets.length + ' 个非亚马逊站点)');
      } catch (e: any) {
        const reason = e instanceof ErpApiError && e.kind === 'permission' ? '疑似无权限' : (e.message || '网络错误');
        addLog('warn', '多渠道销售数据获取失败（' + reason + '），回退亚马逊口径');
        showDataWarning('多渠道销售数据获取失败（' + reason + '）',
          '本次分析已回退【亚马逊口径】，TikTok/Temu 等非亚马逊平台销量未计入站点行');
      }
      applyMultiChannelToSummaries(summaries, mcGlobal, mcSites, nonAmazonMarkets);

      // Build prompts — pass selected sites so the LLM returns per-scope plans
      const prompts = summaries.map(s => buildAiPrompt(s, [...selectedSites])).join('\n---\n');

      // Read LLM settings
      const llmSettings = settings;
      const llmProvider = llmSettings.llmProvider || 'deepseek';
      const llmModel = llmSettings.llmModel || 'deepseek-chat';
      const apiKey = llmSettings.apiKey;

      if (!apiKey) {
        resultsDiv.innerHTML = '<div style="padding:12px;color:#ef4444;">API Key 未配置，请在设置中配置</div>';
        generateBtn.disabled = false;
        generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU)';
        return;
      }

      const llmStartTs = Date.now();
      addLog('llm_start', '正在调用 ' + llmProvider + '/' + llmModel + ' 分析采购数据…');

      const expectedScopes = skus.map(sku => ({
        sku,
        scopes: ['global', ...selectedSites],
      }));
      const expectedWeeks = Math.max(1, Math.ceil(
        (new Date(params.sellUntilDate).getTime() - Date.now()) / (7 * 86400000),
      ));

      // One streaming LLM call. finalPrompt defaults to the main prompts;
      // history supplies the previous user+assistant turns for repair rounds.
      async function runLlmCall(
        finalPrompt: string,
        history?: Array<{ role: 'user' | 'assistant'; content: string }>,
      ): Promise<string> {
        reasoningText = '';
        let text = '';
        for await (const chunk of streamChat(finalPrompt, llmProvider as 'deepseek', apiKey, abortCtrl.signal, llmModel,
          llmSettings.thinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
          llmSettings.reasoningEffort || 'high',
          history,
        )) {
          if (chunk.type === 'reasoning') {
            if (!reasoningTimer) {
              reasoningSec = Math.round((Date.now() - llmStartTs) / 1000);
              reasoningTimer = setInterval(() => {
                reasoningSec++;
                const st = resultsDiv.querySelector('#erp-gen-spinner-text');
                if (st) st.textContent = 'AI 正在思考中… ' + reasoningSec + 's';
              }, 1000);
            }
            reasoningText += chunk.text;
            updateLastLog('reasoning', reasoningText);
            continue;
          }
          if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
          if (reasoningText) {
            addLog('llm_reasoning_done', reasoningText);
            reasoningText = '';
          }
          if (!firstContentByte) {
            firstContentByte = true;
            addLog('llm_first_byte', 'AI 首字节响应 (' + (Date.now() - llmStartTs) + 'ms)');
          }
          text += chunk.text;
          // No streaming display — keep the spinner until the final table renders.
        }
        return text;
      }

      let fullText = await runLlmCall(prompts);

      if (abortCtrl.signal.aborted) {
        addLog('error', '请求已取消');
        resultsDiv.innerHTML = '<div style="padding:12px;color:#ef4444;">请求已取消</div>';
        generateBtn.disabled = false;
        generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU)';
        if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
        return;
      }

      addLog('llm_parse', 'AI 响应接收完成，正在解析…');
      let suggestions = parseLlmResponse(fullText, expectedScopes);
      addLog('llm_parsed', '解析完成，获得 ' + suggestions.length + ' 条建议');

      // Repair loop (spec 4.6): bad length or parse failure → continue the
      // conversation, up to 2 rounds.
      const isForecastBad = (list: LlmSuggestion[]) => list.some(sug => {
        const wf = sug.weeklyForecast;
        if (!wf || wf.length === 0) return false; // patched entries get padded below
        return wf.length !== expectedWeeks;
      });
      const MAX_REPAIR_ROUNDS = 2;
      let repairRound = 0;
      while (!abortCtrl.signal.aborted && repairRound < MAX_REPAIR_ROUNDS &&
        (suggestions.length === 0 || isForecastBad(suggestions))) {
        repairRound++;
        const badLen = suggestions
          .map(sug => sug.weeklyForecast?.length ?? 0)
          .find(n => n > 0 && n !== expectedWeeks);
        const repairPrompt = '你输出的 weeklyForecast 长度应为 ' + expectedWeeks +
          ' 周（从下周起到卖到日期按自然周划分），你给了 ' +
          (badLen ? String(badLen) + ' 周' : '不符的长度') +
          '。请重新输出完整 JSON，仅修正 weeklyForecast 数组，其余字段保持不变。';
        addLog('llm_repair', 'weeklyForecast 长度不符或解析失败，发起第 ' + repairRound + ' 轮修正…');
        fullText = await runLlmCall(repairPrompt, [
          { role: 'user', content: prompts },
          { role: 'assistant', content: fullText },
        ]);
        suggestions = parseLlmResponse(fullText, expectedScopes);
        addLog('llm_repair_done', '第 ' + repairRound + ' 轮修正完成，解析到 ' + suggestions.length + ' 条');
      }

      // Frontend padding fallback (spec 4.6)
      const summaryMap = new Map<string, SkuSummary>();
      for (const s of summaries) summaryMap.set(s.sku, s);
      const fillPerWeekFor = (sug: LlmSuggestion): number => {
        const summary = summaryMap.get(sug.sku);
        let fill7d = 0;
        if (sug.scope === 'global') {
          fill7d = summary?.avgDaily7d ?? 0;
        } else if (summary?.siteDatas) {
          const sd = summary.siteDatas.find(x => x.site === sug.scope);
          fill7d = sd ? sd.avgDaily7d : 0;
        }
        return ((sug.predictedDailySales && sug.predictedDailySales > 0)
          ? sug.predictedDailySales : fill7d) * 7;
      };
      for (const sug of suggestions) {
        const wf = sug.weeklyForecast;
        if (!wf || wf.length === 0 || wf.length !== expectedWeeks) {
          sug.weeklyForecast = padWeeklyForecast(wf, expectedWeeks, fillPerWeekFor(sug));
        }
      }
      // No zero cliffs at the tail: trailing zero weeks get the fill rate
      // (a cliff would render a flat stock line, which is never realistic).
      for (const sug of suggestions) {
        const fw = sug.weeklyForecast;
        if (!fw || fw.length === 0) continue;
        const fillPerWeek = fillPerWeekFor(sug);
        if (fillPerWeek <= 0) continue;
        let t = fw.length - 1;
        while (t >= 0 && fw[t] === 0) t--;
        for (let k = t + 1; k < fw.length; k++) fw[k] = fillPerWeek;
      }

      if (abortCtrl.signal.aborted) {
        addLog('error', '请求已取消');
        resultsDiv.innerHTML = '<div style="padding:12px;color:#ef4444;">请求已取消</div>';
        generateBtn.disabled = false;
        generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU)';
        if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
        return;
      }

      if (suggestions.length === 0) {
        if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
        resultsDiv.innerHTML =
          '<div style="padding:12px;color:#ef4444;">AI 返回格式异常，请重试</div>' +
          '<div style="padding:4px 12px;font-size:10px;color:#94a3b8;">' +
            escapeHtml(fullText.slice(0, 500)) + '</div>';
        generateBtn.disabled = false;
        generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU)';
        return;
      }

      _allResults = allResults = suggestions.map(sug => {
        const prod = selectedSkus.get(sug.sku)!;
        const summary = summaryMap.get(sug.sku);
        const boxQty = summary?.singleQuantity || prod.singleQuantity || 1;
        const isGlobal = sug.scope === 'global';

        let currentStock: number;
        let inTransit: number;
        let daily7d = 0;
        if (isGlobal) {
          // 全渠道行：全渠道汇总库存 + 国内仓计采交合计（计划量+采购量，防止重复推荐）
          currentStock = summary?.totalAvailable ?? 0;
          inTransit = (summary?.totalInTransit ?? 0) + (summary?.purchaseInTransit ?? 0);
          daily7d = summary?.avgDaily7d ?? 0;
        } else if (summary?.siteDatas) {
          // 站点行：TikTok 等多渠道站点的映射国内仓采购在途已在 applyMultiChannelToSummaries
          // 并入 fbaInTransit；Amazon 站点行不摊国内采购在途（无法归属，全渠道行统一覆盖）
          const sd = summary.siteDatas.find(x => x.site === sug.scope);
          currentStock = sd?.fbaAvailable ?? 0;
          inTransit = sd?.fbaInTransit ?? 0;
          if (sd) daily7d = sd.avgDaily7d;
        } else {
          currentStock = summary?.fbaAvailable ?? prod.availableQty ?? 0;
          inTransit = summary?.fbaInTransit ?? prod.inTransitQty ?? 0;
        }
        if (!isGlobal && !(summary?.siteDatas?.some(x => x.site === sug.scope))) {
          addLog('warn', 'SKU ' + sug.sku + ' 站点 ' + sug.scope + ' 无站点数据，采购量按 0 处理（若该站点实际有销量，请检查销量数据获取）');
        }

        // d fallback chain: AI scope value → scope 7d actual → 0.
        // Site rows never fall back to the global rate — a site with no real
        // sales buys nothing.
        let daily = sug.predictedDailySales;
        if (!daily || daily <= 0) {
          daily = daily7d;
        }

        const coverageDays =
          (new Date(params.sellUntilDate).getTime() - Date.now()) / 86400000 + params.bufferDays;
        const planQty = computePurchaseQty(daily, currentStock, inTransit, leadDays, coverageDays, boxQty);

        return {
          scope: sug.scope,
          suggestion: sug,
          productInfo: prod,
          currentStock,
          inTransit,
          boxQty,
          planQty,
          boxes: Math.ceil(planQty / boxQty),
          daily,
        };
      });

      // Append deterministic qty to the visible suggestion text (spec 4.1)
      for (const r of allResults) {
        r.suggestion.suggestion += '\n建议采购量: ' + r.planQty + '件';
        // 库存依据写明白口径，运营可核对
        const pIT = r.scope === 'global' ? (summaryMap.get(r.suggestion.sku)?.purchaseInTransit ?? 0) : 0;
        r.suggestion.suggestion += '\n库存依据: 库存可用 ' + r.currentStock + ' + 在途(含已发货/待入库/待出运) ' + r.inTransit +
          (r.scope === 'global' ? '（其中计采交合计(计划+采购+交货)在途 ' + pIT + '）' : '');
      }

      // Frontend-computed risk: override LLM's riskLevel with data-driven calculation.
      // LLMs tend to default to the middle value (yellow) when uncertain, so we
      // compute remaining-stock-days from actual numbers for reliable risk coloring.
      const riskThreshold = params.productionDays + params.shippingDays;
      for (const r of allResults) {
        // Reuse the resolved daily from the formula pass (same fallback chain);
        // zero-sales rows get no restock date.
        const daily = r.daily;
        if (!daily || daily <= 0) {
          if (r.planQty <= 0) r.suggestion.riskLevel = 'green';
          continue;
        }
        const remainingDays = (r.currentStock + r.inTransit) / daily;

        // Risk: green if no purchase needed, else per 08-07 design —
        // red = remaining ≤ lead (production+shipping, order deadline hit),
        // yellow = ≤ lead + buffer
        if (r.planQty <= 0) {
          r.suggestion.riskLevel = 'green';
        } else {
          r.suggestion.riskLevel = riskLevelFromRemainingDays(
            remainingDays, riskThreshold, params.bufferDays,
          );
        }

        // restockDate for ALL entries (most useful when qty=0 — tells when to reorder)
        const orderDayOffset = Math.round(remainingDays - params.bufferDays - params.productionDays - params.shippingDays);
        // Always provide a date: if stock is already low, order today
        const orderDate = new Date(Date.now() + Math.max(orderDayOffset, 0) * 86400000);
        const dateStr = orderDate.getFullYear() + '-' +
          String(orderDate.getMonth() + 1).padStart(2, '0') + '-' +
          String(orderDate.getDate()).padStart(2, '0');
        r.suggestion.restockDate = dateStr;
        // Append to visible suggestion text so the user can see it
        if (dateStr) {
          r.suggestion.suggestion += '\n预计采购日期: ' + dateStr;
        }
      }
      // Global row: reflect the most urgent site's risk
      for (const sku of skus) {
        const globalEntry = allResults.find(r => r.suggestion.sku === sku && r.scope === 'global');
        const siteEntries = allResults.filter(r => r.suggestion.sku === sku && r.scope !== 'global');
        if (globalEntry && siteEntries.length > 0) {
          const riskOrder = { red: 0, yellow: 1, green: 2 } as const;
          const mostUrgent = siteEntries.reduce((worst, s) =>
            riskOrder[s.suggestion.riskLevel] < riskOrder[worst.suggestion.riskLevel] ? s : worst
          , siteEntries[0]);
          globalEntry.suggestion.riskLevel = mostUrgent.suggestion.riskLevel;
        }
      }

      renderResults();
      _hasResults = true;
      _resultsHTML = resultsDiv.innerHTML;
      // Save again after curve renders (overwrites with complete UI)
      setTimeout(() => { _resultsHTML = resultsDiv.innerHTML; }, 500);

      // Save to history with results
      saveHistoryAndRefresh({
        mode: (panel.querySelector('input[name="erp-gen-mode"]:checked') as HTMLInputElement)?.value || 'single',
        warehouseId: warehouseIdInput.value,
        warehouseLabel: warehouseText.textContent || '',
        productionDays: params.productionDays,
        shippingDays: params.shippingDays,
        sellUntilDate: params.sellUntilDate,
        bufferDays: params.bufferDays,
        selectedSites: [...selectedSites],
        selectedSkus: [...selectedSkus.values()].map(s => ({ sku: s.sku, productName: s.productName, asin: s.asin })),
        resultsHTML: resultsDiv.innerHTML,
        allResults: _allResults,
      });

      const elapsed = Date.now() - llmStartTs;
      addLog('done', '分析完成 — ' + allResults.length + ' 条建议, 总耗时 ' + elapsed + 'ms');

      generateBtn.disabled = false;
      generateBtn.textContent = '🔄 重新生成 (' + selectedSkus.size + ' SKU)';
    } catch (e: any) {
      if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
      if (e instanceof ErpApiError) {
        addLog('error', e.message);
        resultsDiv.innerHTML = erpErrorNoticeHtml(e);
      } else if (e.name === 'AbortError') {
        addLog('error', '请求超时或已取消');
        resultsDiv.innerHTML = '<div style="padding:12px;color:#ef4444;">请求超时或已取消</div>';
      } else if (e.message === 'AUTH_ERROR') {
        addLog('error', '鉴权失败 — API Key 无效');
        resultsDiv.innerHTML = '<div style="padding:12px;color:#ef4444;">API Key 无效，请在设置中检查</div>';
      } else {
        addLog('error', (e.message || '未知错误'));
        resultsDiv.innerHTML =
          '<div style="padding:12px;color:#ef4444;">AI 返回格式异常，请重试</div>' +
          '<div style="padding:4px 12px;font-size:10px;color:#94a3b8;">' +
            escapeHtml(e.message || '') + '</div>' +
          '<div style="padding:4px 12px;font-size:9px;color:#cbd5e1;white-space:pre-wrap;word-break:break-all;">' +
            escapeHtml(e.stack || '') + '</div>';
      }
      generateBtn.disabled = false;
      generateBtn.textContent = '🤖 生成采购计划 (' + selectedSkus.size + ' SKU)';
    }

    function renderResults(): void {
    resultsDiv.className = 'erp-gen-section';

    // Sort: by SKU, global scope first, then site scopes alphabetically
    allResults.sort((a, b) => {
      if (a.suggestion.sku !== b.suggestion.sku) return a.suggestion.sku.localeCompare(b.suggestion.sku);
      if (a.scope === 'global') return -1;
      if (b.scope === 'global') return 1;
      return a.scope.localeCompare(b.scope);
    });

    // Totals: count site plans only (global rows are 仅参考 and would double-count)
    const siteRows = allResults.filter(r => r.scope !== 'global');
    const counted = siteRows.length > 0 ? siteRows : allResults;
    const totalQty = counted.reduce((sum, r) => sum + r.planQty, 0);
    const totalBoxes = counted.reduce((sum, r) => sum + r.boxes, 0);

    const riskEmoji: Record<string, string> = { red: '🔴', yellow: '🟡', green: '🟢' };

    let rowsHtml = '';
    for (let ri = 0; ri < allResults.length; ri++) {
      const r = allResults[ri];
      const isGlobal = r.scope === 'global';
      rowsHtml +=
        '<tr class="erp-gen-result-row" data-row-idx="' + ri + '" style="cursor:pointer;">' +
          '<td style="font-weight:500;">' + escapeHtml(r.suggestion.sku) + '</td>' +
          '<td>' + escapeHtml(scopeLabel(r.scope)) + '</td>' +
          '<td>' + r.planQty + '</td>' +
          '<td>' + r.boxes + '</td>' +
          '<td>' + (r.suggestion.restockDate ? toArrivalDate(r.suggestion.restockDate) : (isGlobal ? '--' : '-')) + '</td>' +
          '<td style="text-align:center;">' + (riskEmoji[r.suggestion.riskLevel] || '🟢') + '</td>' +
          '<td style="font-size:10px;color:#64748b;max-width:140px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;">' +
          escapeHtml(r.suggestion.suggestion) + '</td>' +
          '<td>' + (isGlobal
            ? '<span style="color:#94a3b8;font-size:10px;">仅参考</span>'
            : r.planQty <= 0
              ? '<span style="color:#94a3b8;font-size:10px;">无需采购</span>'
              : '<button class="erp-gen-btn erp-gen-btn-primary erp-gen-submit-row" ' +
                'data-scope="' + escapeAttr(r.scope) + '" data-sku="' + escapeAttr(r.suggestion.sku) + '" ' +
                'style="padding:4px 10px;font-size:10px;">提交</button>') +
          '</td>' +
        '</tr>';
    }

    let curveOptions = '<option value="__all__" selected>全部（所有站点）</option>';
    for (const r of allResults) {
      const label = r.suggestion.sku + ' / ' + scopeLabel(r.scope);
      const val = r.suggestion.sku + '::' + r.scope;
      curveOptions += '<option value="' + escapeAttr(val) + '">' + escapeHtml(label) + '</option>';
    }

    resultsDiv.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="font-size:12px;font-weight:600;color:#1e293b;">' +
          '📊 结果 (' + allResults.length + ' 条计划 · 计划' + totalQty + '件 · ' + totalBoxes + '箱)</span>' +
      '</div>' +
      '<div style="overflow-x:auto;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
          '<thead><tr style="border-bottom:2px solid #e2e8f0;text-align:left;color:#64748b;">' +
            '<th style="padding:6px 4px;">SKU</th>' +
            '<th style="padding:6px 4px;">范围</th>' +
            '<th style="padding:6px 4px;">计划量</th>' +
            '<th style="padding:6px 4px;">箱数</th>' +
            '<th style="padding:6px 4px;">交期</th>' +
            '<th style="padding:6px 4px;text-align:center;">风险</th>' +
            '<th style="padding:6px 4px;">建议</th>' +
            '<th style="padding:6px 4px;text-align:center;">操作</th>' +
          '</tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
        '<button class="erp-gen-btn erp-gen-btn-secondary" id="erp-gen-pdf">' +
          '📥 下载PDF报告</button>' +
      '</div>' +
      '<div style="margin-top:12px;">' +
        '<div class="erp-gen-section-title" style="margin-bottom:4px;">📈 库存曲线</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
          '<span style="font-size:11px;color:#64748b;">筛选:</span>' +
          '<select id="erp-gen-curve-filter" multiple size="5" style="border:1px solid #e2e8f0;border-radius:4px;padding:2px 4px;font-size:11px;width:100%;">' +
            curveOptions +
          '</select>' +
        '</div>' +
        '<div id="erp-gen-curve-container"></div>' +
      '</div>';

    // Wire row expansion + submit buttons (shared with history/restore paths)
    wireResultRows(resultsDiv, allResults);

    // Wire buttons
    resultsDiv.querySelector('#erp-gen-pdf')?.addEventListener('click', async () => {
      const curveCanvas = resultsDiv.querySelector('#erp-gen-curve-container canvas') as HTMLCanvasElement | null;
      if (!curveCanvas) {
        alert('请先生成曲线图');
        return;
      }
      try {
        await generatePdfReport(allResults, curveCanvas);
      } catch (e: any) {
        alert('PDF生成失败: ' + (e.message || '未知错误'));
      }
    });

    // Curve with SKU filter — shared renderer keeps selection working after restore
    const curveContainer = resultsDiv.querySelector('#erp-gen-curve-container') as HTMLElement;
    const filterSelect = resultsDiv.querySelector('#erp-gen-curve-filter') as HTMLSelectElement;

    filterSelect.addEventListener('change', () => renderFilteredCurve(curveContainer, filterSelect, allResults));
    setTimeout(() => renderFilteredCurve(curveContainer, filterSelect, allResults), 100);
  }
  });

  // === Restore saved state after tab switch ===
  console.log('[gen] restore: hasResults=' + _hasResults + ' allResults=' + _allResults.length + ' skus=' + _selectedSkus.size + ' html=' + (_resultsHTML ? _resultsHTML.length : 0));
  try {
    if (_warehouseId) {
      warehouseIdInput.value = _warehouseId;
      warehouseText.textContent = _warehouseLabel;
      warehouseText.style.color = '#334155';
      searchSection.style.display = '';
      searchInput.disabled = false;
    }
    const modeRadio = panel.querySelector('input[name="erp-gen-mode"][value="' + _mode + '"]') as HTMLInputElement;
    if (modeRadio) modeRadio.checked = true;
    (panel.querySelector('#erp-gen-production') as HTMLInputElement).value = String(_productionDays);
    (panel.querySelector('#erp-gen-shipping') as HTMLInputElement).value = String(_shippingDays);
    if (_sellUntilDate) sellUntilInput.value = _sellUntilDate;
    (panel.querySelector('#erp-gen-buffer') as HTMLInputElement).value = String(_bufferDays);

    if (_selectedSkus.size > 0) {
      searchSection.style.display = '';
      searchInput.disabled = false;
      const skuArr = [..._selectedSkus.values()];
      searchResultsDiv.innerHTML = skuArr.map(p =>
        '<label style="display:flex;align-items:center;gap:8px;padding:8px 0;' +
        'border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:11px;">' +
        '<input type="checkbox" data-sku="' + escapeAttr(p.sku) + '" checked>' +
        '<span>' + escapeHtml(p.sku) + '</span>' +
        '<span style="color:#94a3b8;margin-left:auto;">' + escapeHtml(p.productName) + '</span>' +
        '</label>'
      ).join('');
      searchResultsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const sku = (cb as HTMLInputElement).dataset.sku!;
          if ((cb as HTMLInputElement).checked) {
            const s = skuArr.find(x => x.sku === sku);
            if (s) selectedSkus.set(sku, s);
          } else {
            selectedSkus.delete(sku);
          }
          updateGenerateButton();
          updateParamsVisibility();
        });
      });
      // Auto-trigger search to show matching SKU variants
      searchInput.value = skuArr[0].sku;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    updateGenerateButton();
    updateParamsVisibility();

    // Restore results
    if (_hasResults && _allResults.length > 0) {
      if (_resultsHTML) {
        resultsDiv.className = 'erp-gen-section';
        resultsDiv.innerHTML = _resultsHTML;
      }
      // Re-render curve — restore saved filter selection and re-wire changes
      const restoredCurveContainer = resultsDiv.querySelector('#erp-gen-curve-container') as HTMLElement;
      const restoredFilterSelect = resultsDiv.querySelector('#erp-gen-curve-filter') as HTMLSelectElement;
      if (restoredCurveContainer && restoredFilterSelect) {
        applyCurveSelection(restoredFilterSelect);
        restoredFilterSelect.addEventListener('change', () => renderFilteredCurve(restoredCurveContainer, restoredFilterSelect, _allResults));
        setTimeout(() => renderFilteredCurve(restoredCurveContainer, restoredFilterSelect, _allResults), 300);
      }
      // Re-wire row expansion + submit buttons
      wireResultRows(resultsDiv, _allResults);
    }
  } catch (e) {
    console.warn('[purchase-plan-generator] restore failed:', e);
  }
}
