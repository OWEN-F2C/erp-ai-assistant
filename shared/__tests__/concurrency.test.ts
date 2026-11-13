import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapWithLimit } from '../concurrency';

afterEach(() => vi.unstubAllGlobals());

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('mapWithLimit（并发受限制的 map）', () => {
  it('保持输入顺序返回结果（完成顺序随机）', async () => {
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await sleep(n % 2 === 0 ? 5 : 20); // 偶数先完成，奇数后完成
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('同一时刻最多 limit 个任务在跑', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithLimit(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight--;
      return n;
    });
    expect(out).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // 确实并行了
  });

  it('空数组 → 空结果', async () => {
    expect(await mapWithLimit([], 4, async (n) => n)).toEqual([]);
  });

  it('limit ≤ 0 按 1 处理；limit 超过元素数也正常', async () => {
    expect(await mapWithLimit([1, 2], 0, async (n) => n)).toEqual([1, 2]);
    expect(await mapWithLimit([1, 2], 99, async (n) => n)).toEqual([1, 2]);
  });
});
