// components/settings-panel.ts
import type { LlmProvider, LlmModelOption, Settings, MarketGroup } from '../shared/types';
import { DEFAULT_SETTINGS, LLM_MODEL_OPTIONS, defaultProfitStartMonth } from '../shared/types';
import { localDaysAgo } from '../shared/jijia-api';
import { UI_SCALE_MIN, UI_SCALE_MAX, stepUiScale, normalizeUiScale } from '../shared/ui-scale';
import { createDevPanel } from './dev-panel';

interface SettingsPanel {
  mount: (parent: ShadowRoot) => void;
  unmount: () => void;
}

export function createSettingsPanel(
  onSave: (s: Settings) => void,
  onClose: () => void,
): SettingsPanel {
  let overlay: HTMLDivElement | null = null;
  let modal: HTMLDivElement | null = null;
  let devPanel: ReturnType<typeof createDevPanel> | null = null;
  let devPanelMounted = false;

  async function loadCurrentSettings(): Promise<Settings> {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings>) };
  }

  async function mount(parent: ShadowRoot): Promise<void> {
    const settings = await loadCurrentSettings();

    // Overlay
    overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.3);
      z-index: 2147483645;
    `;
    overlay.addEventListener('click', () => {
      unmount();
      onClose();
    });

    // Modal
    modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 70px;
      width: 300px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #333;
      overflow: hidden;
    `;

    modal.innerHTML = `
      <div style="display:flex;border-bottom:1px solid #eee;background:#fafafa;">
        <div id="ep-tab-settings" style="padding:8px 14px;font-size:12px;font-weight:600;color:#4A90D9;cursor:pointer;border-bottom:2px solid #4A90D9;">设置</div>
        <div id="ep-tab-developer" style="padding:8px 14px;font-size:12px;color:#999;cursor:pointer;display:none;">开发者</div>
        <div style="flex:1;"></div>
        <span id="ep-close" style="padding:8px 14px;font-size:18px;color:#999;cursor:pointer;line-height:1;">×</span>
      </div>

      <!-- Settings Tab Content -->
      <div id="ep-content-settings" style="padding:12px 14px;">
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:4px;">AI 配置</div>
          <select id="ep-provider" style="width:100%;padding:6px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;margin-bottom:4px;box-sizing:border-box;">
            <option value="">请选择供应商</option>
            <option value="deepseek">DeepSeek</option>
          </select>
          <div style="display:flex;gap:4px;margin-bottom:4px;">
            <select id="ep-model" style="flex:1;padding:6px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
              <option value="">请先选择供应商</option>
            </select>
            <button id="ep-refresh-models" title="刷新模型列表" style="padding:4px 8px;font-size:11px;background:#f0f0f0;border:1px solid #ddd;border-radius:4px;cursor:pointer;white-space:nowrap;">🔄</button>
          </div>
          <input id="ep-apikey" type="password" placeholder="API Key" style="width:100%;padding:6px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
          <div style="display:flex;gap:6px;margin-top:4px;align-items:center;">
            <button id="ep-test-connection" style="font-size:10px;padding:3px 10px;background:#e8e8e8;border:1px solid #ccc;border-radius:3px;cursor:pointer;">🔗 测试连接</button>
            <span id="ep-test-result" style="font-size:10px;"></span>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #f0f0f0;">
            <div style="font-size:10px;font-weight:600;color:#999;margin-bottom:4px;">思考模式</div>
            <label style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;cursor:pointer;">
              启用深度思考
              <input id="ep-thinking" type="checkbox" checked style="accent-color:#4A90D9;">
            </label>
            <div style="margin-top:4px;">
              <div style="font-size:10px;color:#999;margin-bottom:2px;">思考强度</div>
              <select id="ep-reasoning-effort" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
                <option value="low">低 (快速)</option>
                <option value="high" selected>高 (推荐)</option>
                <option value="max">最大 (深度推理)</option>
              </select>
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:6px;">开发者</div>
          <label style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;cursor:pointer;">
            开发者模式
            <input id="ep-dev-mode" type="checkbox" style="accent-color:#4A90D9;">
          </label>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:6px;">界面</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="ep-scale-down" title="缩小" style="padding:3px 10px;font-size:12px;font-weight:700;background:#f0f0f0;border:1px solid #ddd;border-radius:4px;cursor:pointer;">A−</button>
            <span id="ep-scale-value" style="flex:1;text-align:center;font-size:11px;font-weight:600;">100%</span>
            <button id="ep-scale-up" title="放大" style="padding:3px 10px;font-size:12px;font-weight:700;background:#f0f0f0;border:1px solid #ddd;border-radius:4px;cursor:pointer;">A+</button>
            <button id="ep-scale-reset" style="padding:3px 10px;font-size:10px;background:#e8e8e8;border:1px solid #ccc;border-radius:4px;cursor:pointer;">重置</button>
          </div>
          <div style="font-size:9px;color:#94a3b8;margin-top:2px;">插件面板整体缩放（70%–150%），点保存后对所有面板生效</div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:6px;">功能开关</div>
          <label style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;cursor:pointer;">
            采购建议
            <input id="ep-purchase" type="checkbox" checked style="accent-color:#4A90D9;">
          </label>
          <label style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;cursor:pointer;">
            调拨建议
            <input id="ep-transfer" type="checkbox" checked style="accent-color:#4A90D9;">
          </label>
          <label style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;cursor:pointer;">
            净利润看板
            <input id="ep-profit" type="checkbox" checked style="accent-color:#4A90D9;">
          </label>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:4px;">多站点汇总组</div>
          <div style="font-size:10px;color:#94a3b8;margin-bottom:6px;">配置后，命中组内任一站点时将自动汇总整组销量</div>
          <div id="ep-market-groups"></div>
          <button id="ep-add-group" style="font-size:10px;padding:3px 10px;background:#e8e8e8;border:1px solid #ccc;border-radius:3px;cursor:pointer;margin-top:4px;">+ 添加汇总组</button>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:4px;">全渠道净利润</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:10px;white-space:nowrap;">起始月份</label>
            <input id="ep-profit-start-month" type="month"
              style="flex:1;padding:4px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
          </div>
          <div id="ep-profit-month-error" style="font-size:10px;color:#c00;margin-top:2px;display:none;"></div>
          <div style="font-size:9px;color:#94a3b8;margin-top:2px;">查询范围：起始月 至 当前月</div>
        </div>
        <div style="text-align:right;">
          <button id="ep-save" style="padding:5px 18px;background:#4A90D9;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer;">保存</button>
        </div>
      </div>

      <!-- Developer Tab Content -->
      <div id="ep-content-developer" style="display:none;padding:12px 14px;min-height:200px;">
        <p style="color:#999;font-size:12px;text-align:center;padding-top:60px;">开发者面板加载中…</p>
      </div>
    `;

    // Populate form
    const providerSel = modal.querySelector('#ep-provider') as HTMLSelectElement;
    const modelSel = modal.querySelector('#ep-model') as HTMLSelectElement;
    const refreshBtn = modal.querySelector('#ep-refresh-models') as HTMLButtonElement;
    const apiKeyInput = modal.querySelector('#ep-apikey') as HTMLInputElement;
    const thinkingCb = modal.querySelector('#ep-thinking') as HTMLInputElement;
    const reasoningEffortSel = modal.querySelector('#ep-reasoning-effort') as HTMLSelectElement;
    const purchaseCb = modal.querySelector('#ep-purchase') as HTMLInputElement;
    const transferCb = modal.querySelector('#ep-transfer') as HTMLInputElement;
    const profitCb = modal.querySelector('#ep-profit') as HTMLInputElement;

    let savedModel = settings.llmModel;

    // --- Panel scale（界面缩放：A± 步进 10%，即时预览本弹窗，保存后全面板生效）---
    let currentScale = normalizeUiScale(settings.uiScale);
    const scaleDownBtn = modal.querySelector('#ep-scale-down') as HTMLButtonElement;
    const scaleUpBtn = modal.querySelector('#ep-scale-up') as HTMLButtonElement;
    const scaleResetBtn = modal.querySelector('#ep-scale-reset') as HTMLButtonElement;
    const scaleValueEl = modal.querySelector('#ep-scale-value') as HTMLElement;
    function applyScalePreview(): void {
      modal!.style.zoom = String(currentScale);
      scaleValueEl.textContent = Math.round(currentScale * 100) + '%';
      scaleUpBtn.disabled = currentScale >= UI_SCALE_MAX;
      scaleDownBtn.disabled = currentScale <= UI_SCALE_MIN;
      scaleUpBtn.style.color = scaleUpBtn.disabled ? '#bbb' : '';
      scaleDownBtn.style.color = scaleDownBtn.disabled ? '#bbb' : '';
    }
    scaleDownBtn.addEventListener('click', () => { currentScale = stepUiScale(currentScale, -1); applyScalePreview(); });
    scaleUpBtn.addEventListener('click', () => { currentScale = stepUiScale(currentScale, 1); applyScalePreview(); });
    scaleResetBtn.addEventListener('click', () => { currentScale = 1; applyScalePreview(); });
    applyScalePreview();

    // --- Market Groups state ---
    let marketGroups: MarketGroup[] = Array.isArray(settings.marketGroups) ? [...settings.marketGroups] : [];

    // Known Amazon marketplace codes (fallback when API unavailable)
    const KNOWN_MARKETS = new Set([
      'AE','AU','BE','BR','CA','DE','EG','ES','FR','GB','IE','IN','IT','JP','MX','NL','PL','SA','SE','SG','TR','UK','US',
    ]);

    // API-based market code cache
    let apiMarketCache: Set<string> | null = null;
    let apiMarketFetching = false;

    async function fetchMarketCodesFromApi(): Promise<Set<string>> {
      let token: string | null = null;
      try {
        const iframe = document.querySelector('#amzv-web') as HTMLIFrameElement | null;
        if (iframe?.contentWindow) {
          token = iframe.contentWindow.sessionStorage.getItem('x-auth-token');
        }
      } catch { /* cross-origin iframe */ }
      if (!token && typeof sessionStorage !== 'undefined') {
        token = sessionStorage.getItem('x-auth-token');
      }
      if (!token) throw new Error('No auth token');

      // 7-day window to capture sparse markets（本地时区闭区间 7 天：今天−6 ~ 今天；
      // toISOString 是 UTC，CST 00:00–08:00 会取到昨天）
      const beginDate = localDaysAgo(6);
      const endDate = localDaysAgo(0);

      const resp = await fetch('https://gateway.apist.gerpgo.com/v3/statistics/salesAnalysis/asinView', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({
          currency: 'YUAN', groupByType: 'asin', isShowTotal: false,
          beginDate, endDate,
          keywordsSearch: { selectType: 1, asinList: [] }, skuList: [],
          isRingRatio: false, sort: 'unitsOrdered', order: 'descend',
          page: 1, pagesize: 500,
        }),
      });
      if (!resp.ok) throw new Error('API ' + resp.status);

      const json = await resp.json();
      const rows = json.data?.rows || [];
      const codes = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const mn = (rows[i].marketName || '').toUpperCase();
        const parts = mn.split(':');
        codes.add(parts[parts.length - 1]);
      }
      // If API returned too few markets (e.g. sparse account), the set is
      // unreliable — throw so the caller falls back to the hardcoded list.
      if (codes.size < 5) throw new Error('Too few markets from API');
      return codes;
    }

    async function getMarketCodes(): Promise<Set<string>> {
      if (apiMarketCache) return apiMarketCache;
      if (apiMarketFetching) return KNOWN_MARKETS; // already fetching, use fallback
      apiMarketFetching = true;
      try {
        apiMarketCache = await fetchMarketCodesFromApi();
        return apiMarketCache;
      } catch {
        return KNOWN_MARKETS;
      } finally {
        apiMarketFetching = false;
      }
    }

    const groupsContainer = modal.querySelector('#ep-market-groups') as HTMLElement;

    function renderMarketGroups(): void {
      let html = '';
      for (let i = 0; i < marketGroups.length; i++) {
        const g = marketGroups[i];
        html +=
          '<div class="ep-mg-row" data-index="' + i + '" style="display:flex;gap:4px;margin-bottom:4px;align-items:center;">' +
            '<input class="ep-mg-name" type="text" placeholder="组名" value="' + escapeHtml(g.name) + '" ' +
            'style="width:70px;padding:4px 6px;font-size:10px;border:1px solid #ddd;border-radius:3px;">' +
            '<input class="ep-mg-markets" type="text" placeholder="DE,FR,IT,ES" value="' + escapeHtml(g.markets.join(',')) + '" ' +
            'style="flex:1;padding:4px 6px;font-size:10px;border:1px solid #ddd;border-radius:3px;">' +
            '<button class="ep-mg-del" data-index="' + i + '" style="padding:2px 6px;font-size:10px;background:transparent;border:none;color:#c00;cursor:pointer;">×</button>' +
          '</div>';
      }
      groupsContainer.innerHTML = html || '<div style="font-size:10px;color:#bbb;padding:4px 0;">暂无汇总组</div>';

      // Bind delete buttons
      groupsContainer.querySelectorAll('.ep-mg-del').forEach(function(btn) {
        btn.addEventListener('click', function(this: HTMLButtonElement) {
          const idx = parseInt(this.dataset.index || '', 10);
          if (!isNaN(idx) && idx >= 0 && idx < marketGroups.length) {
            marketGroups.splice(idx, 1);
            renderMarketGroups();
          }
        });
      });

      // Bind market code validation on input (API-based, hardcoded fallback)
      groupsContainer.querySelectorAll('.ep-mg-markets').forEach(function(inp) {
        const input = inp as HTMLInputElement;
        async function validateMarketsInput(): Promise<void> {
          const raw = input.value.trim();
          if (!raw) { input.style.borderColor = '#ddd'; return; }
          const codes = raw.split(',').map(function(c) { return c.trim().toUpperCase(); }).filter(Boolean);
          if (codes.length === 0) { input.style.borderColor = '#ddd'; return; }

          input.style.borderColor = '#f59e0b'; // validating...
          const validCodes = await getMarketCodes();
          const unknowns = codes.filter(function(c) { return !validCodes.has(c); });
          if (unknowns.length > 0) {
            input.style.borderColor = '#e74c3c';
            input.title = '未知站点: ' + unknowns.join(', ') + '（已通过API验证）';
          } else {
            input.style.borderColor = '#27ae60';
            input.title = '已验证 (' + codes.length + '个站点均有效)';
          }
        }
        input.addEventListener('blur', function() { validateMarketsInput(); });
        input.addEventListener('input', function() { input.style.borderColor = '#ddd'; });
        // Validate on initial render if has value
        if (input.value.trim()) validateMarketsInput();
      });
    }

    // Read values back from DOM before save
    function readMarketGroupsFromUI(): MarketGroup[] {
      const rows = groupsContainer.querySelectorAll('.ep-mg-row');
      const result: MarketGroup[] = [];
      for (let i = 0; i < rows.length; i++) {
        const nameInput = rows[i].querySelector('.ep-mg-name') as HTMLInputElement;
        const marketsInput = rows[i].querySelector('.ep-mg-markets') as HTMLInputElement;
        const name = (nameInput?.value || '').trim();
        const raw = (marketsInput?.value || '').trim();
        const markets = raw.split(',').map(function(m) { return m.trim().toUpperCase(); }).filter(Boolean);
        result.push({ name: name, markets: markets });
      }
      return result;
    }

    function validateMarketGroups(groups: MarketGroup[]): string | null {
      // Empty is valid
      if (groups.length === 0) return null;

      // Check for empty names or markets
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (!g.name) return '组名不能为空（第' + (i + 1) + '行）';
        if (g.markets.length === 0) return '至少需要一个站点（第' + (i + 1) + '行）';
      }

      // Check duplicate group names
      const names = new Set<string>();
      for (const g of groups) {
        if (names.has(g.name)) return '组名重复: "' + g.name + '"';
        names.add(g.name);
      }

      // Check duplicate market codes across groups
      const seen = new Map<string, string>(); // market -> group name
      for (const g of groups) {
        for (const m of g.markets) {
          const existing = seen.get(m);
          if (existing) return '站点 ' + m + ' 已在组 "' + existing + '" 中';
          seen.set(m, g.name);
        }
      }

      return null; // valid
    }

    renderMarketGroups();

    // Profit start month picker
    const profitMonthInput = modal.querySelector('#ep-profit-start-month') as HTMLInputElement;
    const profitMonthError = modal.querySelector('#ep-profit-month-error') as HTMLElement;

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    profitMonthInput.max = currentMonth;
    profitMonthInput.value = settings.profitStartMonth || defaultProfitStartMonth();

    profitMonthInput.addEventListener('change', () => {
      const v = profitMonthInput.value;
      if (v > currentMonth) {
        profitMonthInput.style.borderColor = '#c00';
        profitMonthError.textContent = `起始月份不能晚于 ${currentMonth}`;
        profitMonthError.style.display = '';
      } else {
        profitMonthInput.style.borderColor = '#ddd';
        profitMonthError.style.display = 'none';
      }
    });

    // Add group button
    modal.querySelector('#ep-add-group')?.addEventListener('click', function() {
      marketGroups.push({ name: '', markets: [] });
      renderMarketGroups();
    });

    // API endpoints for listing models
    const MODEL_LIST_URLS: Record<string, string> = {
      deepseek: 'https://api.deepseek.com/v1/models',
    };

    async function fetchModelsFromApi(provider: string, apiKey: string): Promise<LlmModelOption[]> {
      const url = MODEL_LIST_URLS[provider];
      if (!url) return [];

      const resp = await fetch(url, {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (!resp.ok) return [];

      const json = await resp.json();
      const models: { id: string }[] = json.data || [];
      const prefixes: Record<string, string[]> = {
        deepseek: ['deepseek'],
      };
      const allowed = prefixes[provider] || [];

      return models
        .filter((m) => allowed.some((p) => m.id.startsWith(p)))
        .map((m) => ({ value: m.id, label: m.id }))
        .sort((a, b) => b.label.localeCompare(a.label)); // newest first
    }

    async function refreshModelList(): Promise<void> {
      const provider = providerSel.value;
      const apiKey = apiKeyInput.value.trim();

      if (!provider) {
        modelSel.innerHTML = '<option value="">请先选择供应商</option>';
        modelSel.disabled = true;
        return;
      }

      modelSel.innerHTML = '<option value="">⏳ 加载中…</option>';
      modelSel.disabled = true;

      let models: LlmModelOption[] = [];

      if (apiKey) {
        try {
          models = await fetchModelsFromApi(provider, apiKey);
        } catch {
          // fall through to hardcoded fallback
        }
      }

      // Fallback to hardcoded list
      if (models.length === 0) {
        models = LLM_MODEL_OPTIONS[provider as LlmProvider] || [];
      }

      modelSel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSel.appendChild(opt);
      }
      modelSel.disabled = false;

      // Restore saved model if it's in the list, otherwise add it
      if (savedModel) {
        if (models.some((m) => m.value === savedModel)) {
          modelSel.value = savedModel;
        } else {
          const opt = document.createElement('option');
          opt.value = savedModel;
          opt.textContent = savedModel + ' (已保存)';
          modelSel.insertBefore(opt, modelSel.firstChild);
          modelSel.value = savedModel;
        }
      }
    }

    if (settings.llmProvider) {
      providerSel.value = settings.llmProvider;
    }
    apiKeyInput.value = settings.apiKey;
    thinkingCb.checked = settings.thinkingEnabled;
    reasoningEffortSel.value = settings.reasoningEffort || 'high';
    purchaseCb.checked = settings.purchaseModule;
    transferCb.checked = settings.transferModule;
    profitCb.checked = settings.profitModule;

    // Initial model list load
    refreshModelList();

    // Provider change → refresh model list
    providerSel.addEventListener('change', () => {
      savedModel = '';
      refreshModelList();
    });

    // Refresh button
    refreshBtn.addEventListener('click', () => {
      refreshModelList();
    });

    // API key change → re-fetch on blur (to get real model list)
    apiKeyInput.addEventListener('blur', () => {
      refreshModelList();
    });

    // --- Tab switching ---
    const tabSettings = modal.querySelector('#ep-tab-settings') as HTMLDivElement;
    const tabDeveloper = modal.querySelector('#ep-tab-developer') as HTMLDivElement;
    const contentSettings = modal.querySelector('#ep-content-settings') as HTMLDivElement;
    const contentDeveloper = modal.querySelector('#ep-content-developer') as HTMLDivElement;

    function showSettingsTab(): void {
      tabSettings.style.color = '#4A90D9';
      tabSettings.style.borderBottom = '2px solid #4A90D9';
      tabDeveloper.style.color = '#999';
      tabDeveloper.style.borderBottom = 'none';
      contentSettings.style.display = '';
      contentDeveloper.style.display = 'none';
    }

    function showDeveloperTab(): void {
      tabDeveloper.style.color = '#4A90D9';
      tabDeveloper.style.borderBottom = '2px solid #4A90D9';
      tabSettings.style.color = '#999';
      tabSettings.style.borderBottom = 'none';
      contentSettings.style.display = 'none';
      contentDeveloper.style.display = '';

      if (!devPanelMounted && contentDeveloper) {
        contentDeveloper.innerHTML = '';
        devPanel = createDevPanel();
        devPanel.mount(contentDeveloper);
        devPanelMounted = true;
      }
    }

    tabSettings.addEventListener('click', showSettingsTab);
    tabDeveloper.addEventListener('click', showDeveloperTab);

    // --- Dev mode toggle ---
    const devModeCb = modal.querySelector('#ep-dev-mode') as HTMLInputElement;
    devModeCb.checked = settings.devMode;

    function updateDevTabVisibility(): void {
      if (devModeCb.checked) {
        tabDeveloper.style.display = '';
      } else {
        tabDeveloper.style.display = 'none';
        if (contentDeveloper.style.display !== 'none') showSettingsTab();
      }
    }

    devModeCb.addEventListener('change', updateDevTabVisibility);
    updateDevTabVisibility();

    // Events
    modal.querySelector('#ep-close')?.addEventListener('click', () => {
      unmount();
      onClose();
    });

    modal.querySelector('#ep-save')?.addEventListener('click', async () => {
      // Read market groups from UI before validation
      marketGroups = readMarketGroupsFromUI();
      const validationError = validateMarketGroups(marketGroups);
      if (validationError) {
        const existingErr = modal.querySelector('.ep-mg-error');
        if (existingErr) existingErr.remove();
        const errEl = document.createElement('div');
        errEl.className = 'ep-mg-error';
        errEl.style.cssText = 'font-size:10px;color:#c00;margin-bottom:6px;';
        errEl.textContent = validationError;
        groupsContainer.insertBefore(errEl, groupsContainer.firstChild);
        return;
      }

      // Read autoGenerate from existing storage since there is no checkbox for it
      const currentSettings = await chrome.storage.local.get('settings');
      const existingAutoGenerate = (currentSettings.settings as any)?.autoGenerate ?? false;

      const newSettings: Settings = {
        llmProvider: (providerSel.value as LlmProvider) || '',
        llmModel: modelSel.value,
        apiKey: apiKeyInput.value.trim(),
        autoGenerate: existingAutoGenerate,
        purchaseModule: purchaseCb.checked,
        transferModule: transferCb.checked,
        profitModule: profitCb.checked,
        devMode: devModeCb.checked,
        thinkingEnabled: thinkingCb.checked,
        reasoningEffort: reasoningEffortSel.value as 'low' | 'high' | 'max',
        uiScale: currentScale,
        marketGroups: marketGroups,
        profitStartMonth: profitMonthInput.value,
      };
      chrome.storage.local.set({ settings: newSettings });
      onSave(newSettings);
      unmount();
    });

    // --- Test connection button ---
    const testBtn = modal.querySelector('#ep-test-connection') as HTMLButtonElement;
    const testResult = modal.querySelector('#ep-test-result') as HTMLElement;
    testBtn?.addEventListener('click', async () => {
      const prov = providerSel.value;
      const model = modelSel.value;
      const key = apiKeyInput.value.trim();
      if (!prov || !model || !key) {
        testResult.textContent = '请先选择供应商、模型并填写 API Key';
        testResult.style.color = '#c00';
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      testResult.textContent = '⏳ 正在验证…';
      testResult.style.color = '#888';

      const configs: Record<string, { url: string; headers: Record<string,string>; body: Record<string,unknown> }> = {
        deepseek: {
          url: 'https://api.deepseek.com/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 },
        },
      };
      const cfg = configs[prov];
      if (!cfg) { testResult.textContent = '未知模型'; testResult.style.color = '#c00'; testBtn.disabled = false; testBtn.textContent = '🔗 测试连接'; return; }

      try {
        const resp = await fetch(cfg.url, { method: 'POST', headers: cfg.headers, body: JSON.stringify(cfg.body) });
        if (resp.ok) {
          testResult.textContent = '✅ 连接成功 (' + prov + '/' + model + ')';
          testResult.style.color = '#390';
        } else {
          const errText = await resp.text().catch(() => '');
          testResult.textContent = '❌ ' + resp.status + (errText ? ': ' + errText.slice(0, 80) : '');
          testResult.style.color = '#c00';
        }
      } catch (e: any) {
        testResult.textContent = '❌ 网络错误: ' + (e.message || '');
        testResult.style.color = '#c00';
      }
      testBtn.disabled = false;
      testBtn.textContent = '🔗 测试连接';
    });

    // Stop clicks inside modal from closing it
    modal.addEventListener('click', (e) => e.stopPropagation());

    parent.appendChild(overlay);
    parent.appendChild(modal);
  }

  function unmount(): void {
    if (devPanel) {
      devPanel.unmount();
      devPanel = null;
      devPanelMounted = false;
    }
    overlay?.remove();
    modal?.remove();
    overlay = null;
    modal = null;
  }

  return { mount, unmount };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
