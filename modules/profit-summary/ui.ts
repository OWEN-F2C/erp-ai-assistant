// modules/profit-summary/ui.ts
import { ErpApiError, erpErrorNoticeHtml } from '../../shared/erp-errors';
import type { Settings } from '../../shared/types';
import { defaultProfitStartMonth } from '../../shared/types';
import { getAuthToken } from '../../shared/auth';
import { normalizeUiScale } from '../../shared/ui-scale';
import { PANEL_BUILD } from '../../shared/panel-dedup';
import { getPanelVersion } from '../../shared/panel-version';
import {
  fetchAllProfitMonths,
  aggregateBySku,
  getMonthsInRange,
  type SkuProfitSummary,
} from '../../shared/finance-profit-data';

const SKU_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#14b8a6',
];

const PLATFORM_COLORS: Record<string, string> = {
  Amazon: '#f59e0b', Shopify: '#10b981', Temu: '#ef4444',
  Tiktok: '#6366f1', Walmart: '#06b6d4',
};

const ROWS_PER_PAGE = 20;
const BARS_PER_PAGE = 10;

interface ProfitState {
  summaries: SkuProfitSummary[];
  months: string[];
  checkedSkus: Set<string>;
  sortColumn: string;
  sortDirection: 'asc' | 'desc' | 'none';
  tablePage: number;
  barPage: number;
  filters: { brand: string; category: string; manager: string; channel: string };
  skuSearch: string;
  channelBreakdownSku: string | null;
  channelBreakdownMonth: string | null;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 折叠状态用模块级变量保留——SPA 切走再切回时 content.ts 会移除并重新注入
// 面板，局部状态会归零导致"缩小后切回来又展开"
let profitCollapsed = false;

export function renderProfitSummary(doc: Document, settings: Settings): void {
  if (doc.querySelector('.erp-profit-panel')) return;

  const marker = doc.createElement('span');
  marker.className = 'erp-profit-panel';
  marker.hidden = true;
  doc.body?.appendChild(marker);

  const startMonth = settings.profitStartMonth || defaultProfitStartMonth();
  console.log('[profit-summary] startMonth:', startMonth, 'profitStartMonth setting:', settings.profitStartMonth);
  const token = getAuthToken(doc);
  console.log('[profit-summary] token found:', !!token);
  if (!token) {
    showError(doc, '未找到认证令牌，请刷新页面后重试');
    return;
  }

  const panel = doc.createElement('div');
  panel.className = 'erp-profit-panel';
  panel.dataset.erpBuild = PANEL_BUILD;
  panel.style.cssText =
    'margin:16px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;' +
    'box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;color:#333;';
  // 面板整体缩放（设置→界面；cssText 之后设置，否则会被整体覆盖）
  panel.style.zoom = String(normalizeUiScale(settings.uiScale));

  panel.innerHTML = `
    <div style="padding:14px 18px;background:#fafbfc;border-bottom:1px solid #f1f5f9;
      display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="profit-collapse" style="padding:2px 6px;font-size:12px;line-height:1;
          background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;"
          title="折叠/展开">−</button>
        <span style="font-weight:700;font-size:14px;color:#1e293b;">全渠道净利润</span>
        <span data-erp-version title="扩展版本" style="font-size:10px;color:#94a3b8;">v${getPanelVersion()}</span>
        <span id="profit-status" style="font-size:11px;color:#94a3b8;">加载中...</span>
        <span id="profit-progress" style="display:flex;align-items:center;gap:6px;">
          <span id="profit-progress-bar" style="display:inline-block;width:120px;height:10px;
            background:#e2e8f0;border-radius:5px;overflow:hidden;vertical-align:middle;">
            <span id="profit-progress-fill" style="display:block;height:100%;width:0%;
              background:#22c55e;border-radius:5px;transition:width .3s;"></span>
          </span>
          <span id="profit-progress-label" style="font-size:10px;color:#94a3b8;">0/0 月</span>
        </span>
      </div>
      <button id="profit-refresh" style="padding:4px 12px;font-size:11px;
        background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;">刷新</button>
    </div>
    <div id="profit-body">
      <div id="profit-charts" style="padding:12px;">
        <canvas id="profit-line-canvas" style="width:100%;height:300px;display:block;"></canvas>
        <div id="profit-tooltip" style="display:none;position:absolute;pointer-events:none;
          background:rgba(0,0,0,0.85);color:#fff;padding:6px 10px;border-radius:6px;
          font-size:11px;line-height:1.5;white-space:nowrap;z-index:1000;"></div>
        <div id="profit-channel-breakdown" style="display:none;margin-top:10px;padding:10px;
          background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;"></div>
      </div>
      <div id="profit-bar-section" style="padding:0 12px 12px;">
        <canvas id="profit-bar-canvas" style="width:100%;height:400px;display:block;"></canvas>
      </div>
      <div id="profit-filters" style="padding:0 12px 8px;display:flex;gap:8px;flex-wrap:wrap;"></div>
      <div id="profit-table" style="padding:0 12px 12px;overflow:auto;max-height:500px;"></div>
    </div>
  `;

  if (doc.body) doc.body.insertBefore(panel, doc.body.firstChild);

  // Collapse/expand toggle — 状态存模块级，切页返回后保持
  {
    const body = panel.querySelector('#profit-body') as HTMLElement | null;
    const btn = panel.querySelector('#profit-collapse') as HTMLButtonElement | null;
    if (profitCollapsed) {
      if (body) body.style.display = 'none';
      if (btn) btn.textContent = '+';
    }
    btn?.addEventListener('click', () => {
      profitCollapsed = !profitCollapsed;
      if (body) body.style.display = profitCollapsed ? 'none' : '';
      if (btn) btn.textContent = profitCollapsed ? '+' : '−';
    });
  }

  loadAndRender(panel, startMonth, token);
}

async function loadAndRender(
  panel: HTMLElement, startMonth: string, token: string,
): Promise<void> {
  const statusEl = panel.querySelector('#profit-status') as HTMLElement;
  const progressEl = panel.querySelector('#profit-progress') as HTMLElement;
  const progressFill = panel.querySelector('#profit-progress-fill') as HTMLElement;
  const progressLabel = panel.querySelector('#profit-progress-label') as HTMLElement;

  statusEl.textContent = '加载中...';
  progressEl.style.display = 'flex';

  const controller = new AbortController();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const totalMonths = getMonthsInRange(startMonth, currentMonth).length;
  let completed = 0;

  try {
    const monthData = await fetchAllProfitMonths(
      startMonth, token, controller.signal,
      (p) => {
        if (p.status === 'done' || p.status === 'cached' || p.status === 'error') completed++;
        const pct = totalMonths > 0 ? Math.round((completed / totalMonths) * 100) : 0;
        progressFill.style.width = pct + '%';
        progressLabel.textContent = completed + '/' + totalMonths + ' 月';
        statusEl.textContent = `加载 ${p.month} (${p.status})...`;
      },
    );

    const summaries = aggregateBySku(monthData);
    const months = monthData.map(d => d.month).sort();

    // Hide progress bar, show summary
    progressEl.style.display = 'none';
    if (summaries.length === 0) {
      statusEl.textContent = monthData.length === 0
        ? '无数据：利润数据 API 请求全部失败——请检查网络；若为账号权限问题，请联系积加系统管理员开通财务利润报表权限后重试'
        : '无数据：所选月份范围内无 SKU 利润记录';
      return;
    }

    statusEl.textContent = summaries.length + ' SKU · ' + months[0] + ' ~ ' + months[months.length - 1];

    const state: ProfitState = {
      summaries,
      months,
      checkedSkus: new Set(summaries.slice(0, 5).map(s => s.sku)),
      sortColumn: 'cumulativeProfit',
      sortDirection: 'desc',
      tablePage: 1,
      barPage: 1,
      filters: { brand: '', category: '', manager: '', channel: '' }, // brand/category/manager unused, kept for type compat
      skuSearch: '',
      channelBreakdownSku: null,
      channelBreakdownMonth: null,
    };

    renderAll(panel, state);

  } catch (err) {
    console.error('[profit-summary] loadAndRender failed:', err);
    progressEl.style.display = 'none';
    if (err instanceof ErpApiError) {
      statusEl.innerHTML = erpErrorNoticeHtml(err);
    } else {
      statusEl.textContent = '加载失败，请刷新重试';
    }
  }
}

function renderFilters(
  container: HTMLElement, state: ProfitState, onChange: () => void,
): void {
  // SKU multi-select options
  const searchLower = state.skuSearch.toLowerCase();
  const skuOptions = state.summaries
    .filter(s => !searchLower || s.sku.toLowerCase().includes(searchLower) || s.productName.toLowerCase().includes(searchLower))
    .map(s => `<option value="${escapeHtml(s.sku)}" ${state.checkedSkus.has(s.sku) ? 'selected' : ''}>${escapeHtml(s.sku)}</option>`)
    .join('');

  const existingInput = container.querySelector('#pf-sku-search') as HTMLInputElement | null;

  if (!existingInput) {
    // First render — create all elements
    container.innerHTML = `
      <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:4px;">
        SKU <input id="pf-sku-search" type="text" placeholder="搜索SKU或产品名..."
          style="width:140px;font-size:11px;border:1px solid #ddd;border-radius:3px;padding:2px 6px;">
        <select id="pf-sku" multiple size="1"
          style="width:160px;font-size:11px;border:1px solid #ddd;border-radius:3px;">${skuOptions}</select>
      </div>
    `;

    container.querySelector('#pf-sku-search')?.addEventListener('input', (e) => {
      state.skuSearch = (e.target as HTMLInputElement).value;
      state.tablePage = 1;
      state.barPage = 1;
      onChange();
    });

    container.querySelector('#pf-sku')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      state.checkedSkus.clear();
      for (const opt of sel.selectedOptions) {
        if (state.checkedSkus.size >= 10) break;
        state.checkedSkus.add(opt.value);
      }
      onChange();
    });
  } else {
    // Re-render — only update select options, leave input alone
    const select = container.querySelector('#pf-sku') as HTMLSelectElement | null;
    if (select) select.innerHTML = skuOptions;
  }
}

