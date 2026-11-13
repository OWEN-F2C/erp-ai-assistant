import { defineBackground } from 'wxt/sandbox';
import type { ModuleCancelMessage, ModuleMessage, StreamErrorMessage } from '../shared/types';
import type { StreamChunkMessage, StreamDoneMessage, StreamLogMessage } from '../shared/types';
import { getModuleById, registerModule } from '../modules';
import { purchasePlan } from '../modules/purchase-plan';
import { transferPlan } from '../modules/transfer-plan';
import { purchasePlanGenerator } from '../modules/purchase-plan-generator';
import { resolveStatus, updateIconStatus } from '../shared/status';
import { getSettings } from '../shared/settings';

export default defineBackground(() => {
  // --- Module registration ---
  registerModule(purchasePlan);
  registerModule(transferPlan);
  registerModule(purchasePlanGenerator);

  // --- Settings migration: backfill stored settings with defaults on install/update,
  //     so old-version data gains new fields (thinkingEnabled etc.) instead of
  //     resolving to undefined at every read site. ---
  chrome.runtime.onInstalled.addListener(() => {
    getSettings().then((merged) => {
      chrome.storage.local.set({ settings: merged });
    }).catch(() => { /* storage unavailable — read sites still merge defaults */ });
  });

  // --- Active requests: tracks abort controllers and source tab IDs ---
  interface ActiveRequest {
    controller: AbortController;
    tabId: number;
  }
  const activeRequests = new Map<string, ActiveRequest>();

  // --- Send message to content script ---
  // In MV3, runtime.sendMessage from SW does NOT reach content scripts —
  // must use tabs.sendMessage with the tab ID.
  function sendToTab(tabId: number, msg: Record<string, unknown>): void {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {
      // Tab may have been closed or content script not loaded
    });
  }

  // --- Module message handler ---
  chrome.runtime.onMessage.addListener(
    (msg, sender, _sendResponse) => {
      const tabId = sender.tab?.id;

      // Handle cancel messages
      if ((msg as ModuleCancelMessage).type === 'module:cancel') {
        const cancelMsg = msg as ModuleCancelMessage;
        const req = activeRequests.get(cancelMsg.requestId);
        if (req) {
          req.controller.abort();
          activeRequests.delete(cancelMsg.requestId);
        }
        return false;
      }

      if (msg.type !== 'module:invoke') return false;

      if (!tabId) {
        // No tab ID — should not happen for content script messages
        return false;
      }

      handleInvoke(msg as ModuleMessage, tabId).catch((err: Error) => {
        const errorMsg: StreamErrorMessage = {
          type: 'stream:error',
          requestId: (msg as ModuleMessage).requestId,
          message: err.message || '未知错误',
        };
        sendToTab(tabId, errorMsg);
      });

      return false; // response handled via tabs.sendMessage, not sendResponse
    },
  );

  async function handleInvoke(msg: ModuleMessage, tabId: number): Promise<void> {
    const module = getModuleById(msg.moduleId);
    if (!module) throw new Error(`Unknown module: ${msg.moduleId}`);

    const settings = await getSettings();

    // Check module toggle
    if (msg.moduleId === 'purchase-plan' && !settings.purchaseModule) {
      sendToTab(tabId, {
        type: 'stream:error',
        requestId: msg.requestId,
        message: '该功能模块已在设置中关闭',
      });
      return;
    }
    if (msg.moduleId === 'transfer-plan' && !settings.transferModule) {
      sendToTab(tabId, {
        type: 'stream:error',
        requestId: msg.requestId,
        message: '该功能模块已在设置中关闭',
      });
      return;
    }

    if (!settings.apiKey) {
      sendToTab(tabId, {
        type: 'stream:error',
        requestId: msg.requestId,
        message: 'API Key 未配置，请在设置中配置',
      });
      return;
    }

    const controller = new AbortController();
    activeRequests.set(msg.requestId, { controller, tabId });

    // Timeout: first-byte 60s, chunk interval 20s, total 120s
    let chunkTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => controller.abort(),
      60_000,
    );
    const totalTimer = setTimeout(() => controller.abort(), 120_000);

    const gen = module.handler(msg.payload, controller.signal);

    try {
      for await (const event of gen) {
        switch (event.type) {
          case 'chunk': {
            clearTimeout(chunkTimer);
            const chunkMsg: StreamChunkMessage = {
              type: 'stream:chunk',
              requestId: msg.requestId,
              chunkType: event.chunkType,
              chunk: event.data,
            };
            sendToTab(tabId, chunkMsg);
            chunkTimer = setTimeout(() => controller.abort(), 20_000);
            break;
          }
          case 'done': {
            const doneMsg: StreamDoneMessage = {
              type: 'stream:done',
              requestId: msg.requestId,
              result: event.result,
            };
            sendToTab(tabId, doneMsg);
            return;
          }
          case 'log': {
            const logMsg: StreamLogMessage = {
              type: 'stream:log',
              requestId: msg.requestId,
              step: event.step,
              message: event.message,
            };
            sendToTab(tabId, logMsg);
            break;
          }
          case 'error': {
            const errorMsg: StreamErrorMessage = {
              type: 'stream:error',
              requestId: msg.requestId,
              message: event.message,
            };
            sendToTab(tabId, errorMsg);
            return;
          }
        }
      }
    } catch (err: unknown) {
      const msg2 =
        err instanceof Error && err.name === 'AbortError'
          ? '(生成中断)'
          : `请求失败: ${String(err)}`;
      const errorMsg: StreamErrorMessage = {
        type: 'stream:error',
        requestId: msg.requestId,
        message: msg2,
      };
      sendToTab(tabId, errorMsg);
    } finally {
      activeRequests.delete(msg.requestId);
      clearTimeout(totalTimer);
      clearTimeout(chunkTimer!);
    }
  }

  // --- Icon status check ---
  async function checkAndUpdateIcon(): Promise<void> {
    const settings = await getSettings();
    const hasApiKey = settings.apiKey.length > 0;

    let sessionExpired = false;
    const ERP_DOMAINS = ['https://erp.jijia.com.cn', 'https://bckj.app.gerpgo.com'];
    try {
      let hasAnyCookie = false;
      for (const domain of ERP_DOMAINS) {
        const cookie = await chrome.cookies.get({ url: domain, name: 'JSESSIONID' });
        if (cookie) { hasAnyCookie = true; break; }
      }
      sessionExpired = !hasAnyCookie;
    } catch {
      // If cookies API fails, don't flag as expired
    }

    const status = resolveStatus(sessionExpired, hasApiKey);
    await updateIconStatus(status);
  }

  // --- Safari permissions check (I5) ---
  async function checkHostPermissions(): Promise<void> {
    const ERP_ORIGINS = ['*://*.jijia.com.cn/*', '*://*.app.gerpgo.com/*'];
    try {
      const hasPermission = await chrome.permissions.contains({
        origins: ERP_ORIGINS,
      });
      await chrome.storage.local.set({ hostPermissionGranted: hasPermission });
    } catch {
      await chrome.storage.local.set({ hostPermissionGranted: true });
    }
  }

  // Check on startup and every 5 minutes.
  // MV3 Service Worker 空闲约 30s 即被杀，setInterval 基本不会触发；
  // 用 chrome.alarms 保底周期刷新（需 manifest 的 alarms 权限）。
  checkAndUpdateIcon();
  checkHostPermissions();
  chrome.alarms.create('erp-icon-check', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'erp-icon-check') {
      checkAndUpdateIcon().catch(() => { /* 图标更新失败不影响功能 */ });
    }
  });
});
