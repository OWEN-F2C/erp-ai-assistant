// components/dev-panel.ts
// Analysis log viewer + AI Console for direct LLM testing.

import { getSettings } from '../shared/settings';
import { getLogs, clearLogs, onLog, type LogEntry } from '../shared/analysis-log';

interface DevPanel {
  mount: (parent: HTMLElement) => void;
  unmount: () => void;
}

const STEP_ICONS: Record<string, string> = {
  sku_detect: '📦',
  request: '📡',
  sales_fetch: '📊',
  sales_cached: '💾',
  sales_done: '📊',
  sales_skip: '⚠️',
  llm_start: '🚀',
  llm_cache: '💾',
  reasoning: '💭',
  llm_reasoning_done: '🧠',
  llm_first_byte: '⚡',
  llm_parse: '🔍',
  llm_parsed: '📝',
  prompt: '📋',
  done: '✅',
  error: '❌',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
    d.getMinutes().toString().padStart(2, '0') + ':' +
    d.getSeconds().toString().padStart(2, '0');
}

function escape(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, function(c) { return map[c] ?? c; });
}

/**
 * Direct LLM streaming call — bypasses background/service-worker.
 * Used by AI Console tab for testing prompts. Reads API key + model from
 * chrome.storage.local (same settings as the rest of the extension).
 */
async function callLLMForTest(
  prompt: string,
  onLine: (msg: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const s = await getSettings();
  const provider = s.llmProvider || 'deepseek';
  const model = s.llmModel || 'deepseek-chat';
  const apiKey = s.apiKey;
  if (!apiKey) throw new Error('API Key 未配置，请在设置中填写');

  const configs: Record<string, { baseUrl: string }> = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
  };
  const cfg = configs[provider];
  if (!cfg) throw new Error('不支持的供应商: ' + provider);

  const t0 = Date.now();
  onLine(`[${formatTime(t0)}] → 发送请求 (${provider}/${model})`);

  const resp = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('API ' + resp.status + (errText ? ': ' + errText.slice(0, 120) : ''));
  }

  const t1 = Date.now();
  onLine(`[${formatTime(t1)}] ⚡ 收到首字节 (${t1 - t0}ms)`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let reasoning = '';
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
            onLine('[思考] ' + delta.reasoning_content);
          }
          if (delta?.content) {
            content += delta.content;
            onLine(delta.content);
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const t2 = Date.now();
  onLine('');
  onLine(`[${formatTime(t2)}] ✅ 完成`);
  onLine(`总耗时: ${t2 - t0}ms | 首字节: ${t1 - t0}ms | 流式: ${t2 - t1}ms`);
  if (reasoning) onLine(`思考内容: ${reasoning.length} 字符`);
  onLine(`回答内容: ${content.length} 字符`);
}

const CONSOLE_CSS = `
.ep-dev-tab { transition: color 0.15s; }
.ep-dev-tab:hover { color: #4A90D9; }
`;

