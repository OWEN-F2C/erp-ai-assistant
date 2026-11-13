import { describe, it, expect, vi, beforeEach } from 'vitest';

// 每个用例用全新模块实例（auth 的 token 是模块级缓存）
beforeEach(() => vi.resetModules());

async function freshModules() {
  const { readErpJson } = await import('../erp-errors');
  const { getAuthToken } = await import('../auth');
  return { readErpJson, getAuthToken };
}

describe('token 生命周期（401 清缓存）', () => {
  it('readErpJson 遇 401 后清除 token 缓存——重新登录同页面即可用新 token', async () => {
    sessionStorage.setItem('x-auth-token', 'old-token');
    const { readErpJson, getAuthToken } = await freshModules();

    expect(getAuthToken(document)).toBe('old-token'); // 缓存已填充

    const resp = new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    await expect(readErpJson(resp, '库存数据')).rejects.toMatchObject({ kind: 'auth' });

    // 模拟用户重新登录：sessionStorage 换新值后，无需刷新页面也能取到
    sessionStorage.setItem('x-auth-token', 'new-token');
    expect(getAuthToken(document)).toBe('new-token');
  });

  it('非 401 失败不清缓存', async () => {
    sessionStorage.setItem('x-auth-token', 'old-token');
    const { readErpJson, getAuthToken } = await freshModules();
    getAuthToken(document); // prime

    const resp = new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
    await expect(readErpJson(resp, '库存数据')).rejects.toMatchObject({ kind: 'permission' });

    sessionStorage.setItem('x-auth-token', 'new-token');
    expect(getAuthToken(document)).toBe('old-token'); // 缓存未被清除
  });
});
