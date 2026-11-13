// modules/transfer-plan/ui.ts
// AI transfer order analysis panel — ASIN-based, injected into transferOrderAdd page.

import type { LlmSuggestion, MarketGroup } from '../types';
import { getSettings } from '../../shared/settings';
import { addLog } from '../../shared/analysis-log';
import {
  fetchAndSummarizeTransfer,
  buildTransferPrompt,
  sourceWarehouseStatus,
  sourceWarehouseBadgeHtml,
  shortageConclusionLine,
  type AsinSummary,
} from '../../shared/jijia-transfer-data';
import { computeTransferQty, riskLevelFromRemainingDays } from '../../shared/qty-formula';
import { ErpApiError, erpErrorNoticeHtml } from '../../shared/erp-errors';
import { parseLogisticsDays } from '../../shared/logistics-days';
import { resolveTransferTarget } from '../../shared/transfer-target';
import { normalizeUiScale } from '../../shared/ui-scale';
import { PANEL_BUILD } from '../../shared/panel-dedup';
import { createScanRegistry, findTableScroller, sweepTableScroller } from '../../shared/scan-registry';
import {
  domesticNonLendable, nonLendableChipsHtml, readNonLendableGroups,
  transferSourceWarning, type DomesticSiteGroup,
} from '../../shared/domestic-pool';
import { versionBadgeHtml } from '../../shared/panel-version';
import {
  isExtensionContextValid, isExtensionContextInvalidatedError, extensionInvalidatedNoticeHtml,
} from '../../shared/extension-context';
import { streamChat } from '../../shared/llm-client';
import { parseLlmResponse } from '../../shared/llm-parser';

const RISK_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#10b981',
};
const RISK_LABELS: Record<string, string> = {
  red: '紧急调拨',
  yellow: '建议调拨',
  green: '无需调拨',
};

// 面板默认收起（方案A，2026-08-28 用户确认）：AI 面板插在文档流里会挤占原生
// SKU 表格（实测无法下拉），收起时只剩头部细栏。状态存模块级——SPA 切页重注入
// 保持，整页刷新回默认收起（与利润看板 profitCollapsed 同款处理）
let transferPanelCollapsed = true;

// 国内不可借站点组（2026-09-08 借用排除）：不持久化，SPA 重注入保持、整页刷新回默认
let nonLendableSelected = new Set<DomesticSiteGroup>();