export function createDevPanel(): DevPanel {
  let container: HTMLDivElement | null = null;
  let logEl: HTMLDivElement | null = null;
  let consoleOutput: HTMLDivElement | null = null;
  let unsub: (() => void) | null = null;
  let consoleRunning = false;

  function renderAll(): void {
    if (!logEl) return;
    const logs = getLogs();

    if (logs.length === 0) {
      logEl.innerHTML =
        '<div style="text-align:center;color:#94a3b8;padding:40px 0;font-size:12px;">' +
          '<div style="font-size:24px;margin-bottom:8px;">📋</div>' +
          '<div>等待分析开始…</div>' +
          '<div style="font-size:10px;margin-top:4px;">点击采购页面的「开始分析」后在此查看执行步骤</div>' +
        '</div>';
      return;
    }

    let html = '';
    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      const icon = STEP_ICONS[entry.step] || '⏺';
      const isError = entry.step === 'error';
      const isDone = entry.step === 'done';
      const isFirstByte = entry.step === 'llm_first_byte';
      const isPrompt = entry.step === 'prompt';

      html +=
        '<div style="display:flex;gap:10px;padding:6px 0;' +
        (i < logs.length - 1 ? 'border-left:2px solid #e2e8f0;margin-left:7px;padding-left:16px;' : 'padding-left:0;') +
        '">' +
          '<span style="flex-shrink:0;font-size:13px;line-height:1.4;">' + icon + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<span style="font-size:12px;color:' + (isError ? '#ef4444' : isDone ? '#10b981' : '#334155') + ';' +
            (isFirstByte || isDone ? 'font-weight:600;' : '') +
            (isPrompt ? 'white-space:pre-wrap;font-family:monospace;font-size:10px;' : '') +
            'line-height:1.5;word-break:break-all;">' +
              escape(entry.message) +
            '</span>' +
            '<div style="font-size:9px;color:#94a3b8;margin-top:1px;">' + formatTime(entry.ts) + '</div>' +
          '</div>' +
        '</div>';
    }

    logEl.innerHTML = html;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function mount(parent: HTMLElement): void {
    if (container) return;

    // Inject tab CSS once
    if (!document.getElementById('ep-dev-css')) {
      const style = document.createElement('style');
      style.id = 'ep-dev-css';
      style.textContent = CONSOLE_CSS;
      document.head.appendChild(style);
    }

    container = document.createElement('div');
    container.style.cssText = 'font-size:11px;';

    container.innerHTML =
      '<div style="display:flex;gap:0;border-bottom:1px solid #e2e8f0;margin-bottom:8px;">' +
        '<div id="ep-tab-log" class="ep-dev-tab" style="padding:6px 12px;font-size:11px;font-weight:600;color:#4A90D9;cursor:pointer;border-bottom:2px solid #4A90D9;">📋 分析日志</div>' +
        '<div id="ep-tab-console" class="ep-dev-tab" style="padding:6px 12px;font-size:11px;color:#999;cursor:pointer;">💻 AI 控制台</div>' +
      '</div>' +

      // Log tab content
      '<div id="ep-content-log">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
          '<span style="font-weight:600;font-size:12px;color:#1e293b;">🤖 AI 分析日志</span>' +
          '<button id="ep-clear-log" style="font-size:10px;padding:2px 8px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;color:#64748b;">清空</button>' +
        '</div>' +
        '<div id="ep-log-output" style="max-height:300px;overflow-y:auto;padding-right:4px;"></div>' +
      '</div>' +

      // Console tab content
      '<div id="ep-content-console" style="display:none;">' +
        '<div id="ep-console-output" style="background:#1a1a2e;color:#0f0;font-family:Consolas,\'Courier New\',monospace;font-size:11px;padding:10px;border-radius:6px;min-height:180px;max-height:280px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5;">' +
          '输入测试 prompt 并点击发送，查看 LLM 流式输出过程…\n' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
          '<input id="ep-console-input" type="text" placeholder="输入测试 prompt…" style="flex:1;padding:5px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;">' +
          '<button id="ep-console-send" style="padding:5px 14px;background:#4A90D9;color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer;">发送</button>' +
        '</div>' +
        '<div style="font-size:9px;color:#94a3b8;margin-top:4px;">使用当前 LLM 设置直连 API，不走 Background</div>' +
      '</div>';

    parent.appendChild(container);
    logEl = container.querySelector('#ep-log-output') as HTMLDivElement;
    consoleOutput = container.querySelector('#ep-console-output') as HTMLDivElement;

    // --- Tab switching ---
    const tabLog = container.querySelector('#ep-tab-log') as HTMLDivElement;
    const tabConsole = container.querySelector('#ep-tab-console') as HTMLDivElement;
    const contentLog = container.querySelector('#ep-content-log') as HTMLDivElement;
    const contentConsole = container.querySelector('#ep-content-console') as HTMLDivElement;

    function switchTab(tab: 'log' | 'console'): void {
      if (tab === 'log') {
        tabLog.style.color = '#4A90D9'; tabLog.style.borderBottom = '2px solid #4A90D9';
        tabConsole.style.color = '#999'; tabConsole.style.borderBottom = 'none';
        contentLog.style.display = ''; contentConsole.style.display = 'none';
      } else {
        tabConsole.style.color = '#4A90D9'; tabConsole.style.borderBottom = '2px solid #4A90D9';
        tabLog.style.color = '#999'; tabLog.style.borderBottom = 'none';
        contentLog.style.display = 'none'; contentConsole.style.display = '';
      }
    }

    tabLog.addEventListener('click', () => switchTab('log'));
    tabConsole.addEventListener('click', () => switchTab('console'));

    // --- Clear log ---
    container.querySelector('#ep-clear-log')?.addEventListener('click', () => {
      clearLogs();
      renderAll();
    });

    // --- AI Console: send ---
    const consoleInput = container.querySelector('#ep-console-input') as HTMLInputElement;
    const consoleSend = container.querySelector('#ep-console-send') as HTMLButtonElement;

    async function sendPrompt(): Promise<void> {
      const prompt = consoleInput.value.trim();
      if (!prompt || consoleRunning) return;

      consoleRunning = true;
      consoleSend.disabled = true;
      consoleSend.textContent = '发送中…';
      if (consoleOutput) consoleOutput.textContent = '';

      const abortCtrl = new AbortController();
      const logLine = (msg: string) => {
        if (consoleOutput) consoleOutput.textContent += msg + '\n';
      };

      try {
        await callLLMForTest(prompt, logLine, abortCtrl.signal);
      } catch (e: any) {
        if (e.name === 'AbortError') {
          logLine('[超时] 请求已取消');
        } else {
          logLine('❌ 错误: ' + (e.message || '未知错误'));
        }
      }

      consoleRunning = false;
      consoleSend.disabled = false;
      consoleSend.textContent = '发送';
    }

    consoleSend.addEventListener('click', sendPrompt);
    consoleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendPrompt();
    });

    // --- Subscribe to live analysis logs ---
    unsub = onLog(() => renderAll());
    renderAll();
  }

  function unmount(): void {
    unsub?.();
    unsub = null;
    container?.remove();
    container = null;
    logEl = null;
    consoleOutput = null;
  }

  return { mount, unmount };
}