function applyFilters(state: ProfitState): SkuProfitSummary[] {
  const searchLower = state.skuSearch.toLowerCase();
  return state.summaries.filter(s => {
    if (state.filters.brand && s.brand !== state.filters.brand) return false;
    if (state.filters.category && s.category !== state.filters.category) return false;
    if (state.filters.manager && s.sellingManagerName !== state.filters.manager) return false;
    if (searchLower && !s.sku.toLowerCase().includes(searchLower) && !s.productName.toLowerCase().includes(searchLower)) return false;
    return true;
  });
}

function applySort(
  items: SkuProfitSummary[], column: string, direction: string,
): SkuProfitSummary[] {
  if (direction === 'none') return items;
  const sorted = [...items];
  sorted.sort((a, b) => {
    const av = (a as Record<string, unknown>)[column];
    const bv = (b as Record<string, unknown>)[column];
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av ?? '').localeCompare(String(bv ?? ''));
  });
  if (direction === 'desc') sorted.reverse();
  return sorted;
}

function renderTable(
  container: HTMLElement, state: ProfitState, onChange: () => void,
): void {
  const filtered = applyFilters(state);
  const sorted = applySort(filtered, state.sortColumn, state.sortDirection);
  const totalPages = Math.ceil(sorted.length / ROWS_PER_PAGE);
  const page = Math.min(Math.max(state.tablePage, 1), Math.max(1, totalPages));
  state.tablePage = page;
  const start = (page - 1) * ROWS_PER_PAGE;
  const pageItems = sorted.slice(start, start + ROWS_PER_PAGE);

  const columns = [
    { key: 'checked', label: '☑', sortable: false },
    { key: 'sku', label: 'SKU', sortable: true },
    { key: 'productName', label: '产品名称', sortable: true },
    { key: 'cumulativeProfit', label: '累计净利润', sortable: true },
    { key: 'avgMonthlyProfit', label: '月均净利润', sortable: true },
    { key: 'trend', label: '趋势(近3月)', sortable: true },
  ];

  let html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
  html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">';

  for (const col of columns) {
    const arrow = state.sortColumn === col.key
      ? (state.sortDirection === 'asc' ? ' ▲' : state.sortDirection === 'desc' ? ' ▼' : '')
      : '';
    html += `<th data-sort="${col.key}" style="padding:8px 10px;text-align:left;
      font-weight:600;font-size:11px;color:#64748b;cursor:${col.sortable ? 'pointer' : 'default'};
      white-space:nowrap;">${col.label}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const s of pageItems) {
    const checked = state.checkedSkus.has(s.sku);
    const trendHtml = s.trend != null
      ? `${s.trend >= 0 ? '↗' : '↘'} <span style="color:${s.trend >= 0 ? '#16a34a' : '#dc2626'}">${s.trend >= 0 ? '+' : ''}${s.trend.toFixed(0)}%</span>`
      : '—';

    html += `<tr data-sku="${escapeHtml(s.sku)}" style="border-bottom:1px solid #f1f5f9;
      ${checked ? 'background:#eef2ff;' : ''}">
      <td style="padding:6px 10px;"><input type="checkbox" data-sku-check="${escapeHtml(s.sku)}" ${checked ? 'checked' : ''}></td>
      <td style="padding:6px 10px;font-weight:500;">${escapeHtml(s.sku)}</td>
      <td style="padding:6px 10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(s.productName)}">${escapeHtml(s.productName)}</td>
      <td style="padding:6px 10px;font-weight:600;color:${s.cumulativeProfit >= 0 ? '#16a34a' : '#dc2626'};">¥${s.cumulativeProfit.toLocaleString()}</td>
      <td style="padding:6px 10px;">¥${Math.round(s.avgMonthlyProfit).toLocaleString()}</td>
      <td style="padding:6px 10px;">${trendHtml}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  html += `<div style="display:flex;justify-content:space-between;align-items:center;
    padding:8px 0;font-size:11px;color:#666;">
    <span>共 ${sorted.length} 条，第 ${page}/${Math.max(1, totalPages)} 页</span>
    <span>
      <button data-table-page="prev" ${page <= 1 ? 'disabled' : ''}
        style="padding:3px 8px;font-size:11px;border:1px solid #ddd;border-radius:3px;cursor:pointer;">上一页</button>
      <button data-table-page="next" ${page >= totalPages ? 'disabled' : ''}
        style="padding:3px 8px;font-size:11px;border:1px solid #ddd;border-radius:3px;cursor:pointer;">下一页</button>
    </span>
  </div>`;

  container.innerHTML = html;

  // Checkbox click -> bidirectional sync with charts
  container.querySelectorAll('input[data-sku-check]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const sku = (e.target as HTMLElement).dataset.skuCheck!;
      if ((e.target as HTMLInputElement).checked) {
        if (state.checkedSkus.size >= 10) {
          const oldest = [...state.checkedSkus][0];
          state.checkedSkus.delete(oldest);
        }
        state.checkedSkus.add(sku);
      } else {
        state.checkedSkus.delete(sku);
      }
      onChange();
    });
  });

  // Column header sort
  container.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = (th as HTMLElement).dataset.sort!;
      if (state.sortColumn === col) {
        state.sortDirection =
          state.sortDirection === 'asc' ? 'desc' :
          state.sortDirection === 'desc' ? 'none' : 'asc';
      } else {
        state.sortColumn = col;
        state.sortDirection = 'asc';
      }
      onChange();
    });
  });

  // Pagination
  container.querySelector('[data-table-page="prev"]')?.addEventListener('click', () => {
    if (state.tablePage > 1) { state.tablePage--; onChange(); }
  });
  container.querySelector('[data-table-page="next"]')?.addEventListener('click', () => {
    if (state.tablePage < totalPages) { state.tablePage++; onChange(); }
  });
}

