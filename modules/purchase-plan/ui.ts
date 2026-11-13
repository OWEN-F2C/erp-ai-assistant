// modules/purchase-plan/ui.ts
import type { LlmSuggestion, MarketGroup } from '../types';
import { getSettings } from '../../shared/settings';
import { ErpApiError, erpErrorNoticeHtml } from '../../shared/erp-errors';
import { addLog } from '../../shared/analysis-log';
import { fetchAndSummarize, buildAiPrompt, type SkuSummary } from '../../shared/jijia-data';
import { streamChat } from '../../shared/llm-client';
import { parseLlmResponse } from '../../shared/llm-parser';
import { normalizeUiScale } from '../../shared/ui-scale';
import { PANEL_BUILD } from '../../shared/panel-dedup';
import { createScanRegistry, findTableScroller, sweepTableScroller } from '../../shared/scan-registry';
import { buildPurchaseConclusion } from '../../shared/purchase-conclusion';
import {
  domesticNonLendable, nonLendableChipsHtml, readNonLendableGroups, type DomesticSiteGroup,
} from '../../shared/domestic-pool';
import { versionBadgeHtml } from '../../shared/panel-version';
import {
  isExtensionContextValid, isExtensionContextInvalidatedError, extensionInvalidatedNoticeHtml,
} from '../../shared/extension-context';

const RISK_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#10b981',
};
const RISK_LABELS: Record<string, string> = {
  red: '缺货风险',
  yellow: '注意补货',
  green: '库存充足',
};

// 面板默认收起（方案A，2026-08-28 用户确认，与调拨面板同款）：不挤占原生表格。
// 状态存模块级——SPA 切页重注入保持，整页刷新回默认收起
let purchasePanelCollapsed = true;

// 国内不可借站点组（2026-09-08 借用排除）：不持久化，SPA 重注入保持、整页刷新回默认
let nonLendableSelected = new Set<DomesticSiteGroup>();