export function render(_container: HTMLElement, ctx: unknown, doc?: Document): void {
  const root = doc || document;
  if (root.querySelector('.erp-transfer-ai-panel')) return;

  let tries = 0;
  function tryInject(): void {
    // Abort if document is no longer active (iframe navigated away)
    if (!root.body?.isConnected) return;
    // Check DOM again — another tryInject may have injected between retries
    if (root.querySelector('.erp-transfer-ai-panel')) return;
    tries++;
    const table = root.querySelector('.surely-table') || root.querySelector('.arco-form');
    if (!table && tries < 30) { setTimeout(tryInject, 2000); return; }
    if (!table) return;

    const marker = root.createElement('span');
    marker.className = 'erp-transfer-ai-panel';
    marker.hidden = true;
    root.body?.appendChild(marker);

    // --- Build panel ---
    const panel = root.createElement('div');
    panel.className = 'erp-transfer-ai-panel';
  panel.dataset.erpBuild = PANEL_BUILD;
    panel.style.cssText =
      'margin:10px 0;background:#fff;border:1px solid #e2e8f0;border-radius:10px;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.06),0 0 0 3px #f8fafc;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;' +
      'overflow:hidden;';
    // 面板整体缩放（设置→界面；cssText 之后设置，否则会被整体覆盖；ctx 由 content.ts 注入 settings 快照）
    panel.style.zoom = String(normalizeUiScale(
      ((ctx as { settings?: { uiScale?: number } })?.settings)?.uiScale ?? 1));

    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;' +
      'padding:14px 18px;background:#fafbfc;border-bottom:1px solid #f1f5f9;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span style="display:flex;align-items:center;justify-content:center;' +
          'width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#818cf8);' +
          'color:#fff;font-size:14px;">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M12 2l3 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z"/>' +
            '</svg>' +
          '</span>' +
          '<div>' +
            '<span style="font-weight:700;font-size:14px;color:#1e293b;">AI 调拨建议</span>' +
            '<span style="display:inline-block;margin-left:6px;padding:1px 8px;' +
            'background:#e0e7ff;color:#6366f1;border-radius:10px;font-size:10px;font-weight:600;">BETA</span>' +
            versionBadgeHtml() +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button id="erp-transfer-analyze" style="padding:7px 14px;background:#6366f1;color:#fff;' +
          'border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;">' +
            '开始分析' +
          '</button>' +
          '<button id="erp-transfer-append" style="padding:7px 14px;background:#fff;color:#6366f1;' +
          'border:1px solid #c7d2fe;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;display:none;">' +
            '追加分析' +
          '</button>' +
          '<button id="erp-transfer-fill" style="padding:7px 14px;background:#10b981;color:#fff;' +
          'border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;display:none;">' +
            '填入备注' +
          '</button>' +
          '<button id="erp-tp-collapse" title="折叠/展开" style="padding:7px 10px;background:#fff;' +
          'color:#64748b;border:1px solid #e2e8f0;border-radius:7px;cursor:pointer;font-size:12px;' +
          'font-weight:700;line-height:1;">' +
            '+' +
          '</button>' +
        '</div>' +
      '</div>' +
      // 内容区整体限高内滚（多 ASIN 也不吃掉大半屏，原生表格始终可见）；
      // output 不再单独 420px 限高，避免双层滚动条
      '<div id="erp-tp-body" style="max-height:30vh;overflow-y:auto;">' +
      '<div id="erp-transfer-inputs" style="padding:10px 18px;border-bottom:1px solid #f1f5f9;display:none;"></div>' +
      '<div id="erp-transfer-output" style="padding:12px 18px;"></div>' +
      '</div>';

    // Find a good insertion point —— 插在表格包装层之外：.surely-table 的父容器
    // 是虚拟表格的滚动容器，在其内部插入会挤占/干扰原生表格（2026-08-28 用户
    // 实测 SKU 列表只剩一行且无法下拉）；包装层不存在或就是 body 时退回原位置
    // （面板必须留在 body 内，否则脱离页面样式与清理范围）
    const target = root.querySelector('.surely-table') || table;
    const wrap = target.parentElement;
    if (wrap && wrap !== root.body && wrap.parentElement) {
      wrap.parentElement.insertBefore(panel, wrap);
    } else if (target.parentElement) {
      target.parentElement.insertBefore(panel, target);
    } else {
      root.body?.appendChild(panel);
    }

    // --- State ---
    const analyzedAsins = new Set<string>();
    const allSuggestions: LlmSuggestion[] = [];
    // 调出仓状态（feature/suggestion-update）：跨轮累积——追加分析只抓新品，
    // 旧卡片仍需各自的徽章（Map 生命周期 = 面板生命周期，同 analyzedAsins）
    const srcStatusMap = new Map<string, string | null>();
    // 物流方式可能先于 SKU 行被选中（变化检测触发时输入框还不存在），
    // 常驻记录最近一次解析出的头程天数，新建 ASIN 行以此作默认值
    let logisticsDays: number | null = null;
    // 目标市场自动填充：表单"平台站点"控件是调拨目的地的权威声明；
    // 运营手动改过输入框（dirty）后不再自动覆盖
    let marketInputDirty = false;

    // --- Collect ASINs from table cells ---
    function collectAsins(): { asins: string[]; skus: string[] } {
      const asinSet: Record<string, boolean> = {};
      const skuSet: Record<string, boolean> = {};

      const rows = root.querySelectorAll('.surely-table-row');
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (row.querySelector('.surely-table-header-cell')) continue;

        const cells = row.querySelectorAll('.surely-table-cell-content');
        let asin = '';
        let sku = '';

        for (let c = 0; c < cells.length; c++) {
          const text = (cells[c].textContent || '').trim();
          if (!text || text === '--') continue;

          // Detect ASIN: /^B0[A-Z0-9]{8}$/
          if (/^B0[A-Z0-9]{8}$/.test(text)) {
            asin = text;
            continue;
          }

          // Extract substrings that look like SKUs
          const candidates = text.match(/[A-Z0-9]{4,20}/g);
          if (candidates) {
            for (const m of candidates) {
              if (/^B0/.test(m) || /^X00/.test(m) || m.includes('-')) continue;
              const letterCount = (m.match(/[A-Z]/g) || []).length;
              const digitCount = (m.match(/[0-9]/g) || []).length;
              if (letterCount < 2 || digitCount < 1) continue;
              if (digitCount > letterCount * 4) continue;
              if (!sku || m.length <= 15) {
                sku = m;
              }
            }
          }
        }

        if (asin) {
          if (!asinSet[asin]) { asinSet[asin] = true; }
        }
        if (sku) {
          if (!skuSet[sku]) { skuSet[sku] = true; }
        }
      }

      return { asins: Object.keys(asinSet), skus: Object.keys(skuSet) };
    }

    // 累计登记：产品明细表是窗口化长列表（滚动时 DOM 可见行集变化），扫描取
    // 并集保证参数配置列表稳定；分析前 sweepCollectAsins 滚表全量对账
    // （剔除已删行、补全离屏行）——与采购面板同款（shared/scan-registry.ts）
    const asinRegistry = createScanRegistry<string>();
    const transferSkuRegistry = createScanRegistry<string>();
    function mergeAsinScan(): { asins: string[]; skus: string[] } {
      const r = collectAsins();
      return { asins: asinRegistry.merge(r.asins), skus: transferSkuRegistry.merge(r.skus) };
    }

    async function sweepCollectAsins(): Promise<{ asins: string[]; skus: string[] }> {
      asinRegistry.beginSweep();
      transferSkuRegistry.beginSweep();
      const scroller = findTableScroller(root);
      if (scroller) {
        await sweepTableScroller(scroller, function () { mergeAsinScan(); });
      } else {
        mergeAsinScan();
      }
      const asins = asinRegistry.endSweep();
      const skus = transferSkuRegistry.endSweep();
      addLog('asin_detect', '滚动扫描完成：表格共 ' + asins.length + ' 个ASIN');
      const key = asins.join(',');
      if (key !== lastAsinList) {
        lastAsinList = key;
        buildAsinInputs(asins);
      }
      return { asins, skus };
    }

    // --- Button refs ---
    const analyzeBtn = root.querySelector('#erp-transfer-analyze') as HTMLButtonElement;
    const appendBtn = root.querySelector('#erp-transfer-append') as HTMLButtonElement;
    const fillBtn = root.querySelector('#erp-transfer-fill') as HTMLButtonElement;
    const output = root.querySelector('#erp-transfer-output') as HTMLElement;
    const inputsDiv = root.querySelector('#erp-transfer-inputs') as HTMLElement;

    // --- 折叠（模块级状态，SPA 重注入保持）---
    const bodyDiv = root.querySelector('#erp-tp-body') as HTMLElement;
    const collapseBtn = root.querySelector('#erp-tp-collapse') as HTMLButtonElement;
    function applyCollapsed(): void {
      bodyDiv.style.display = transferPanelCollapsed ? 'none' : '';
      collapseBtn.textContent = transferPanelCollapsed ? '+' : '−';
    }
    collapseBtn.addEventListener('click', function () {
      transferPanelCollapsed = !transferPanelCollapsed;
      applyCollapsed();
    });
    // 分析/追加前自动展开（收起时点分析不需要先手动展开）
    function expandIfCollapsed(): void {
      if (transferPanelCollapsed) {
        transferPanelCollapsed = false;
        applyCollapsed();
      }
    }
    applyCollapsed();

    // 国内不可借 chips：委托监听挂 inputs 容器（参数行 innerHTML 重建不重复绑），
    // 勾选写回模块级 Set——参数区重渲染时从 Set 恢复勾选态
    inputsDiv.addEventListener('change', function (e: Event) {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('erp-nl-chip')) {
        nonLendableSelected = readNonLendableGroups(inputsDiv);
      }
    });

    // --- Per-ASIN input row builder ---
    function buildAsinInputs(asins: string[]): void {
      // Snapshot existing values before rebuilding
      const savedMarket = (inputsDiv.querySelector('#erp-tp-market') as HTMLInputElement | null)?.value || '';
      const saved: Record<string, { shipping: string; sellUntil: string; buffer: string; qty: string; note: string }> = {};
      const oldShipping = inputsDiv.querySelectorAll('.erp-tp-shipping');
      const oldSellUntil = inputsDiv.querySelectorAll('.erp-tp-sell-until');
      const oldBuffer = inputsDiv.querySelectorAll('.erp-tp-buffer');
      const oldQty = inputsDiv.querySelectorAll('.erp-tp-qty');
      const oldNote = inputsDiv.querySelectorAll('.erp-tp-note');
      for (let i = 0; i < oldShipping.length; i++) {
        const key = (oldShipping[i] as HTMLElement).dataset.asin || '';
        saved[key] = {
          shipping: (oldShipping[i] as HTMLInputElement).value,
          sellUntil: (oldSellUntil[i] as HTMLInputElement).value,
          buffer: (oldBuffer[i] as HTMLInputElement).value,
          qty: (oldQty[i] as HTMLInputElement).value,
          note: (oldNote[i] as HTMLInputElement).value,
        };
      }

      const today = new Date();
      today.setDate(today.getDate() + 90);
      const defaultSellUntil = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

      let html =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2">' +
            '<circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>' +
          '</svg>' +
          '<span style="font-size:11px;font-weight:600;color:#475569;">参数配置</span>' +
          '<span style="font-size:10px;color:#94a3b8;">每ASIN独立设置</span>' +
          '<span style="flex:1;"></span>' +
          '<span style="font-size:10px;color:#64748b;flex-shrink:0;">目标市场</span>' +
          '<input id="erp-tp-market" type="text" value="' + escape(savedMarket) + '" placeholder="自动：读表单站点" maxlength="8" ' +
            'style="width:92px;padding:3px 8px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;' +
            'font-size:11px;color:#1e293b;outline:none;text-transform:uppercase;" ' +
            'title="自动读取表单「平台站点」；可手动改为目的国代码（如 US/DE）；留空则自动取销量最高市场">' +
        '</div>' +
        nonLendableChipsHtml(nonLendableSelected);

      const defaultShipping = logisticsDays != null ? String(logisticsDays) : '25';
      for (const asin of asins) {
        const prev = saved[asin] || { shipping: defaultShipping, sellUntil: defaultSellUntil, buffer: '15', qty: '', note: '' };
        html +=
          '<div style="display:flex;align-items:center;gap:0;margin-bottom:3px;' +
          'background:#f8fafc;border:1px solid #f1f5f9;border-radius:6px;overflow:hidden;' +
          'transition:border-color .15s;">' +
            '<code style="font-size:11px;font-weight:600;color:#4f46e5;background:#eef2ff;' +
            'padding:6px 10px;min-width:100px;text-align:center;flex-shrink:0;">' + escape(asin) + '</code>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">头程</span>' +
            '<input class="erp-tp-shipping" data-asin="' + escape(asin) + '" type="number" value="' + prev.shipping + '" min="0" max="365" ' +
            'style="width:36px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;font-weight:500;">' +
            '<span style="font-size:10px;color:#94a3b8;padding-right:4px;">天</span>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">卖到</span>' +
            '<input class="erp-tp-sell-until" data-asin="' + escape(asin) + '" type="date" value="' + prev.sellUntil + '" min="' + todayStr + '" ' +
            'style="width:108px;padding:3px 4px;border:none;background:transparent;font-size:11px;' +
            'color:#1e293b;outline:none;">' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">冗余</span>' +
            '<input class="erp-tp-buffer" data-asin="' + escape(asin) + '" type="number" value="' + prev.buffer + '" min="0" max="365" ' +
            'style="width:36px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;font-weight:500;">' +
            '<span style="font-size:10px;color:#94a3b8;padding-right:6px;">天</span>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 5px 0 6px;flex-shrink:0;">预测调拨量</span>' +
            '<input class="erp-tp-qty" data-asin="' + escape(asin) + '" type="number" value="' + prev.qty + '" min="0" placeholder="—" ' +
            'style="width:52px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;">' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 5px 0 6px;flex-shrink:0;">备注</span>' +
            '<input class="erp-tp-note" data-asin="' + escape(asin) + '" type="text" value="' + escape(prev.note) + '" placeholder="—" ' +
            'style="flex:1;min-width:0;padding:3px 6px;border:none;background:transparent;font-size:11px;' +
            'color:#1e293b;outline:none;">' +
          '</div>';
      }
      inputsDiv.innerHTML = html;
      if (asins.length > 0) inputsDiv.style.display = 'block';
      const marketInput = inputsDiv.querySelector('#erp-tp-market') as HTMLInputElement | null;
      marketInput?.addEventListener('input', function () { marketInputDirty = true; });
    }

    // Auto-scan for ASINs
    let lastAsinList = '';
    function scanAsinInputs(): void {
      const { asins } = mergeAsinScan();
      const key = asins.join(',');
      if (key !== lastAsinList) {
        lastAsinList = key;
        buildAsinInputs(asins);
      }
    }

    // 物流方式 → 头程天数同步：ERP 表单选择物流方式后（选项文本自带时效，
    // 如"欧洲卡航递延（30-40天）"），解析天数并写入参数配置的头程输入；
    // 运营仍可手动微调，物流方式再变时再次覆盖
    let lastLogisticsText = '';
    function syncShippingFromLogistics(): void {
      for (const fi of root.querySelectorAll('.arco-form-item')) {
        const label = fi.querySelector('.arco-form-item-label')?.textContent || '';
        if (!label.includes('物流方式')) continue;
        const val = (fi.querySelector('.arco-select-view-value, [class*="select-view-value"]')?.textContent || '').trim();
        if (val === lastLogisticsText) return;
        lastLogisticsText = val;
        const days = parseLogisticsDays(val);
        if (days == null || days <= 0) return;
        logisticsDays = days;
        inputsDiv.querySelectorAll('.erp-tp-shipping').forEach(inp => {
          (inp as HTMLInputElement).value = String(days);
        });
        if (val) addLog('done', '物流方式「' + val + '」→ 头程天数已同步为 ' + days + ' 天');
        return;
      }
    }

    // 表单控件 → 目标市场自动填充。解析逻辑抽为纯函数 resolveTransferTarget
    // （shared/transfer-target.ts，优先级：调入仓库 → 平台站点 → none 有单测锁定）；
    // 运营手动改过目标市场输入则不覆盖（dirty 保护）。
    let lastTarget = resolveTransferTarget('', '');
    function readSelectLabel(keyword: string): string {
      for (const fi of root.querySelectorAll('.arco-form-item')) {
        const label = fi.querySelector('.arco-form-item-label')?.textContent || '';
        if (!label.includes(keyword)) continue;
        return (fi.querySelector('.arco-select-view-value, [class*="select-view-value"]')?.textContent || '').trim();
      }
      return '';
    }
    function syncTargetFromForm(): void {
      lastTarget = resolveTransferTarget(readSelectLabel('调入仓库'), readSelectLabel('平台站点'));
    }

    function applyTargetMarket(): void {
      const input = inputsDiv.querySelector('#erp-tp-market') as HTMLInputElement | null;
      if (!input || marketInputDirty) return;
      const country = lastTarget.country;
      if (country && input.value.trim().toUpperCase() !== country) input.value = country;
    }

    // 扩展重载/更新自检：注入时有效→之后失效（chrome.runtime.id 消失）即整个
    // 面板替换为刷新指引并停轮询（与采购面板同款，shared/extension-context.ts）
    const hadExtensionContext = isExtensionContextValid();
    const scanTimer = setInterval(() => {
      if (hadExtensionContext && !isExtensionContextValid()) {
        bodyDiv.innerHTML = extensionInvalidatedNoticeHtml();
        addLog('error', '扩展已更新或重新加载，请刷新页面');
        clearInterval(scanTimer);
        return;
      }
      scanAsinInputs();
      syncShippingFromLogistics();
      syncTargetFromForm();
      applyTargetMarket();
    }, 2000);
    scanAsinInputs();
    syncShippingFromLogistics();
    syncTargetFromForm();
    applyTargetMarket();

    /** Read per-ASIN values back and apply to summaries */
    function applyAsinInputs(summaries: AsinSummary[]): void {
      const shippingInputs = inputsDiv.querySelectorAll('.erp-tp-shipping');
      const sellUntilInputs = inputsDiv.querySelectorAll('.erp-tp-sell-until');
      const bufferInputs = inputsDiv.querySelectorAll('.erp-tp-buffer');
      const qtyInputs = inputsDiv.querySelectorAll('.erp-tp-qty');
      const noteInputs = inputsDiv.querySelectorAll('.erp-tp-note');

      for (let i = 0; i < shippingInputs.length; i++) {
        const asin = (shippingInputs[i] as HTMLElement).dataset.asin;
        const sv = parseInt((shippingInputs[i] as HTMLInputElement).value, 10);
        const bv = parseInt((bufferInputs[i] as HTMLInputElement).value, 10);
        const shipping = Number.isNaN(sv) ? 25 : sv;
        const sellUntil = (sellUntilInputs[i] as HTMLInputElement).value;
        const buffer = Number.isNaN(bv) ? 15 : bv;
        const qty = parseInt((qtyInputs[i] as HTMLInputElement).value, 10);
        const note = (noteInputs[i] as HTMLInputElement).value.trim();
        const s = summaries.find(function(x) { return x.asin === asin; });
        if (s) {
          s.shippingDays = Math.max(0, Math.min(365, shipping));
          s.sellUntilDate = sellUntil;
          s.bufferDays = Math.max(0, Math.min(365, buffer));
          if (qty > 0) s.operatorQty = qty;
          if (note) s.operatorNote = note;
        }
      }
    }

    // --- Fill remarks ---
    function fillRemarks(): void {
      if (allSuggestions.length === 0) return;
      const remarkText = allSuggestions
        .map(function (s) {
          const riskLabel = RISK_LABELS[s.riskLevel] || '';
          return '【' + s.sku + '】' + (riskLabel ? '[' + riskLabel + '] ' : '') + s.suggestion;
        })
        .join('\n');

      const textareas = root.querySelectorAll('textarea');
      if (textareas.length > 0) {
        const ta = textareas[0] as HTMLTextAreaElement;
        ta.value = remarkText;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        addLog('done', '已填入 ' + allSuggestions.length + ' 条调拨建议到备注');
      } else {
        navigator.clipboard.writeText(remarkText).then(function () {
          addLog('done', '备注已复制到剪贴板（' + allSuggestions.length + ' 条）');
        }).catch(function () {
          addLog('error', '复制失败，请手动复制');
        });
      }
    }

    // --- Shared analysis ---
    async function runAnalysis(targetAsins: string[], targetSkus: string[], isAppend: boolean): Promise<void> {
      const startTs = Date.now();
      addLog('asin_detect', '检测到 ' + targetAsins.length + ' 个ASIN' + (isAppend ? '（追加）' : '') + ': ' + targetAsins.join(', '));

      let summaries: AsinSummary[] = [];
      try {
        addLog('sales_fetch', '正在从积加获取销售和库存数据…');
        const marketGroups = (await getSettings()).marketGroups;
        const targetMarket = (inputsDiv.querySelector('#erp-tp-market') as HTMLInputElement | null)
          ?.value.trim().toUpperCase() || undefined;
        // 店铺优先取调入仓库（权威），平台站点兜底
        const targetStore = lastTarget.store || undefined;
        if (targetMarket) {
          addLog('done', '目标市场: ' + targetMarket + (targetStore ? '（店铺: ' + targetStore + '）' : '') + '（无数据的市场回落销量最高市场）');
        } else {
          addLog('warn', '未识别目标市场（未选调入仓库/平台站点，且未手动输入），将按销量最高市场口径分析，请核对');
        }
        summaries = await fetchAndSummarizeTransfer(targetAsins, targetSkus, undefined, root, marketGroups, targetMarket, targetStore);
        applyAsinInputs(summaries);
        let builtinNotified = false;
        for (const s of summaries) {
          if (s.marketGroupBuiltin && !builtinNotified) {
            builtinNotified = true;
            addLog('done', '目标市场 EU：使用内置欧洲站汇总组（设置中未配置名为「EU」的汇总组，可在扩展设置里自定义）');
          }
          if (targetMarket && s.marketScope === 'top-market') {
            addLog('warn', s.asin + ': 目标市场 ' + targetMarket + ' 无匹配数据，已回落至销量最高市场 ' + (s.marketName || '?') + '，请核对');
          }
          if (s.missingGroupMarkets && s.missingGroupMarkets.length > 0) {
            addLog('warn', s.asin + ': 汇总组中以下站点无数据，请检查站点代码是否正确: ' + s.missingGroupMarkets.join(', '));
          }
        }
        addLog('sales_done', '数据获取完成 (匹配 ' + summaries.length + '/' + targetAsins.length + ' 个ASIN)');
      } catch (e: any) {
        if (isExtensionContextInvalidatedError(e)) {
          // 扩展重载/更新后旧上下文失效——给刷新指引而非英文裸错误
          output.innerHTML = extensionInvalidatedNoticeHtml();
          addLog('error', '扩展已更新或重新加载，请刷新页面');
        } else {
          output.innerHTML = e instanceof ErpApiError
            ? erpErrorNoticeHtml(e)
            : '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
              'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
                '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
                '<div style="font-size:12px;color:#991b1b;line-height:1.5;">获取数据失败: ' + escape(e.message || '') + '</div>' +
              '</div>';
          addLog('error', '获取数据失败: ' + (e.message || ''));
        }
        resetButtons();
        return;
      }

      if (summaries.length === 0) {
        output.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
          'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
            '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
            '<div style="font-size:12px;color:#991b1b;line-height:1.5;">这些ASIN在积加系统中无销售数据</div>' +
          '</div>';
        addLog('error', 'ASIN无销售数据');
        resetButtons();
        return;
      }

      // Mark as analyzed
      for (const s of summaries) { analyzedAsins.add(s.asin); }

      // 调出仓（feature/suggestion-update）：读一次，提示词与前端状态行共用；
      // 数据已就绪——状态行即刻渲染，不等 AI
      const sourceWhLabel = readSelectLabel('调出仓库');
      for (const s of summaries) {
        srcStatusMap.set(s.sku, sourceWarehouseStatus(sourceWhLabel, s.domesticWarehouses));
      }
      if (sourceWhLabel) {
        const vals = Array.from(srcStatusMap.values()).filter(v => v !== null);
        if (vals.length === 0) {
          addLog('warn', '调出仓: ' + sourceWhLabel + ' — 未能与库存仓匹配（已静默处理，若该仓名无误请反馈）');
        } else {
          const shortCount = vals.filter(v => v!.includes('缺货')).length;
          addLog('done', '调出仓: ' + sourceWhLabel + ' — 匹配正常' + (shortCount > 0 ? '（' + shortCount + '/' + vals.length + ' SKU 缺货）' : ''));
        }
      }

      // Build prompts（nonLendableSelected=借用排除组；调出仓一并传入——缺货时先提示缺货再荐替代仓）
      const prompts = summaries.map(function (s) { return buildTransferPrompt(s, nonLendableSelected, sourceWhLabel); }).join('\n---\n');
      addLog('prompt', prompts);

      // Read settings directly in content script (bypass SW)
      const { llmProvider, llmModel, apiKey, thinkingEnabled, reasoningEffort } = await getSettings();
      if (!llmProvider || !apiKey) {
        output.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
          'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
            '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
            '<div style="font-size:12px;color:#991b1b;line-height:1.5;">API Key 未配置</div>' +
          '</div>';
        resetButtons();
        return;
      }

      // 前端确定性状态行：数据一到就显示（AI 流式输出替换 spinner 时保留）
      const srcBox = summaries
        .map(function (s) { return sourceWarehouseBadgeHtml(srcStatusMap.get(s.sku) || null); })
        .join('');
      output.innerHTML =
        (srcBox ? '<div style="margin-bottom:8px;">' + srcBox + '</div>' : '') +
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px;">' +
          '<div style="display:flex;gap:7px;">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#6366f1;animation:erp-tp-dot-pulse 1.2s infinite;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;animation:erp-tp-dot-pulse 1.2s infinite .2s;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#a5b4fc;animation:erp-tp-dot-pulse 1.2s infinite .4s;"></span>' +
          '</div>' +
          '<span id="erp-spinner-text" style="font-size:12px;color:#64748b;font-weight:500;">AI 正在分析调拨数据…</span>' +
        '</div>' +
        '<style>@keyframes erp-tp-dot-pulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1.2)}}</style>';

      const abortCtrl = new AbortController();
      let fullText = '';
      let firstChunk = true;

      try {
        addLog('llm_start', '正在调用 ' + llmProvider + '/' + (llmModel || 'default') + ' 分析调拨数据…');

        for await (const chunk of streamChat(
          prompts, llmProvider as 'deepseek', apiKey, abortCtrl.signal, llmModel,
          thinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
          (reasoningEffort as 'low' | 'high' | 'max') || 'high',
        )) {
          if (chunk.type === 'reasoning') {
            const spinnerText = output.querySelector('#erp-spinner-text');
            if (spinnerText) spinnerText.textContent = 'AI 正在思考中…';
            continue;
          }
          fullText += chunk.text;
          if (firstChunk) {
            firstChunk = false;
            addLog('llm_first_byte', 'AI 首字节响应 (' + (Date.now() - startTs) + 'ms)');
          }
          output.innerHTML =
            (srcBox ? '<div style="margin-bottom:8px;">' + srcBox + '</div>' : '') +
            '<div style="font-size:12px;color:#334155;line-height:1.6;white-space:pre-wrap;">' +
              escape(fullText) +
            '</div>';
        }

        addLog('llm_parse', 'AI 响应接收完成，正在解析…');
        const suggestions = parseLlmResponse(fullText);
        addLog('llm_parsed', '解析完成，获得 ' + suggestions.length + ' 条建议');

        const elapsed = Date.now() - startTs;
        if (isAppend) {
          for (const s of suggestions) {
            const idx = allSuggestions.findIndex(function (existing) { return existing.sku === s.sku; });
            if (idx >= 0) allSuggestions[idx] = s;
            else allSuggestions.push(s);
          }
        } else {
          allSuggestions.length = 0;
          allSuggestions.push(...suggestions);
        }

        const skuBoxQty = new Map<string, number>();
        for (const s of summaries) skuBoxQty.set(s.sku, s.singleQuantity || 1);

        // Frontend override: qty + riskLevel + restockDate from actual data.
        // 调拨量走确定性公式（与采购侧同构，2026-08-13 附录 A）——LLM 只给预测日均。
        // Transfer has no productionDays — only shippingDays matters.
        for (const s of allSuggestions) {
          const sum = summaries.find(v => v.sku === s.sku);
          if (!sum) continue;
          let daily = s.predictedDailySales;
          if ((!daily || daily <= 0) && sum.avgDaily7d > 0) daily = sum.avgDaily7d;
          if (!daily || daily <= 0) continue;

          const sellUntil = sum.sellUntilDate ? new Date(sum.sellUntilDate) : null;
          const coverageDays = sellUntil && !isNaN(sellUntil.getTime())
            ? (sellUntil.getTime() - Date.now()) / 86400000 + (sum.bufferDays ?? 15)
            : 0;
          const qty = computeTransferQty(
            daily, sum.fbaAvailable, sum.fbaInTransit,
            sum.shippingDays ?? 25, coverageDays, sum.singleQuantity || 1,
          );
          s.suggestedQty = qty;
          // 风险等级先算：green（不紧急）时数量行叫"远期缺口"而非"建议调拨量"——
          // 卖到日期设得远时绿卡几乎必然带缺口（公式覆盖到卖到+冗余），两种口径并存
          // 会被读成"无需调拨却又建议调拨"的自相矛盾
          const remainingDays0 = (sum.fbaAvailable + sum.fbaInTransit) / daily;
          if (qty <= 0) {
            s.riskLevel = 'green';
          } else {
            // 与采购侧同口径（08-07 设计）：red = 剩余 ≤ 头程（下单死线已到），
            // yellow = ≤ 头程 + 冗余。旧实现 red≤30/yellow≤头程 的排序使 yellow 永不可达。
            s.riskLevel = riskLevelFromRemainingDays(
              remainingDays0, sum.shippingDays ?? 25, sum.bufferDays ?? 15,
            );
          }
          s.suggestion += '\n' + (s.riskLevel === 'green' ? '远期缺口(至卖到日): ' : '建议调拨量: ') + qty + '件';
          // 2026-09-08 管线口径（结论二）：FBA在途 = max(货件在途,已发货+待入库)+待出运+本仓待出库
          s.suggestion += '\n库存依据: FBA可用 ' + sum.fbaAvailable + ' + FBA在途(含已发货/待入库/待出运/待出库) ' + sum.fbaInTransit;
          const pipe = sum.fbaPipeline;
          if (pipe) {
            s.suggestion += '\nFBA管线: 已发货 ' + pipe.shipped + ' / 待入库 ' + pipe.receiving
              + ' / 待出库 ' + pipe.working + '(已计入) / 待出运 ' + (sum.transferWaitShippedTotal || 0) + '(全仓参考)';
          }
          // 来源可行性（2026-09-08 借用排除）：国内可动用 = 可用 − 预占 − 不可借
          const srcWarn = transferSourceWarning(
            qty, sum.domesticAvailable, sum.domesticReserved,
            domesticNonLendable(sum.domesticWarehouses, nonLendableSelected),
          );
          if (srcWarn) s.suggestion += '\n' + srcWarn;

          // 确定性结论句（评审 #2）：缺货+需调拨时前端补充，AI 不写结论行（提示词已禁）
          const shortLine = shortageConclusionLine(
            sourceWhLabel, sum.domesticWarehouses, nonLendableSelected, qty,
          );
          if (shortLine) s.suggestion += '\n' + shortLine;

          const remainingDays = remainingDays0;
          const orderDayOffset = Math.round(remainingDays - (sum.bufferDays ?? 15) - (sum.shippingDays ?? 25));
          const orderDate = new Date(Date.now() + orderDayOffset * 86400000);
          const dateStr = orderDayOffset > 0
            ? orderDate.getFullYear() + '-' + String(orderDate.getMonth() + 1).padStart(2, '0') + '-' + String(orderDate.getDate()).padStart(2, '0')
            : '';
          s.restockDate = dateStr;
          if (dateStr) {
            s.suggestion += '\n预计调拨日期: ' + dateStr;
          }
        }

        renderResultCards(output, allSuggestions, skuBoxQty, srcStatusMap);
        resetButtons();
        addLog('done', '分析完成 — ' + (isAppend ? '新增' : '') + suggestions.length + ' 条建议, 总计 ' + allSuggestions.length + ' 条, 总耗时 ' + elapsed + 'ms');
      } catch (e: any) {
        if (e.name === 'AbortError') {
          output.innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">请求超时或已取消</div>' +
            '</div>';
          addLog('error', '请求超时或已取消');
        } else if (e.message === 'AUTH_ERROR') {
          output.innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">鉴权失败，请检查 API Key</div>' +
            '</div>';
          addLog('error', '鉴权失败');
        } else {
          output.innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">' + escape(e.message || '') + '</div>' +
            '</div>';
          addLog('error', e.message || '');
        }
        resetButtons();
      }
    }

    function resetButtons(): void {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '刷新分析';
      analyzeBtn.style.opacity = '1';
      appendBtn.style.display = analyzedAsins.size > 0 ? '' : 'none';
      appendBtn.disabled = false;
      appendBtn.textContent = '追加分析';
      appendBtn.style.opacity = '1';
      fillBtn.style.display = allSuggestions.length > 0 ? '' : 'none';
    }

    function showLoading(): void {
      analyzeBtn.disabled = true;
      analyzeBtn.style.opacity = '0.7';
      appendBtn.disabled = true;
      appendBtn.style.opacity = '0.7';
      output.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px;">' +
          '<div style="display:flex;gap:7px;">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#6366f1;animation:erp-tp-dot-pulse 1.2s infinite;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;animation:erp-tp-dot-pulse 1.2s infinite .2s;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#a5b4fc;animation:erp-tp-dot-pulse 1.2s infinite .4s;"></span>' +
          '</div>' +
          '<span style="font-size:12px;color:#64748b;font-weight:500;">AI 正在分析调拨数据…</span>' +
        '</div>' +
        '<style>@keyframes erp-tp-dot-pulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1.2)}}</style>';
    }

    // --- 开始分析 ---
    analyzeBtn?.addEventListener('click', async function () {
      expandIfCollapsed();
      const { asins, skus } = await sweepCollectAsins();
      if (asins.length === 0) {
        output.innerHTML =
          '<div style="text-align:center;padding:20px 0;color:#94a3b8;">' +
            '<div style="font-size:28px;margin-bottom:6px;">📭</div>' +
            '<div style="font-size:12px;">未检测到 ASIN 数据，请先添加产品</div>' +
          '</div>';
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = '重新检测';
        analyzeBtn.style.opacity = '1';
        addLog('error', '未检测到 ASIN');
        return;
      }
      analyzedAsins.clear();
      showLoading();
      await runAnalysis(asins, skus, false);
    });

    // --- 追加分析 ---
    appendBtn?.addEventListener('click', async function () {
      expandIfCollapsed();
      const { asins, skus } = await sweepCollectAsins();
      const newAsins = asins.filter(function (a) { return !analyzedAsins.has(a); });

      if (newAsins.length === 0) {
        output.innerHTML =
          '<div style="text-align:center;padding:20px 0;color:#94a3b8;">' +
            '<div style="font-size:28px;margin-bottom:6px;">✅</div>' +
            '<div style="font-size:12px;">所有 ASIN 均已分析，无需追加</div>' +
          '</div>';
        return;
      }

      showLoading();
      appendBtn.textContent = '分析中…';
      await runAnalysis(newAsins, skus, true);
    });

    // --- 填入备注 ---
    fillBtn?.addEventListener('click', function () {
      fillRemarks();
    });
  }
  setTimeout(tryInject, 2000);
}

