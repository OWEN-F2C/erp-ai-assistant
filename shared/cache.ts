// shared/cache.ts
//
// IndexedDB-backed cache layer for ERP enhancer extension.
// Provides get/set/invalidate with TTL support.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const STORE_NAME = 'erp-cache';

// 单例连接：IndexedDB 打开有升级/握手开销，且从不 close 的多连接会泄漏
let dbPromise: Promise<IDBDatabase> | null = null;

function openStore(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('erp-enhancer', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null; // 失败不缓存，下次可重试
        reject(req.error);
      };
    });
    // 连接建立时清扫一次过期条目，避免只增不减
    dbPromise.then((db) => sweepExpired(db)).catch(() => { /* 清扫失败不影响功能 */ });
  }
  return dbPromise;
}

/** 删除 store 中所有已过期条目 */
function sweepExpired(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const entry = cursor.value as { expiresAt?: number };
      if (typeof entry?.expiresAt === 'number' && Date.now() > entry.expiresAt) {
        cursor.delete();
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const db = await openStore();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry<T> | undefined;
        if (!entry) return resolve(null);
        if (Date.now() > entry.expiresAt) {
          // 顺手物理删除，防止过期条目无限累积
          const dtx = db.transaction(STORE_NAME, 'readwrite');
          dtx.objectStore(STORE_NAME).delete(key);
          return resolve(null);
        }
        resolve(entry.value);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const db = await openStore();
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async invalidate(pattern: string): Promise<void> {
    const db = await openStore();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (const key of keys) {
      if (typeof key === 'string' && key.includes(pattern)) {
        tx.objectStore(STORE_NAME).delete(key);
      }
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