function renderLineChart(
  canvas: HTMLCanvasElement,
  state: ProfitState,
  highlightedSku: string | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const pad = { top: 20, right: 20, bottom: 55, left: 70 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  const filtered = applyFilters(state);
  const checkedSkus = [...state.checkedSkus].filter(sku =>
    filtered.some(s => s.sku === sku));
  const months = state.months;

  if (checkedSkus.length === 0 || months.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('请勾选 SKU 以查看趋势', W / 2, H / 2);
    return;
  }

  // Compute Y range from all checked
  let minVal = 0, maxVal = 0;
  for (const sku of checkedSkus) {
    const s = state.summaries.find(x => x.sku === sku);
    if (!s) continue;
    for (const m of months) {
      const v = s.monthlyProfit[m];
      if (v != null) { if (v < minVal) minVal = v; if (v > maxVal) maxVal = v; }
    }
  }
  const yRange = Math.max(Math.abs(maxVal), Math.abs(minVal), 1);
  const yMax = yRange * 1.15;
  const yMin = minVal < 0 ? minVal * 1.15 : -yRange * 0.15;

  function x(mi: number): number {
    return pad.left + (mi / Math.max(months.length - 1, 1)) * plotW;
  }
  function y(val: number): number {
    return pad.top + ((yMax - val) / (yMax - yMin)) * plotH;
  }

  // Grid lines
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = pad.top + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(W - pad.right, gy);
    ctx.stroke();

    const val = yMax - (i / 4) * (yMax - yMin);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`¥${Math.round(val).toLocaleString()}`, pad.left - 6, gy + 4);
  }

  // X axis labels
  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < months.length; i++) {
    ctx.fillText(months[i], x(i), H - pad.bottom + 20);
  }

  // Draw lines
  for (let si = 0; si < checkedSkus.length; si++) {
    const sku = checkedSkus[si];
    const s = state.summaries.find(x => x.sku === sku);
    if (!s) continue;

    const color = SKU_COLORS[si % SKU_COLORS.length];
    const isHighlighted = highlightedSku === sku;
    const hasHighlight = highlightedSku != null;

    ctx.strokeStyle = color;
    ctx.lineWidth = isHighlighted ? 3 : 1;
    ctx.globalAlpha = hasHighlight && !isHighlighted ? 0.2 : 1;
    ctx.beginPath();

    let firstPoint = true;
    for (let mi = 0; mi < months.length; mi++) {
      const v = s.monthlyProfit[months[mi]];
      if (v == null) { firstPoint = true; continue; }
      const px = x(mi);
      const py = y(v);
      if (firstPoint) { ctx.moveTo(px, py); firstPoint = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Data points
    ctx.globalAlpha = 1;
    for (let mi = 0; mi < months.length; mi++) {
      const v = s.monthlyProfit[months[mi]];
      if (v == null) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(mi), y(v), hasHighlight && !isHighlighted ? 2 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;

  // Legend at bottom
  let lx = pad.left;
  let ly = H - pad.bottom + 36;
  ctx.font = '10px sans-serif';
  for (let si = 0; si < checkedSkus.length; si++) {
    const sku = checkedSkus[si];
    const s = state.summaries.find(x => x.sku === sku);
    if (!s) continue;
    const color = SKU_COLORS[si % SKU_COLORS.length];
    const label = `${sku} (${s.brand})`;
    const labelW = ctx.measureText(label).width + 20;
    if (lx + labelW > W - pad.right) { lx = pad.left; ly += 18; }

    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 4, 12, 12);
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 16, ly + 4);
    lx += labelW;
  }

  // Store data point positions for click detection
  (canvas as any).__profitPoints = { months, checkedSkus, x, y, state };
}

function setupLineChartClick(
  canvas: HTMLCanvasElement,
  onDataPointClick: (sku: string, month: string) => void,
): void {
  canvas.addEventListener('click', (e) => {
    const data = (canvas as any).__profitPoints;
    if (!data) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const sku of data.checkedSkus) {
      const s = data.state.summaries.find(
        (x: SkuProfitSummary) => x.sku === sku,
      );
      if (!s) continue;
      for (let mi = 0; mi < data.months.length; mi++) {
        const v = s.monthlyProfit[data.months[mi]];
        if (v == null) continue;
        const px = data.x(mi);
        const py = data.y(v);
        if (Math.hypot(mx - px, my - py) < 8) {
          onDataPointClick(sku, data.months[mi]);
          return;
        }
      }
    }
  });
}