export function render(_container: HTMLElement, ctx: unknown, doc?: Document): void {
  const root = doc || document;
  if (root.querySelector('.erp-ai-panel')) return;

  let tries = 0;
  function tryInject(): void {
    // Abort if document is no longer active (iframe navigated away)
    if (!root.body?.isConnected) return;
    // Check DOM again — another tryInject may have injected between retries
    if (root.querySelector('.erp-ai-panel')) return;
    tries++;
    const form = root.querySelector('.srm-pe-body-table') || root.querySelector('.arco-form');
    if (!form && tries < 30) { setTimeout(tryInject, 2000); return; }
    if (!form) return;

    // Hidden marker to prevent duplicate injection
    const marker = root.createElement('span');
    marker.className = 'erp-ai-panel';
    marker.hidden = true;
    root.body?.appendChild(marker);

    // --- Build panel ---
    const panel = root.createElement('div');
    panel.className = 'erp-ai-panel';
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
            '<path d="M12 2a4 4 0 0 1 4 4v2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z"/>' +
            '<circle cx="12" cy="13" r="2"/>' +
            '</svg>' +
          '</span>' +
          '<div>' +
            '<span style="font-weight:700;font-size:14px;color:#1e293b;">AI 采购建议</span>' +
            '<span style="display:inline-block;margin-left:6px;padding:1px 8px;' +
            'background:#e0e7ff;color:#6366f1;border-radius:10px;font-size:10px;font-weight:600;">BETA</span>' +
            versionBadgeHtml() +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          '<button id="erp-ai-btn" style="padding:7px 14px;background:#6366f1;color:#fff;' +
          'border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;">' +
            '开始分析' +
          '</button>' +
          '<button id="erp-ai-append" style="padding:7px 14px;background:#fff;color:#6366f1;' +
          'border:1px solid #c7d2fe;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;display:none;">' +
            '追加分析' +
          '</button>' +
          '<button id="erp-ai-fill" style="padding:7px 14px;background:#10b981;color:#fff;' +
          'border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
          'transition:all .15s;display:none;">' +
            '填入备注' +
          '</button>' +
          '<button id="erp-ai-collapse" title="折叠/展开" style="padding:7px 10px;background:#fff;' +
          'color:#64748b;border:1px solid #e2e8f0;border-radius:7px;cursor:pointer;font-size:12px;' +
          'font-weight:700;line-height:1;">' +
            '+' +
          '</button>' +
        '</div>' +
      '</div>' +
      // 内容区整体限高内滚（output 不再单独 420px 限高，避免双层滚动条）
      '<div id="erp-ai-body" style="max-height:30vh;overflow-y:auto;">' +
      '<div id="erp-ai-inputs" style="padding:10px 18px;border-bottom:1px solid #f1f5f9;display:none;"></div>' +
      '<div id="erp-ai-out" style="padding:12px 18px;"></div>' +
      '</div>';

    const target = root.querySelector('.srm-pe-body-table__content') || form;
    target.parentElement?.insertBefore(panel, target);

    // --- State ---
    const analyzedSkus = new Set<string>();
    const allSuggestions: LlmSuggestion[] = [];
    // 确定性结论块（runAnalysis 填充；填入备注也从这里取数，不再依赖 LLM 散文）
    const conclusionMap = new Map<string, ReturnType<typeof buildPurchaseConclusion>>();

    // --- One-click fill remarks ---
    function fillRemarks(): void {
      if (allSuggestions.length === 0) return;

      const remarkText = allSuggestions
        .map(function(s) {
          const riskLabel = RISK_LABELS[s.riskLevel] || '';
          // 结论数字取确定性结论块（不依赖 LLM 散文里写没写）
          const concl = conclusionMap.get(s.sku);
          const conclSuffix = concl
            ? '（建议采购 ' + concl.qty + ' 件，采购日期 ' + (concl.lines[6]!.value) + '）'
            : '';
          return '【' + s.sku + '】' + (riskLabel ? '[' + riskLabel + '] ' : '') + s.suggestion + conclSuffix;
        })
        .join('\n');

      // Try to find textarea in the page (form-level or table-level)
      const textareas = root.querySelectorAll('textarea');
      if (textareas.length > 0) {
        const ta = textareas[0] as HTMLTextAreaElement;
        ta.value = remarkText;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        addLog('done', '已填入 ' + allSuggestions.length + ' 条建议到备注');
      } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(remarkText).then(function() {
          addLog('done', '备注已复制到剪贴板（' + allSuggestions.length + ' 条）');
        }).catch(function() {
          addLog('error', '复制失败，请手动复制');
        });
      }
    }

    // --- Button refs ---
    const btn = root.querySelector('#erp-ai-btn') as HTMLButtonElement;
    const appendBtn = root.querySelector('#erp-ai-append') as HTMLButtonElement;
    const fillBtn = root.querySelector('#erp-ai-fill') as HTMLButtonElement;
    const out = root.querySelector('#erp-ai-out') as HTMLElement;

    // 国内不可借 chips：委托监听挂 inputs 容器（参数行 innerHTML 重建不重复绑），
    // 勾选写回模块级 Set——参数区重渲染时从 Set 恢复勾选态
    const nlInputsDiv = root.querySelector('#erp-ai-inputs') as HTMLElement;
    nlInputsDiv.addEventListener('change', function (e: Event) {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('erp-nl-chip')) {
        nonLendableSelected = readNonLendableGroups(nlInputsDiv);
      }
    });

    // --- 折叠（模块级状态，SPA 重注入保持）---
    const bodyDiv = root.querySelector('#erp-ai-body') as HTMLElement;
    const collapseBtn = root.querySelector('#erp-ai-collapse') as HTMLButtonElement;
    function applyCollapsed(): void {
      bodyDiv.style.display = purchasePanelCollapsed ? 'none' : '';
      collapseBtn.textContent = purchasePanelCollapsed ? '+' : '−';
    }
    collapseBtn.addEventListener('click', function () {
      purchasePanelCollapsed = !purchasePanelCollapsed;
      applyCollapsed();
    });
    // 分析/追加前自动展开（收起时点分析不需要先手动展开）
    function expandIfCollapsed(): void {
      if (purchasePanelCollapsed) {
        purchasePanelCollapsed = false;
        applyCollapsed();
      }
    }
    applyCollapsed();

    // --- Collect SKUs and site info from the page ---
    function collectSkus(): string[] {
      const skus: string[] = [];
      const seen: Record<string, boolean> = {};
      const cells = root.querySelectorAll('.surely-table-cell-content');

      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];

        // Skip cells inside modals/drawers/popups (search dialogs, etc.)
        let parent: Element | null = cell;
        let skip = false;
        while (parent) {
          const tag = parent.tagName;
          const cls = parent.className || '';
          if (
            tag === 'ARCO-MODAL' || tag === 'ARCO-DRAWER' ||
            tag === 'ARCO-TRIGGER' || tag === 'ARCO-TRIGGER-POPUP' ||
            cls.includes('arco-modal') || cls.includes('arco-drawer') ||
            cls.includes('arco-trigger') ||
            cls.includes('arco-select-dropdown') || cls.includes('arco-dropdown') ||
            cls.includes('arco-picker-panel')
          ) {
            skip = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (skip) continue;

        const walker = root.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          const text = (node.textContent || '').trim();
          if (!text) continue;
          const matches = text.match(/[A-Z0-9]{6,20}/g);
          if (matches) {
            matches.forEach(function(m) {
              if (m.indexOf('-') >= 0 || /^B0/.test(m) || /^X00/.test(m)) return;
              const letterCount = (m.match(/[A-Z]/g) || []).length;
              const digitCount = (m.match(/[0-9]/g) || []).length;
              if (letterCount < 2 || digitCount < 2) return;
              if (digitCount > letterCount * 3) return;
              if (!seen[m]) { seen[m] = true; skus.push(m); }
            });
          }
        }
      }
      return skus;
    }

    /** For each SKU found by collectSkus, find its target site from the table row */
    function collectSiteMap(skus: string[]): Map<string, string> {
      const siteMap = new Map<string, string>();
      if (skus.length === 0) return siteMap;

      // Fallback: form-level 目的仓
      let defaultSite = '';
      const allInputs = root.querySelectorAll('input');
      for (let i = 0; i < allInputs.length; i++) {
        const inp = allInputs[i] as HTMLInputElement;
        // Arco select stores value in placeholder, not .value
        const val = (inp.value || inp.placeholder || '').trim();
        if (!val) continue;
        const m = val.match(/^CN_[A-Za-z0-9]+_([A-Z]{2})$/);
        if (m) { defaultSite = m[1]; break; }
      }

      const rows = root.querySelectorAll('.surely-table-row');
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const rowText = (row.textContent || '').trim();
        if (!rowText) continue;

        // Find which SKU is in this row
        let matchedSku = '';
        for (const sku of skus) {
          if (rowText.includes(sku)) { matchedSku = sku; break; }
        }
        if (!matchedSku) continue;

        // Extract site from platform site cell (text content or arco-select placeholder)
        let site = '';
        const cells = row.querySelectorAll('.surely-table-cell-content');
        for (let c = 0; c < cells.length; c++) {
          const cellText = (cells[c].textContent || '').trim();
          // Check cell text for "PLATFORM:STORE:XX" format
          const siteMatch = cellText.match(/[A-Z]+:[A-Z0-9_-]+:([A-Z]{2})/);
          if (siteMatch) { site = siteMatch[1]; break; }
          // Also check arco-select inputs inside the cell
          const cellInputs = cells[c].querySelectorAll('input');
          for (let ci = 0; ci < cellInputs.length; ci++) {
            const civ = ((cellInputs[ci] as HTMLInputElement).value || (cellInputs[ci] as HTMLInputElement).placeholder || '').trim();
            const ciMatch = civ.match(/[A-Z]+:[A-Z0-9_-]+:([A-Z]{2})/);
            if (ciMatch) { site = ciMatch[1]; break; }
          }
          if (site) break;
        }

        siteMap.set(matchedSku, site || defaultSite);
      }

      return siteMap;
    }

    const inputsDiv = root.querySelector('#erp-ai-inputs') as HTMLElement;

    // --- Per-SKU input row builder (preserves user-entered values on rebuild) ---
    function buildSkuInputs(skus: string[]): void {
      // Snapshot existing values before rebuilding
      const saved: Record<string, { production: string; shipping: string; sellUntil: string; buffer: string; qty: string; note: string }> = {};
      const oldProduction = inputsDiv.querySelectorAll('.erp-sku-production');
      const oldShipping = inputsDiv.querySelectorAll('.erp-sku-shipping');
      const oldSellUntil = inputsDiv.querySelectorAll('.erp-sku-sell-until');
      const oldBuffer = inputsDiv.querySelectorAll('.erp-sku-buffer');
      const oldQty = inputsDiv.querySelectorAll('.erp-sku-qty');
      const oldNote = inputsDiv.querySelectorAll('.erp-sku-note');
      for (let i = 0; i < oldProduction.length; i++) {
        const sku = (oldProduction[i] as HTMLElement).dataset.sku || '';
        saved[sku] = {
          production: (oldProduction[i] as HTMLInputElement).value,
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
          '<span style="font-size:10px;color:#94a3b8;">每SKU独立设置</span>' +
        '</div>' +
        nonLendableChipsHtml(nonLendableSelected);

      for (const sku of skus) {
        const prev = saved[sku] || { production: '30', shipping: '25', sellUntil: defaultSellUntil, buffer: '15', qty: '', note: '' };
        html +=
          '<div style="display:flex;align-items:center;gap:0;margin-bottom:3px;' +
          'background:#f8fafc;border:1px solid #f1f5f9;border-radius:6px;overflow:hidden;' +
          'transition:border-color .15s;">' +
            '<code style="font-size:11px;font-weight:600;color:#4f46e5;background:#eef2ff;' +
            'padding:6px 10px;min-width:82px;text-align:center;flex-shrink:0;">' + escape(sku) + '</code>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">生产</span>' +
            '<input class="erp-sku-production" data-sku="' + escape(sku) + '" type="number" value="' + prev.production + '" min="0" max="365" ' +
            'style="width:36px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;font-weight:500;">' +
            '<span style="font-size:10px;color:#94a3b8;padding-right:4px;">天</span>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">头程</span>' +
            '<input class="erp-sku-shipping" data-sku="' + escape(sku) + '" type="number" value="' + prev.shipping + '" min="0" max="365" ' +
            'style="width:36px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;font-weight:500;">' +
            '<span style="font-size:10px;color:#94a3b8;padding-right:4px;">天</span>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">卖到</span>' +
            '<input class="erp-sku-sell-until" data-sku="' + escape(sku) + '" type="date" value="' + prev.sellUntil + '" min="' + todayStr + '" ' +
            'style="width:108px;padding:3px 4px;border:none;background:transparent;font-size:11px;' +
            'color:#1e293b;outline:none;">' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 4px 0 6px;flex-shrink:0;">冗余</span>' +
            '<input class="erp-sku-buffer" data-sku="' + escape(sku) + '" type="number" value="' + prev.buffer + '" min="0" max="365" ' +
            'style="width:36px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;font-weight:500;">' +
            '<span style="font-size:10px;color:#94a3b8;padding-right:6px;">天</span>' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 5px 0 6px;flex-shrink:0;">预测采购量</span>' +
            '<input class="erp-sku-qty" data-sku="' + escape(sku) + '" type="number" value="' + prev.qty + '" min="0" placeholder="—" ' +
            'style="width:52px;padding:3px 2px;border:none;background:transparent;font-size:11px;' +
            'text-align:center;color:#1e293b;outline:none;">' +
            '<div style="width:1px;height:22px;background:#e2e8f0;flex-shrink:0;"></div>' +
            '<span style="font-size:10px;color:#64748b;padding:0 5px 0 6px;flex-shrink:0;">备注</span>' +
            '<input class="erp-sku-note" data-sku="' + escape(sku) + '" type="text" value="' + escape(prev.note) + '" placeholder="—" ' +
            'style="flex:1;min-width:0;padding:3px 6px;border:none;background:transparent;font-size:11px;' +
            'color:#1e293b;outline:none;">' +
          '</div>';
      }
      inputsDiv.innerHTML = html;
      if (skus.length > 0) inputsDiv.style.display = 'block';
    }

    // 累计登记：产品明细表是窗口化长列表（滚动时 DOM 可见行集变化，2026-09-02
    // 用户报参数配置 SKU 数量随滚动条跳变），扫描取并集保证列表稳定；
    // 分析前 sweepCollectSkus 滚表全量对账（剔除已删行、补全离屏行）
    const skuRegistry = createScanRegistry<string>();
    function mergeScan(): string[] {
      return skuRegistry.merge(collectSkus());
    }

    /** 分析前滚表对账：程序化把产品表滚一遍，让每行进过 DOM——全量扫描结果
     *  即表格真实内容；站点映射随步收集（滚完后离屏行已不在 DOM，事后扫不到） */
    async function sweepCollectSkus(): Promise<{ skus: string[]; siteMap: Map<string, string> }> {
      const siteAcc = new Map<string, string>();
      const stepScan = function (): void {
        const scanned = skuRegistry.merge(collectSkus());
        const sm = collectSiteMap(scanned);
        for (const entry of sm) if (!siteAcc.has(entry[0])) siteAcc.set(entry[0], entry[1]);
      };
      skuRegistry.beginSweep();
      const scroller = findTableScroller(root);
      if (scroller) {
        await sweepTableScroller(scroller, stepScan);
      } else {
        stepScan();
      }
      const finalSkus = skuRegistry.endSweep();
      addLog('sku_detect', '滚动扫描完成：表格共 ' + finalSkus.length + ' 个SKU');
      const key = finalSkus.join(',');
      if (key !== lastSkuList) {
        lastSkuList = key;
        buildSkuInputs(finalSkus);
      }
      return { skus: finalSkus, siteMap: siteAcc };
    }

    // Auto-scan for SKUs: show input rows as soon as products are added to the table
    let lastSkuList = '';
    // 扩展重载/更新自检：注入时有效→之后失效（chrome.runtime.id 消失）即整个
    // 面板替换为刷新指引并停轮询；注入时本就无效（测试环境）不触发
    const hadExtensionContext = isExtensionContextValid();
    function scanSkuInputs(): void {
      if (hadExtensionContext && !isExtensionContextValid()) {
        bodyDiv.innerHTML = extensionInvalidatedNoticeHtml();
        addLog('error', '扩展已更新或重新加载，请刷新页面');
        clearInterval(scanTimer);
        return;
      }
      const skus = mergeScan();
      const key = skus.join(',');
      if (key !== lastSkuList) {
        lastSkuList = key;
        buildSkuInputs(skus);
      }
    }
    const scanTimer = setInterval(scanSkuInputs, 2000);
    scanSkuInputs();

    /** Read per-SKU values back and apply to summaries */
    function applySkuInputs(summaries: SkuSummary[]): void {
      const productionInputs = inputsDiv.querySelectorAll('.erp-sku-production');
      const shippingInputs = inputsDiv.querySelectorAll('.erp-sku-shipping');
      const sellUntilInputs = inputsDiv.querySelectorAll('.erp-sku-sell-until');
      const bufferInputs = inputsDiv.querySelectorAll('.erp-sku-buffer');
      const qtyInputs = inputsDiv.querySelectorAll('.erp-sku-qty');
      const noteInputs = inputsDiv.querySelectorAll('.erp-sku-note');

      for (let i = 0; i < productionInputs.length; i++) {
        const sku = (productionInputs[i] as HTMLElement).dataset.sku;
        const pv = parseInt((productionInputs[i] as HTMLInputElement).value, 10);
        const sv = parseInt((shippingInputs[i] as HTMLInputElement).value, 10);
        const bv = parseInt((bufferInputs[i] as HTMLInputElement).value, 10);
        const production = Number.isNaN(pv) ? 30 : pv;
        const shipping = Number.isNaN(sv) ? 25 : sv;
        const sellUntil = (sellUntilInputs[i] as HTMLInputElement).value;
        const buffer = Number.isNaN(bv) ? 15 : bv;
        const qty = parseInt((qtyInputs[i] as HTMLInputElement).value, 10);
        const note = (noteInputs[i] as HTMLInputElement).value.trim();
        const s = summaries.find(function(x) { return x.sku === sku; });
        if (s) {
          s.productionDays = Math.max(0, Math.min(365, production));
          s.shippingDays = Math.max(0, Math.min(365, shipping));
          s.sellUntilDate = sellUntil;
          s.bufferDays = Math.max(0, Math.min(365, buffer));
          if (qty > 0) s.operatorQty = qty;
          if (note) s.operatorNote = note;
        }
      }
    }

    // --- Shared analysis function ---
    async function runAnalysis(targetSkus: string[], isAppend: boolean, siteMapAcc?: Map<string, string>): Promise<void> {
      const startTs = Date.now();
      const isRefresh = !isAppend && analyzedSkus.size > 0;
      addLog('sku_detect', '检测到 ' + targetSkus.length + ' 个SKU' + (isAppend ? '（追加）' : '') + (isRefresh ? '（刷新）' : '') + ': ' + targetSkus.join(', '));

      // Fetch data (new fields use defaults, will be overridden per-SKU below)
      let summaries: SkuSummary[] = [];
      try {
        addLog('sales_fetch', '正在从积加获取库存和销售数据…');
        // 站点映射：滚表期间随步收集的优先（离屏行滚完就不在 DOM 里了）
        const siteMap = siteMapAcc || collectSiteMap(targetSkus);
        const marketGroups = (await getSettings()).marketGroups;
        summaries = await fetchAndSummarize(targetSkus, root, siteMap, marketGroups);
        // Apply per-SKU operator inputs
        applySkuInputs(summaries);
        // Warn about missing group markets
        for (const s of summaries) {
          if (s.missingGroupMarkets && s.missingGroupMarkets.length > 0) {
            addLog('warn', s.sku + ': 汇总组中以下站点无数据，请检查站点代码是否正确: ' + s.missingGroupMarkets.join(', '));
          }
        }
        addLog('sales_done', '数据获取完成 (匹配 ' + summaries.length + '/' + targetSkus.length + ' 个SKU' + (siteMap.size > 0 ? ', ' + siteMap.size + ' 个站点' : '') + ')');
      } catch (e: any) {
        out.innerHTML = e instanceof ErpApiError
          ? erpErrorNoticeHtml(e)
          : '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">获取数据失败: ' + escape(e.message || '') + '</div>' +
            '</div>';
        addLog('error', '获取数据失败: ' + (e.message || ''));
        resetButtons();
        return;
      }

      if (summaries.length === 0) {
        out.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
          'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
            '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
            '<div style="font-size:12px;color:#991b1b;line-height:1.5;">该SKU在积加系统中无库存或销售数据</div>' +
          '</div>';
        addLog('error', '该SKU无库存或销售数据');
        resetButtons();
        return;
      }

      // Build prompt — skip SKUs with no sales data
      const validSummaries: SkuSummary[] = [];
      for (const s of summaries) {
        if (s.avgDaily30d === 0 && s.avgDaily7d === 0 && s.avgDaily90d === 0) {
          addLog('sales_skip', s.sku + ' 无销售数据，跳过分析');
        } else {
          if (!s.siteDatas || s.siteDatas.length === 0) addLog('sales_done', s.sku + ' 未匹配到站点数据');
          validSummaries.push(s);
        }
      }
      if (validSummaries.length === 0) {
        addLog('error', '所有SKU均无销售数据');
        resetButtons();
        return;
      }

      let prompts: string;
      try {
        prompts = validSummaries.map(function(s) { return buildAiPrompt(s, undefined, nonLendableSelected); }).join('\n---\n');
      } catch (e: any) {
        addLog('error', '构建提示词失败: ' + (e.message || ''));
        resetButtons();
        return;
      }
      addLog('prompt', prompts);

      // Read settings directly in content script (bypass SW)
      const { llmProvider, llmModel, apiKey, thinkingEnabled, reasoningEffort } = await getSettings();
      if (!llmProvider || !apiKey) {
        out.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
          'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
            '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
            '<div style="font-size:12px;color:#991b1b;line-height:1.5;">API Key 未配置</div>' +
          '</div>';
        resetButtons();
        return;
      }

      out.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px;">' +
          '<div style="display:flex;gap:7px;">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#6366f1;animation:erp-dot-pulse 1.2s infinite;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;animation:erp-dot-pulse 1.2s infinite .2s;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#a5b4fc;animation:erp-dot-pulse 1.2s infinite .4s;"></span>' +
          '</div>' +
          '<span id="erp-spinner-text" style="font-size:12px;color:#64748b;font-weight:500;">AI 正在分析采购数据…</span>' +
        '</div>' +
        '<style>@keyframes erp-dot-pulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1.2)}}</style>';

      const abortCtrl = new AbortController();
      let fullText = '';
      let firstChunk = true;

      try {
        addLog('llm_start', '正在调用 ' + llmProvider + '/' + (llmModel || 'default') + ' 分析采购数据…');

        for await (const chunk of streamChat(
          prompts, llmProvider as 'deepseek', apiKey, abortCtrl.signal, llmModel,
          thinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
          (reasoningEffort as 'low' | 'high' | 'max') || 'high',
        )) {
          if (chunk.type === 'reasoning') {
            const spinnerText = out.querySelector('#erp-spinner-text');
            if (spinnerText) spinnerText.textContent = 'AI 正在思考中…';
            continue;
          }
          fullText += chunk.text;
          if (firstChunk) {
            firstChunk = false;
            addLog('llm_first_byte', 'AI 首字节响应 (' + (Date.now() - startTs) + 'ms)');
          }
          out.innerHTML =
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
            const idx = allSuggestions.findIndex(function(existing) { return existing.sku === s.sku; });
            if (idx >= 0) allSuggestions[idx] = s;
            else allSuggestions.push(s);
          }
        } else {
          allSuggestions.length = 0;
          allSuggestions.push(...suggestions);
        }
        for (const s of validSummaries) { analyzedSkus.add(s.sku); }

        const skuBoxQty = new Map<string, number>();
        for (const s of validSummaries) skuBoxQty.set(s.sku, s.singleQuantity || 1);

        // Frontend override: 结论块统一产出 灯/日期/数量（同基数同口径——旧实现
        // 灯用 FBA 基数+suggestedQty≤0 强制 green、日期用 FBA 基数，与总可用基数
        // 的结论块互相矛盾，2026-09-03 用户报"库存充足"与"尽快"同卡出现）
        for (const s of allSuggestions) {
          const sum = validSummaries.find(v => v.sku === s.sku);
          if (!sum) continue;
          const concl = buildPurchaseConclusion({
            predictedDailySales: s.predictedDailySales ?? null,
            fallbackDaily: sum.avgDaily7d,
            totalAvailable: sum.totalAvailable,
            totalInTransit: sum.totalInTransit,
            transferWaitShippedTotal: sum.transferWaitShippedTotal,
            domesticNonLendable: domesticNonLendable(sum.warehouseDetail, nonLendableSelected),
            productionDays: sum.productionDays,
            shippingDays: sum.shippingDays,
            bufferDays: sum.bufferDays,
            sellUntilDate: sum.sellUntilDate,
            boxQty: skuBoxQty.get(s.sku) || 1,
          });
          conclusionMap.set(s.sku, concl);
          if (concl.daily > 0) {
            // 有日均才有确定性灯/日期；否则保留 LLM 的（无数据无基准）
            s.riskLevel = concl.riskLevel;
            s.restockDate = concl.restockDate;
          }
        }

        renderResultCards(out, allSuggestions, skuBoxQty, conclusionMap);
        resetButtons();
        addLog('done', '分析完成 — ' + (isAppend ? '新增' : '') + suggestions.length + ' 条建议, 总计 ' + allSuggestions.length + ' 条, 总耗时 ' + elapsed + 'ms');
      } catch (e: any) {
        if (e.name === 'AbortError') {
          out.innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">请求超时或已取消</div>' +
            '</div>';
          addLog('error', '请求超时或已取消');
        } else if (e.message === 'AUTH_ERROR') {
          out.innerHTML =
            '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
            'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
              '<span style="font-size:16px;flex-shrink:0;">⚠️</span>' +
              '<div style="font-size:12px;color:#991b1b;line-height:1.5;">鉴权失败，请检查 API Key</div>' +
            '</div>';
          addLog('error', '鉴权失败');
        } else if (isExtensionContextInvalidatedError(e)) {
          // 扩展重载/更新后旧上下文失效（探测间隔 2s 内点击的场景）——给刷新指引
          out.innerHTML = extensionInvalidatedNoticeHtml();
          addLog('error', '扩展已更新或重新加载，请刷新页面');
        } else {
          out.innerHTML =
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
      btn.disabled = false;
      btn.textContent = '刷新分析';
      btn.style.opacity = '1';
      appendBtn.style.display = analyzedSkus.size > 0 ? '' : 'none';
      appendBtn.disabled = false;
      appendBtn.textContent = '追加分析';
      appendBtn.style.opacity = '1';
      fillBtn.style.display = allSuggestions.length > 0 ? '' : 'none';
    }

    function showLoading(): void {
      btn.disabled = true;
      btn.style.opacity = '0.7';
      appendBtn.disabled = true;
      appendBtn.style.opacity = '0.7';
      out.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px;">' +
          '<div style="display:flex;gap:7px;">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#6366f1;animation:erp-dot-pulse 1.2s infinite;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;animation:erp-dot-pulse 1.2s infinite .2s;"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:#a5b4fc;animation:erp-dot-pulse 1.2s infinite .4s;"></span>' +
          '</div>' +
          '<span style="font-size:12px;color:#64748b;font-weight:500;">AI 正在分析采购数据…</span>' +
        '</div>' +
        '<style>@keyframes erp-dot-pulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1.2)}}</style>';
    }

    // --- Button: 开始分析 (full analysis of all SKUs) ---
    btn?.addEventListener('click', async () => {
      expandIfCollapsed();
      const { skus, siteMap } = await sweepCollectSkus();
      if (skus.length === 0) {
        out.innerHTML =
          '<div style="text-align:center;padding:20px 0;color:#94a3b8;">' +
            '<div style="font-size:28px;margin-bottom:6px;">📭</div>' +
            '<div style="font-size:12px;">未检测到 SKU 数据</div>' +
          '</div>';
        btn.disabled = false; btn.textContent = '重新检测'; btn.style.opacity = '1';
        addLog('error', '未检测到 SKU 数据');
        return;
      }
      analyzedSkus.clear();
      showLoading();
      await runAnalysis(skus, false, siteMap);
    });

    // --- Button: 追加分析 (only new SKUs) ---
    appendBtn?.addEventListener('click', async () => {
      expandIfCollapsed();
      const { skus: allSkus, siteMap } = await sweepCollectSkus();
      const newSkus = allSkus.filter(function(s) { return !analyzedSkus.has(s); });

      if (newSkus.length === 0) {
        out.innerHTML =
          '<div style="text-align:center;padding:20px 0;color:#94a3b8;">' +
            '<div style="font-size:28px;margin-bottom:6px;">✅</div>' +
            '<div style="font-size:12px;">所有 SKU 均已分析，无需追加</div>' +
          '</div>';
        return;
      }

      showLoading();
      appendBtn.textContent = '分析中…';
      await runAnalysis(newSkus, true, siteMap);
    });

    // --- Button: 填入备注 ---
    fillBtn?.addEventListener('click', () => {
      fillRemarks();
    });
  }
  setTimeout(tryInject, 2000);
}

/** Extract suggested purchase qty from suggestion text (fallback when JSON field is 0) */
function extractSuggestedQty(text: string): number | null {
  const m = text.match(/建议采购量\s*[:：]\s*([\d,]+)/);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return n > 0 ? n : null;
  }
  return null;
}

