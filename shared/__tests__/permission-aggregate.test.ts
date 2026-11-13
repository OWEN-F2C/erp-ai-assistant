import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAndSummarize } from '../jijia-data';
import { fetchAndSummarizeTransfer } from '../jijia-transfer-data';
import { ErpApiError } from '../erp-errors';

afterEach(() => vi.unstubAllGlobals());

/** 按 URL 片段返回状态：403/401 用空 body，正常返回 code:0 的成功结构 */
function stubByStatus(map: Record<string, number>): void {
  sessionStorage.setItem('x-auth-token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [frag, status] of Object.entries(map)) {
      if (url.includes(frag)) {
        return new Response(status === 200 ? JSON.stringify({ code: 0, data: WH_BY_FRAG[frag] }) : '{}', {
          status, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    throw new Error('unexpected url ' + url);
  }));
}

const WH_BY_FRAG: Record<string, unknown> = {
  warehouseSelection: [{ key: -1, title: '自营仓', children: [
    { key: -11, title: '国内-自营仓', children: [{ key: 101, title: '杭州仓', isLeaf: true }] },
  ] }],
};

describe('fetchAndSummarize（无权限聚合）', () => {
  // 注意顺序：本用例必须最先跑——成功获取过仓库树后会被模块级缓存，
  // 后续用例的 401 就发不出真实请求了
  it('任一 401 → 整体按登录失效提示', async () => {
    stubByStatus({
      warehouseSelection: 401,
      asinView: 403,
      pageQuery: 403,
    });
    await expect(fetchAndSummarize(['S1'], document)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('销售+库存都 403 → 一次性列出全部缺失数据集，提示找管理员', async () => {
    stubByStatus({
      warehouseSelection: 200,
      asinView: 403,
      pageQuery: 403,
    });
    const p = fetchAndSummarize(['S1'], document);
    await expect(p).rejects.toBeInstanceOf(ErpApiError);
    await p.catch((e: ErpApiError) => {
      expect(e.kind).toBe('permission');
      expect(e.datasets).toContain('销售分析数据');
      expect(e.datasets).toContain('库存数据');
      expect(e.message).toContain('管理员');
    });
  });

  it('非权限类失败（超时/500）也带数据集名', async () => {
    stubByStatus({
      warehouseSelection: 200,
      asinView: 500,
      pageQuery: 200,
    });
    // pageQuery 200 但无 rows 结构 → 成功空数组
    await expect(fetchAndSummarize(['S1'], document)).rejects.toMatchObject({
      kind: 'api',
      datasets: ['销售分析数据'],
    });
  });
});

describe('fetchAndSummarizeTransfer（无权限聚合）', () => {
  it('销售+库存都 403 → 完整清单', async () => {
    stubByStatus({
      warehouseSelection: 200,
      asinView: 403,
      pageQuery: 403,
    });
    await expect(fetchAndSummarizeTransfer(['B0AAAAAAAA1'], ['S1'], undefined, document, []))
      .rejects.toMatchObject({ kind: 'permission', datasets: ['销售分析数据', '库存数据'] });
  });
});