function setupLineChartHover(
  canvas: HTMLCanvasElement,
  tooltip: HTMLElement,
  state: ProfitState,
  onHoverChange: (sku: string | null) => void,
): void {
  canvas.addEventListener('mousemove', (e) => {
    const data = (canvas as any).__profitPoints;
    if (!data) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closestSku: string | null = null;
    let closestDist = Infinity;
    let closestMonth = '';
    let closestProfit = 0;

    for (const sku of data.checkedSkus) {
      const s = data.state.summaries.find(
        (x: SkuProfitSummary) => x.sku === sku,
      );
      if (!s) continue;
      for (let mi = 0; mi < data.months.length; mi++) {
        const v = s.monthlyProfit[data.months[mi]];
        if (v == null) continue;
        const px = data.x(mi);
        const py = data.y(v);
        const dist = Math.hypot(mx - px, my - py);
        if (dist < 16 && dist < closestDist) {
          closestDist = dist;
          closestSku = sku;
          closestMonth = data.months[mi];
          closestProfit = v;
        }
      }
    }

    if (closestSku) {
      const s = data.state.summaries.find(
        (x: SkuProfitSummary) => x.sku === closestSku,
      );
      const monthIdx = data.months.indexOf(closestMonth);
      const prevMonth = monthIdx > 0 ? data.months[monthIdx - 1] : null;
      const prevProfit = prevMonth ? s?.monthlyProfit[prevMonth] : null;
      const momChange = prevProfit != null && prevProfit !== 0
        ? `${(((closestProfit - prevProfit) / Math.abs(prevProfit)) * 100).toFixed(0)}%`
        : '—';
      const arrow = prevProfit != null && closestProfit > prevProfit ? '↗'
        : prevProfit != null && closestProfit < prevProfit ? '↘' : '';
      tooltip.innerHTML = `${s?.sku || closestSku} · ${closestMonth}<br>
        净利润: ¥${Math.round(closestProfit).toLocaleString()}<br>
        环比: ${arrow} ${momChange}`;
      tooltip.style.display = '';
      tooltip.style.top = (e.clientY - (canvas.getBoundingClientRect().top + canvas.ownerDocument.defaultView!.scrollY) - 10) + 'px';
      tooltip.style.left = (mx + 14) + 'px';
    } else {
      tooltip.style.display = 'none';
    }

    onHoverChange(closestSku);
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    onHoverChange(null);
  });
}