/** Bold+red highlight key numbers in suggestion text */
function highlightSuggestion(text: string): string {
  return text
    .replace(
      /建议采购量\s*[:：]\s*([\d,]+件?)/g,
      '<b style="color:#dc2626;">建议采购量: $1</b>'
    )
    .replace(
      /(?:预计|预测)补货日(?:期)?\s*[:：]\s*(\d{4}-\d{2}-\d{2})/g,
      '<b style="color:#f59e0b;">预计补货日期: $1</b>'
    )
    .replace(
      /预测日均\s*[:：]\s*([\d.]+)/g,
      '<b style="color:#6366f1;">预测日均: $1</b>'
    );
}

function renderResultCards(
  out: HTMLElement,
  suggestions: LlmSuggestion[],
  skuBoxQty: Map<string, number>,
  conclusions?: Map<string, ReturnType<typeof buildPurchaseConclusion>>,
): void {
  if (!suggestions || suggestions.length === 0) {
    out.innerHTML =
      '<div style="text-align:center;padding:16px 0;color:#94a3b8;font-size:12px;">AI 未返回有效建议</div>';
    return;
  }

  let html =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="font-size:11px;color:#64748b;">共 <b style="color:#1e293b;">' + suggestions.length + '</b> 条建议</span>' +
    '</div>';

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i]!;
    const riskColor = RISK_COLORS[s.riskLevel] || '#94a3b8';
    const riskLabel = RISK_LABELS[s.riskLevel] || '';
    const concl = conclusions?.get(s.sku);

    // 数量优先用确定性公式结果（结论块同源）；无结论块时回退 LLM JSON/文本（历史路径）
    const rawQty = concl
      ? concl.qty
      : (s.suggestedQty != null && s.suggestedQty > 0)
        ? s.suggestedQty
        : extractSuggestedQty(s.suggestion || '');
    // Round up to box quantity
    const boxQty = skuBoxQty.get(s.sku) || 1;
    const displayQty = rawQty ? Math.ceil(rawQty / boxQty) * boxQty : 0;

    const restockDate = s.restockDate || '';

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
            // green（不紧急）时不显示“建议采购”先行量，改显示远期缺口，避免与“无需采购”标签矛盾
            (displayQty && s.riskLevel !== 'green'
              ? '<span style="font-size:14px;font-weight:800;color:#dc2626;margin-left:auto;">建议采购 ' + displayQty + '</span>'
              : (displayQty
                ? '<span style="font-size:12px;font-weight:700;color:#64748b;margin-left:auto;">远期缺口 ' + displayQty + '</span>'
                : (restockDate
                  ? '<span style="font-size:10px;color:#f59e0b;margin-left:auto;">预计补货日 ' + escape(restockDate) + '</span>'
                  : ''))) +
          '</div>' +
          // 确定性结论块：字段固定、数字来自公式（LLM 不再负责这些行）
          (concl
            ? '<div style="display:grid;grid-template-columns:max-content 1fr;gap:1px 10px;' +
              'background:#f8fafc;border:1px solid #f1f5f9;border-radius:6px;padding:4px 8px;margin:3px 0 4px;">' +
              concl.lines.map(function (l) {
                return '<span style="font-size:10px;color:#64748b;">' + escape(l.label) + '</span>' +
                  '<span style="font-size:10px;color:#1e293b;font-weight:600;">' + escape(l.value) + '</span>';
              }).join('') +
              '</div>'
            : '') +
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
