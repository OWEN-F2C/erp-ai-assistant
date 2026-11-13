// entrypoints/content.ts
import { defineContentScript } from 'wxt/sandbox';
import { createFloatingBall } from '../components/floating-ball';
import { createSettingsPanel } from '../components/settings-panel';
import { render as renderPurchasePlan } from '../modules/purchase-plan/ui';
import { render as renderTransferPlan } from '../modules/transfer-plan/ui';
import { renderProfitSummary } from '../modules/profit-summary/ui';
import { render as renderPurchasePlanGenerator } from '../modules/purchase-plan-generator/ui';
import { pageRoute } from '../shared/page-route';
import { getSettings } from '../shared/settings';
import { dedupeExtensionPanels } from '../shared/panel-dedup';
import { isExtensionContextValid } from '../shared/extension-context';
import type { Settings, ErpPlatform } from '../shared/types';

function detectPlatform(): ErpPlatform | null {
  const host = window.location.hostname.toLowerCase();
  if (host.includes('jijia.com.cn') || host.includes('gerpgo.com')) return 'jijia';
  return null;
}

// Shadow DOM CSS reset — inlined because WXT treats .css files in entrypoints/
// as separate entrypoints, which conflicts with the .ts file of the same name.
const SHADOW_CSS = `
#erp-enhancer-root {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  color: #333;
}
`;

export default defineContentScript({
  matches: ['*://*.jijia.com.cn/*', '*://*.app.gerpgo.com/*'],
  cssInjectionMode: 'manual',

  async main(ctx) {
    // --- Platform detection (future-proof: skip non-积加 ERPs) ---
    const platform = detectPlatform();
    if (!platform) return; // not a supported ERP — silently exit

    // --- Shadow DOM host ---
    const host = document.createElement('div');
    host.id = 'erp-enhancer-host';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    // Inject styles into Shadow DOM
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    const appRoot = document.createElement('div');
    appRoot.id = 'erp-enhancer-root';
    root.appendChild(appRoot);

    // --- Safari permissions banner (I5) ---
    const stored = await chrome.storage.local.get('hostPermissionGranted');
    if (stored.hostPermissionGranted === false) {
      const banner = document.createElement('div');
      banner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0;
        background: #fff3cd; color: #856404;
        text-align: center; padding: 8px; font-size: 13px;
        z-index: 2147483647; border-bottom: 1px solid #ffc107;
      `;
      banner.textContent =
        'ERP增强助手需要获取积加网站的访问权限，请在浏览器扩展管理中启用。';
      document.body.appendChild(banner);
    }

    // --- Init modules ---
    const settings = await getSettings();
    const pageUrl = window.location.href.toLowerCase();

    // --- Floating ball + settings ---
    let panelUnmount: (() => void) | null = null;

    const ball = createFloatingBall((open) => {
      if (open) {
        const panel = createSettingsPanel(
          (_settings: Settings) => {
            // Refresh module visibility after settings change
            window.location.reload();
          },
          () => {
            panelUnmount?.();
            panelUnmount = null;
          },
        );
        panel.mount(root);
        panelUnmount = () => panel.unmount();
      } else {
        panelUnmount?.();
        panelUnmount = null;
      }
    });
    ball.mount(root);


    // --- Iframe panel injection (load event + lightweight poll) ---
    let lastIframeUrl = '';
    let purchaseInjected = false;
    let transferInjected = false;
    let profitInjected = false;
    let generatorInjected = false;

    function doInject(doc: Document): void {
      // Only inject 积加 modules on 积加 platform
      if (platform !== 'jijia') return;

      const href = doc.location.href.toLowerCase();
      if (href !== lastIframeUrl) {
        // URL changed — remove injected panels from old page if they're still in DOM
        // (handles SPA navigation within iframe where document isn't replaced)
        if (profitInjected) {
          doc.querySelectorAll('.erp-profit-panel').forEach(el => el.remove());
        }
        if (purchaseInjected) {
          doc.querySelectorAll('.erp-ai-panel').forEach(el => el.remove());
        }
        if (transferInjected) {
          doc.querySelectorAll('.erp-transfer-ai-panel').forEach(el => el.remove());
        }
        if (generatorInjected) {
          doc.querySelectorAll('.erp-gen-panel').forEach(el => el.remove());
        }
        lastIframeUrl = href;
        purchaseInjected = false;
        transferInjected = false;
        profitInjected = false;
        generatorInjected = false;
      }
      const route = pageRoute(href);
      if (route === 'generator') {
        // If flagged AND panel still in DOM, skip. If flagged but panel gone, re-inject.
        if (generatorInjected && doc.querySelector('.erp-gen-panel')) return;
        generatorInjected = true;
        try {
          renderPurchasePlanGenerator(null as unknown as HTMLElement, { settings }, doc);
        } catch (e) { generatorInjected = false; }
      } else if (route === 'purchase' && settings.purchaseModule) {
        if (purchaseInjected && doc.querySelector('.erp-ai-panel')) return;
        purchaseInjected = true;
        try {
          renderPurchasePlan(null as unknown as HTMLElement, { settings }, doc);
        } catch (e) { purchaseInjected = false; }
      } else if (route === 'transfer' && settings.transferModule) {
        if (transferInjected && doc.querySelector('.erp-transfer-ai-panel')) return;
        transferInjected = true;
        try {
          renderTransferPlan(null as unknown as HTMLElement, { settings }, doc);
        } catch (e) { transferInjected = false; }
      } else if (route === 'profit' && settings.profitModule) {
        if (profitInjected && doc.querySelector('.erp-profit-panel')) return;
        profitInjected = true;
        try {
          renderProfitSummary(doc, settings);
        } catch (e) { profitInjected = false; }
      }
    }

    function check(): void {
      const doc = (document.querySelector('#amzv-web') as HTMLIFrameElement | null)?.contentDocument;
      if (doc?.body) doInject(doc);
    }

    // load event: detects navigation, triggers immediate check
    (function bind(): void {
      const iframe = document.querySelector('#amzv-web') as HTMLIFrameElement | null;
      if (!iframe) { setTimeout(bind, 500); return; }
      iframe.addEventListener('load', check);
      check();
    })();

    // Poll fallback: catches missed load events (e.g. content script loaded after iframe)
    // 扩展重载/更新自检：旧实例的注入器整体退场（移除悬浮球 + 停轮询，把页面让给
    // 重载后的新实例；面板留给面板自身的失效检测显示刷新指引）
    const hadExtensionContext = isExtensionContextValid();
    const pollTimer = setInterval(() => {
      if (hadExtensionContext && !isExtensionContextValid()) {
        document.getElementById('erp-enhancer-host')?.remove();
        clearInterval(pollTimer);
        return;
      }
      const doc = (document.querySelector('#amzv-web') as HTMLIFrameElement | null)?.contentDocument;
      if (!doc?.body) return;
      // 去重看门狗：必须在早退判断之前——"URL 没变且已注入"的稳态下轮询不进
      // doInject，放里面永远不跑（2026-09-08 活体实证：注入假双面板 2.5s 不被清理）
      dedupeExtensionPanels(doc);
      const href = doc.location.href.toLowerCase();
      // URL unchanged and already injected — nothing to do
      if (href === lastIframeUrl && (purchaseInjected || transferInjected || profitInjected || generatorInjected)) return;
      doInject(doc);
    }, 1000);
  },
});
