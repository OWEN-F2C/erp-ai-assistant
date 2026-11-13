import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

interface Rec { id: number; label?: string; [k: string]: unknown }

/** chrome.storage mock：get 返回 existing；set 在 failWhile(list) 为真时抛配额错误 */
function stubStorage(existing: Rec[], failWhile: (list: Rec[]) => boolean) {
  const store = { purchasePlanHistory: existing };
  const setSizes: number[] = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key as keyof typeof store] })),
        set: vi.fn(async (obj: { purchasePlanHistory: Rec[] }) => {
          const list = obj.purchasePlanHistory;
          setSizes.push(list.length);
          if (failWhile(list)) throw new Error('QUOTA_BYTES quota exceeded');
          store.purchasePlanHistory = list;
        }),
      },
    },
  });
  return { setSizes, store };
}

describe('history 持久化（配额保护）', () => {
  it('正常保存：unshift 新记录并截断到上限', async () => {
    const existing: Rec[] = Array.from({ length: 9 }, (_, i) => ({ id: i }));
    const { store } = stubStorage(existing, () => false);
    const { saveHistory } = await import('../../modules/purchase-plan-generator/history');
    const list = await saveHistory({ selectedSkus: [], resultsHTML: '', allResults: [] } as never);
    expect(list).toHaveLength(10);
    expect(list[0]!.id).toBe(list[0]!.createdAt);
    expect(store.purchasePlanHistory).toHaveLength(10);
  });

  it('配额报错 → 丢最旧的一半重试直到放得下，返回最终成功列表', async () => {
    const existing: Rec[] = Array.from({ length: 9 }, (_, i) => ({ id: i }));
    // 超过 3 条就放不下：10 → 砍到 5 → 仍放不下 → 砍到 2 → 成功
    const { setSizes, store } = stubStorage(existing, list => list.length > 3);
    const { saveHistory } = await import('../../modules/purchase-plan-generator/history');
    const list = await saveHistory({ selectedSkus: [], resultsHTML: '', allResults: [] } as never);
    expect(setSizes).toEqual([10, 5, 2]);
    expect(list).toHaveLength(2);
    expect(list[0]!.label).toBeDefined(); // 最新记录在最前
    expect(store.purchasePlanHistory).toHaveLength(2);
  });

  it('单条也放不下 → 重新抛出错误（调用方可提示用户）', async () => {
    stubStorage([], () => true);
    const { saveHistory } = await import('../../modules/purchase-plan-generator/history');
    await expect(saveHistory({ selectedSkus: [], resultsHTML: '', allResults: [] } as never))
      .rejects.toThrow(/QUOTA/i);
  });

  it('deleteHistory 过滤指定 id 并持久化', async () => {
    const existing: Rec[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { store } = stubStorage(existing, () => false);
    const { deleteHistory } = await import('../../modules/purchase-plan-generator/history');
    const list = await deleteHistory(2);
    expect(list.map(x => x.id)).toEqual([1, 3]);
    expect(store.purchasePlanHistory).toHaveLength(2);
  });
});
