// modules/purchase-plan-generator/history.ts
// 生成器历史记录的持久化。从 ui.ts 抽出以便测试；含配额保护：
// chrome.storage.local 有 10MB（未申请 unlimitedStorage 时 5MB）配额，
// 每条历史存完整 allResults + resultsHTML，超配额时逐次丢最旧的一半重试，
// 保证"能存多少存多少"而不是整体保存失败。

import type { GenResult } from './ui';

export const HISTORY_KEY = 'purchasePlanHistory';
export const MAX_HISTORY = 10;

export interface HistoryEntry {
  id: number;
  label: string;
  mode: string;
  warehouseId: string;
  warehouseLabel: string;
  productionDays: number;
  shippingDays: number;
  sellUntilDate: string;
  bufferDays: number;
  selectedSites: string[];
  selectedSkus: { sku: string; productName: string; asin: string }[];
  resultsHTML: string;
  allResults: GenResult[];
  createdAt: number;
}

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'createdAt' | 'label'>;

export async function loadHistory(): Promise<HistoryEntry[]> {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return (data[HISTORY_KEY] as HistoryEntry[]) || [];
}

/** 保存一条记录并返回最终成功写入的列表（可能因配额被裁剪） */
export async function saveHistory(entry: NewHistoryEntry): Promise<HistoryEntry[]> {
  const history = await loadHistory();
  const now = Date.now();
  const firstSku = entry.selectedSkus[0];
  const d = new Date(now);
  const timeStr = String(d.getMonth() + 1).padStart(2, '0') + '/' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
  const label = (firstSku ? firstSku.sku : '未知') + ' · ' + timeStr;

  let list: HistoryEntry[] = [{ ...entry, id: now, label, createdAt: now }, ...history];
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;

  // 配额保护：超限时丢最旧的一半重试（对数轮次内收敛），单条仍放不下则抛出
  while (true) {
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: list });
      return list;
    } catch (e) {
      const quota = /quota/i.test(String((e as Error)?.message || ''));
      if (!quota || list.length <= 1) throw e;
      list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
    }
  }
}

export async function deleteHistory(id: number): Promise<HistoryEntry[]> {
  const list = (await loadHistory()).filter(h => h.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
  return list;
}
