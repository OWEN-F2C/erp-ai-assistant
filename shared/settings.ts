// shared/settings.ts
// 统一的 settings 读取入口：与 DEFAULT_SETTINGS 合并，老版本存量数据
// 缺新字段（thinkingEnabled/reasoningEffort/marketGroups 等）时按默认值兜底。
// 各处不得再直接 `chrome.storage.local.get('settings')` 后裸解构。

import { DEFAULT_SETTINGS, defaultProfitStartMonth } from './types';
import type { Settings } from './types';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings>) };
  if (!merged.profitStartMonth) merged.profitStartMonth = defaultProfitStartMonth();
  return merged;
}