function renderBarChart(canvas: HTMLCanvasElement, state: ProfitState): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const pad = { top: 10, right: 10, bottom: 30, left: 10 };
  const plotW = W - pad.left - pad.right;

  ctx.clearRect(0, 0, W, H);

  const filtered = applyFilters(state);
  const sorted = [...filtered].sort((a, b) => b.cumulativeProfit - a.cumulativeProfit);
  const totalPages = Math.ceil(sorted.length / BARS_PER_PAGE);
  const page = Math.min(Math.max(state.barPage, 1), Math.max(1, totalPages));
  state.barPage = page;
  const start = (page - 1) * BARS_PER_PAGE;
  const pageItems = sorted.slice(start, start + BARS_PER_PAGE);

  if (pageItems.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('无数据', W / 2, H / 2);
    return;
  }

  const paginationH = totalPages > 1 ? 25 : 0;
  const barH = Math.min(28, (H - pad.top - pad.bottom - 20 - paginationH) / pageItems.length);
  const gap = 4;
  const maxAbs = Math.max(...pageItems.map(s => Math.abs(s.cumulativeProfit)), 1);
  const labelWidth = 100; // space for SKU labels
  const zeroX = pad.left + labelWidth;
  const barMaxW = plotW - labelWidth - 80; // 80px for value labels

  // Title
  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('累计净利润排名', pad.left, pad.top);

  for (let i = 0; i < pageItems.length; i++) {
    const s = pageItems[i];
    const bw = (Math.abs(s.cumulativeProfit) / maxAbs) * barMaxW;
    const by = pad.top + 14 + i * (barH + gap);

    // SKU label (right-aligned before zero line)
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(s.sku, zeroX - 6, by + barH / 2 + 4);

    // Bar
    ctx.fillStyle = s.cumulativeProfit >= 0 ? '#22c55e' : '#ef4444';
    const barX = s.cumulativeProfit >= 0 ? zeroX + 4 : zeroX - 4 - bw;
    ctx.fillRect(barX, by, bw, barH);

    // Value label
    ctx.fillStyle = '#333';
    ctx.font = '10px sans-serif';
    ctx.textAlign = s.cumulativeProfit >= 0 ? 'left' : 'right';
    const vx = s.cumulativeProfit >= 0 ? barX + bw + 4 : barX - 4;
    ctx.fillText(`¥${Math.round(s.cumulativeProfit).toLocaleString()}`, vx, by + barH / 2 + 4);
  }

  // Pagination
  if (totalPages > 1) {
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`第 ${page}/${totalPages} 页    ← 上一页 | 下一页 →`, W / 2, H - 4);
  }

  (canvas as any).__barClickData = { pageItems, barH, gap, pad, zeroX, barMaxW, maxAbs, page, totalPages };
}

