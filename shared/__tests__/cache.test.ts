// shared/__tests__/cache.test.ts
import { describe, it, expect, vi } from 'vitest';
import { cache } from '../cache';

// Note: IndexedDB tests require jsdom + fake-indexeddb or happy-dom.
// Install fake-indexeddb for test environment:
// npm install -D fake-indexeddb

/** 直接读取底层 store 的记录数，验证过期条目被物理删除 */
function rawCount(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('erp-enhancer', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('erp-cache', 'readonly');
      const c = tx.objectStore('erp-cache').count();
      c.onsuccess = () => { db.close(); resolve(c.result); };
      c.onerror = () => { db.close(); reject(c.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

describe('cache', () => {
  it('returns null for unset key', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await cache.set('test-key', { foo: 'bar' }, 60_000);
    const result = await cache.get<{ foo: string }>('test-key');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('returns null for expired value', async () => {
    await cache.set('exp-key', 'value', -1); // expired immediately
    const result = await cache.get('exp-key');
    expect(result).toBeNull();
  });

  it('get 命中过期条目时顺手物理删除（不再无限累积）', async () => {
    await cache.set('phys-del-key', 'value', -1);
    await cache.get('phys-del-key');
    // 等删除事务落盘后统计
    await new Promise((r) => setTimeout(r, 20));
    const before = await rawCount();
    expect(before).toBeGreaterThanOrEqual(0); // sanity：能读到 store
    const result = await cache.get('phys-del-key');
    expect(result).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    // 再次写入过期条目并 get，对比删除前后计数
    const c1 = await rawCount();
    await cache.set('phys-del-key2', 'value', -1);
    expect(await rawCount()).toBe(c1 + 1);
    await cache.get('phys-del-key2');
    await new Promise((r) => setTimeout(r, 20));
    expect(await rawCount()).toBe(c1); // 过期条目被删掉
  });

  it('复用单例连接（indexedDB.open 只调用一次）', async () => {
    const openSpy = vi.spyOn(indexedDB, 'open');
    vi.resetModules();
    const { cache: freshCache } = await import('../cache');
    await freshCache.get('singleton-a');
    await freshCache.set('singleton-b', 1, 60_000);
    await freshCache.get('singleton-b');
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });
});
