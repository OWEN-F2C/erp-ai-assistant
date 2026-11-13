// shared/types.ts

// --- Platform ---
export type ErpPlatform = 'jijia';

// --- Settings ---
export type LlmProvider = 'deepseek';

export interface LlmModelOption {
  value: string;
  label: string;
}

export const LLM_MODEL_OPTIONS: Record<LlmProvider, LlmModelOption[]> = {
  deepseek: [
    { value: 'deepseek-chat', label: 'DeepSeek Chat' },
    { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  ],
};

// --- Market Aggregation Groups ---
export interface MarketGroup {
  name: string;     // user-facing group name, e.g. "欧洲站"
  markets: string[]; // uppercase marketplace codes, e.g. ["DE","FR","IT","ES"]
  /** 内置组标记（如 EU_FBA 仓库解析出的欧洲组）：UI 提示用户、缺站点不告警 */
  builtin?: boolean;
}

export interface Settings {
  llmProvider: LlmProvider | '';
  llmModel: string;
  apiKey: string;
  autoGenerate: boolean;
  purchaseModule: boolean;
  transferModule: boolean;
  /** 即时看板（stats）页的全渠道净利润汇总面板开关 */
  profitModule: boolean;
  devMode: boolean;
  marketGroups: MarketGroup[];
  profitStartMonth: string; // "YYYY-MM", default computed at runtime
  thinkingEnabled: boolean;
  reasoningEffort: 'low' | 'high' | 'max';
  /** 插件面板整体缩放（zoom，0.7–1.5，默认 1）——字体+间距等比，见 shared/ui-scale.ts */
  uiScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: '',
  llmModel: '',
  apiKey: '',
  autoGenerate: false,
  purchaseModule: true,
  transferModule: true,
  profitModule: true,
  devMode: false,
  marketGroups: [],
  profitStartMonth: '', // filled by defaultProfitStartMonth() at runtime
  thinkingEnabled: true,
  reasoningEffort: 'high',
  uiScale: 1,
};

/** Returns "YYYY-MM" for 5 months before current month (local time).
 *  Example: if today is 2026-08-04, returns "2026-03"
 *  This yields a 6-month query window when endMonth = currentMonth. */
export function defaultProfitStartMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// --- Messaging ---
export interface ModuleMessage {
  type: 'module:invoke';
  moduleId: string;
  requestId: string;
  payload: unknown;
}

export type StreamEvent =
  | { type: 'chunk'; chunkType: 'reasoning' | 'content'; data: string }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string }
  | { type: 'log'; step: string; message: string };

export interface StreamChunkMessage {
  type: 'stream:chunk';
  requestId: string;
  chunkType: 'reasoning' | 'content';
  chunk: string;
}

export interface StreamDoneMessage {
  type: 'stream:done';
  requestId: string;
  result: unknown;
}

export interface StreamErrorMessage {
  type: 'stream:error';
  requestId: string;
  message: string;
}

export interface StreamLogMessage {
  type: 'stream:log';
  requestId: string;
  step: string;
  message: string;
}

export type BackgroundMessage =
  | StreamChunkMessage
  | StreamDoneMessage
  | StreamErrorMessage
  | StreamLogMessage;

// --- Module Interface ---
export interface ModuleContext {
  settings: Settings;
  dispatchMessage: (msg: ModuleMessage) => void;
  onStreamChunk: (cb: (chunkType: 'reasoning' | 'content', chunk: string) => void) => () => void;
  onStreamDone: (cb: (result: unknown) => void) => () => void;
  onStreamError: (cb: (msg: string) => void) => () => void;
}

export interface EnhancerModule {
  id: string;
  name: string;
  description: string;
  matches: string[];
  ui: {
    render: (container: HTMLElement, ctx: ModuleContext) => void;
  };
  handler: (
    payload: unknown,
    signal: AbortSignal,
  ) => AsyncGenerator<StreamEvent>;
}

// --- Data ---
export interface ApiSalesData {
  sku: string;
  avgSales7d: number;
  avgSales14d: number;
  avgSales30d: number;
  trend7d: number;
  trend14d: number;
  trend30d: number;
  currentStock: number;
  inboundStock: number;
  reservedStock: number;
}

export interface SkuRowData {
  sku: string;
  currentStock: number;
  inTransitStock: number;
  sales: ApiSalesData | null;
}

export interface LlmSuggestion {
  scope: string;  // "global" | "DE:Yaoshu" | ...  新增
  sku: string;
  suggestion: string;
  riskLevel: 'red' | 'yellow' | 'green';
  suggestedQty?: number;
  predictedDailySales?: number;
  restockDate?: string;
  weeklyForecast?: number[];
}

export interface ModulePayload {
  pageUrl: string;
  rows: SkuRowData[];
}

export interface ModuleCancelMessage {
  type: 'module:cancel';
  moduleId: string;
  requestId: string;
}