function setupBarChartClick(
  canvas: HTMLCanvasElement, state: ProfitState, onChange: () => void,
): void {
  canvas.addEventListener('click', (e) => {
    const data = (canvas as any).__barClickData;
    if (!data) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Pagination click
    if (data.totalPages > 1 && my > rect.height - 25) {
      if (mx < rect.width / 2) {
        if (state.barPage > 1) { state.barPage--; onChange(); }
      } else {
        if (state.barPage < data.totalPages) { state.barPage++; onChange(); }
      }
      return;
    }

    // Bar click
    for (let i = 0; i < data.pageItems.length; i++) {
      const by = data.pad.top + 14 + i * (data.barH + data.gap);
      if (my >= by && my < by + data.barH) {
        const sku = data.pageItems[i].sku;
        if (!state.checkedSkus.has(sku)) {
          if (state.checkedSkus.size >= 10) {
            state.checkedSkus.delete([...state.checkedSkus][0]);
          }
          state.checkedSkus.add(sku);
        }
        // Jump to correct table page for this SKU
        const filtered = applyFilters(state);
        const sorted = applySort(filtered, state.sortColumn, state.sortDirection);
        const skuIndex = sorted.findIndex(s => s.sku === sku);
        if (skuIndex >= 0) {
          state.tablePage = Math.floor(skuIndex / ROWS_PER_PAGE) + 1;
        }
        onChange();
        // Scroll after re-render
        requestAnimationFrame(() => {
          const tr = canvas.closest('.erp-profit-panel')?.querySelector(`tr[data-sku="${escapeHtml(sku)}"]`);
          tr?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        break;
      }
    }
  });
}

function renderChannelBreakdown(
  container: HTMLElement, state: ProfitState,
): void {
  if (!state.channelBreakdownSku || !state.channelBreakdownMonth) {
    container.style.display = 'none';
    return;
  }

  const s = state.summaries.find(x => x.sku === state.channelBreakdownSku);
  if (!s) { container.style.display = 'none'; return; }

  const breakdown = s.channelBreakdown[state.channelBreakdownMonth];
  if (!breakdown) { container.style.display = 'none'; return; }

  container.style.display = '';
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <span style="font-weight:600;font-size:12px;">
        ${escapeHtml(s.sku)} · ${state.channelBreakdownMonth} 渠道构成
      </span>
      <span style="font-size:10px;color:#94a3b8;">
        合计 ¥${Math.round(total).toLocaleString()}
        <button id="profit-cb-close" style="margin-left:8px;padding:2px 6px;font-size:10px;
          background:transparent;border:1px solid #ddd;border-radius:3px;cursor:pointer;">× 关闭</button>
      </span>
    </div>
    <div style="display:flex;gap:2px;height:24px;border-radius:4px;overflow:hidden;margin-bottom:8px;">
      ${entries.map(([plat, val]) => {
        const pct = total !== 0 ? (val / total * 100) : 0;
        const color = PLATFORM_COLORS[plat] || '#94a3b8';
        return `<div style="width:${Math.max(pct, 2)}%;background:${color};"
          title="${plat}: ¥${Math.round(val).toLocaleString()} (${pct.toFixed(1)}%)"></div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;">
      ${entries.map(([plat, val]) => {
        const color = PLATFORM_COLORS[plat] || '#94a3b8';
        return `<span><span style="display:inline-block;width:10px;height:10px;
          background:${color};border-radius:2px;margin-right:4px;"></span>
          ${escapeHtml(plat)}: ¥${Math.round(val).toLocaleString()}</span>`;
      }).join('')}
    </div>
  `;

  container.querySelector('#profit-cb-close')?.addEventListener('click', () => {
    state.channelBreakdownSku = null;
    state.channelBreakdownMonth = null;
    container.style.display = 'none';
  });
}

function renderAll(panel: HTMLElement, state: ProfitState): void {
  const lineCanvas = panel.querySelector('#profit-line-canvas') as HTMLCanvasElement;
  const barCanvas = panel.querySelector('#profit-bar-canvas') as HTMLCanvasElement;
  const channelBreakdown = panel.querySelector('#profit-channel-breakdown') as HTMLElement;
  const filtersContainer = panel.querySelector('#profit-filters') as HTMLElement;
  const tableContainer = panel.querySelector('#profit-table') as HTMLElement;

  let highlightedSku: string | null = null;

  function refresh(): void {
    renderLineChart(lineCanvas, state, highlightedSku);
    renderBarChart(barCanvas, state);
    renderFilters(filtersContainer, state, refresh);
    renderTable(tableContainer, state, refresh);
  }

  refresh();

  setupLineChartClick(lineCanvas, (sku, month) => {
    state.channelBreakdownSku = sku;
    state.channelBreakdownMonth = month;
    renderChannelBreakdown(channelBreakdown, state);
  });

  const tooltipEl = panel.querySelector('#profit-tooltip') as HTMLElement;
  setupLineChartHover(lineCanvas, tooltipEl, state, (hl) => {
    highlightedSku = hl;
    renderLineChart(lineCanvas, state, highlightedSku);
  });

  setupBarChartClick(barCanvas, state, refresh);

  panel.querySelector('#profit-refresh')?.addEventListener('click', () => {
    location.reload();
  });
}

function showError(doc: Document, message: string): void {
  const el = doc.createElement('div');
  el.style.cssText =
    'margin:16px;padding:12px;background:#fff3cd;color:#856404;' +
    'border:1px solid #ffc107;border-radius:8px;font-size:13px;';
  el.textContent = message;
  doc.body?.appendChild(el);
}
