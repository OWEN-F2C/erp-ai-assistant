// shared/concurrency.ts
/** 并发受限制的 map：按输入顺序返回结果，同一时刻最多 limit 个 fn 在跑。
 *  用于对 ERP 接口的批量请求——完全串行太慢，无上限并行又容易触发限流。 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
