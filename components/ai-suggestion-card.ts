// components/ai-suggestion-card.ts

interface AiSuggestionCard {
  mount: (parent: HTMLElement) => void;
  setLoading: (v: boolean) => void;
  appendText: (text: string) => void;
  setResult: (text: string, riskLevel: 'red' | 'yellow' | 'green') => void;
  setError: (msg: string) => void;
  onRetry: (cb: () => void) => void;
}

export function createAiSuggestionCard(): AiSuggestionCard {
  let container: HTMLDivElement | null = null;
  let btn: HTMLButtonElement | null = null;
  let content: HTMLDivElement | null = null;
  let retryCb: (() => void) | null = null;

  const RISK_COLORS: Record<string, string> = {
    red: '#fff0f0',
    yellow: '#fffbf0',
    green: '#f0fff0',
  };

  function mount(parent: HTMLElement): void {
    container = document.createElement('div');
    container.style.cssText = 'font-size:11px;';

    // Default: show "get suggestion" button
    btn = document.createElement('button');
    btn.textContent = '获取建议';
    btn.style.cssText = `
      padding: 2px 8px;
      font-size: 10px;
      background: #4A90D9;
      color: #fff;
      border: none;
      border-radius: 3px;
      cursor: pointer;
    `;
    btn.addEventListener('click', () => {
      btn!.style.display = 'none';
      content = document.createElement('div');
      content.style.cssText = 'padding:2px 0;color:#999;';
      content.textContent = '生成中...';
      container!.appendChild(content);
      retryCb?.();
    });

    container.appendChild(btn);
    parent.appendChild(container);
  }

  function setLoading(v: boolean): void {
    if (content && v) content.textContent = '生成中...';
  }

  function appendText(text: string): void {
    if (content) {
      if (content.textContent === '生成中...') content.textContent = '';
      content.textContent += text;
    }
  }

  function setResult(text: string, riskLevel: 'red' | 'yellow' | 'green'): void {
    if (content) {
      content.textContent = text;
      content.style.color = riskLevel === 'red' ? '#c00' : riskLevel === 'yellow' ? '#b80' : '#390';
      content.style.background = RISK_COLORS[riskLevel] || '';
      content.style.borderRadius = '3px';
      content.style.padding = '3px 6px';
    }
  }

  function setError(msg: string): void {
    if (content) {
      content.textContent = msg;
      content.style.color = '#999';
    }
    if (btn) {
      btn.textContent = '重试';
      btn.style.display = '';
    }
  }

  function onRetry(cb: () => void): void {
    retryCb = cb;
  }

  return { mount, setLoading, appendText, setResult, setError, onRetry };
}