/** Extract suggested qty from suggestion text (fallback when JSON field is 0) */
function extractSuggestedQty(text: string): number | null {
  const m = text.match(/建议调拨量\s*[:：]\s*([\d,]+)/);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return n > 0 ? n : null;
  }
  return null;
}

/** Bold+colored highlight key numbers in suggestion text */
function highlightSuggestion(text: string): string {
  return text
    .replace(
      /建议调拨量\s*[:：]\s*([\d,]+件?)/g,
      '<b style="color:#dc2626;">建议调拨量: $1</b>'
    )
    .replace(
      /远期缺口\([^)]*\)\s*[:：]\s*([\d,]+件?)/g,
      '<b style="color:#f59e0b;">远期缺口: $1</b>'
    )
    .replace(
      /预测日均\s*[:：]\s*([\d.]+)/g,
      '<b style="color:#6366f1;">预测日均: $1</b>'
    );
}

function renderResultCards(out: HTMLElement, suggestions: LlmSuggestion[], skuBoxQty: Map<string, number>, srcStatusMap?: Map<string, string | null>): void {
  if (!suggestions || suggestions.length === 0) {
    out.innerHTML =
      '<div style="text-align:center;padding:16px 0;color:#94a3b8;font-size:12px;">AI 未返回有效建议</div>';
    return;
  }

  let html =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="font-size:11px;color:#64748b;">共 <b style="color:#1e293b;">' + suggestions.length + '</b> 条调拨建议</span>' +
    '</div>';

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const riskColor = RISK_COLORS[s.riskLevel] || '#94a3b8';
    const riskLabel = RISK_LABELS[s.riskLevel] || '';

    const rawQty = (s.suggestedQty != null && s.suggestedQty > 0)
      ? s.suggestedQty
      : extractSuggestedQty(s.suggestion || '');
    // 调出仓前端状态行（数据层结果，不依赖 AI 措辞）
    const srcBadge = srcStatusMap && s ? sourceWarehouseBadgeHtml(srcStatusMap.get(s.sku) || null) : '';
    // Round up to box quantity
    const boxQty = skuBoxQty.get(s.sku) || 1;
    const displayQty = rawQty ? Math.ceil(rawQty / boxQty) * boxQty : 0;

    html +=
      '<div style="display:flex;margin-bottom:4px;' +
      'background:#fff;border:1px solid #e2e8f0;border-radius:5px;overflow:hidden;">' +
        '<div style="width:3px;flex-shrink:0;background:' + riskColor + ';"></div>' +
        '<div style="flex:1;padding:6px 10px;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;">' +
            '<code style="font-size:10px;font-family:monospace;' +
            'background:#f1f5f9;color:#334155;padding:1px 6px;border-radius:3px;font-weight:600;">' +
              escape(s.sku) +
            '</code>' +
            (riskLabel
              ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:' +
                riskColor + ';font-weight:600;">' +
                  '<span style="width:5px;height:5px;border-radius:50%;background:' + riskColor + ';"></span>' +
                  riskLabel +
                '</span>'
              : '') +
            (displayQty && s.riskLevel !== 'green'
              ? '<span style="font-size:14px;font-weight:800;color:#dc2626;margin-left:auto;">建议调拨 ' + displayQty + '</span>'
              : (displayQty
                ? '<span style="font-size:12px;font-weight:700;color:#64748b;margin-left:auto;">远期缺口 ' + displayQty + '</span>'
                : (s.restockDate
                  ? '<span style="font-size:10px;color:#f59e0b;margin-left:auto;">预计调拨日 ' + escape(s.restockDate) + '</span>'
                  : ''))) +
          '</div>' +
          srcBadge +
          '<div style="font-size:11px;color:#334155;line-height:1.45;white-space:pre-wrap;">' +
            highlightSuggestion(escape(s.suggestion)) +
          '</div>' +
        '</div>' +
      '</div>';
  }

  out.innerHTML = html;
}

function escape(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, function(c) { return map[c] ?? c; });
}
