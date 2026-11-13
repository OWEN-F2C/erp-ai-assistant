import { describe, it, expect, vi, afterEach } from 'vitest';
import { submitPurchasePlan } from '../../modules/purchase-plan-generator/submit-plan';

afterEach(() => vi.unstubAllGlobals());

const OK_SKUS = [{
  sku: 'S1', productName: 'P', planQty: 10, deliveryDate: '2026-09-01',
  productNote: '', boxQty: 5,
}];

describe('submitPurchasePlan（网络健壮性）', () => {
  it('HTTP 非 2xx → 抛出带状态码的错误（而非 JSON 解析错误）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Server Error</html>', {
      status: 500, headers: { 'Content-Type': 'text/html' },
    })));
    await expect(submitPurchasePlan({
      warehouseId: 1, scope: 'global', storeId: 0, remark: '',
      skus: OK_SKUS, authToken: 'tok',
    })).rejects.toThrow(/500/);
  });

  it('响应体不是 JSON → 抛出明确错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    })));
    await expect(submitPurchasePlan({
      warehouseId: 1, scope: 'global', storeId: 0, remark: '',
      skus: OK_SKUS, authToken: 'tok',
    })).rejects.toThrow();
  });

  it('正常流程：分组 + 创建 → 返回计划编号', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const path = String(_url);
      const body = JSON.parse(String(init.body));
      if (path.includes('createPlanItemGroup')) {
        return new Response(JSON.stringify({ error: false, data: [{ groupItems: body.items }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: false, code: 0, data: ['PL202608190001'] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));
    const ids = await submitPurchasePlan({
      warehouseId: 1, scope: 'global', storeId: 0, remark: '备注',
      skus: OK_SKUS, authToken: 'tok',
    });
    expect(ids).toEqual(['PL202608190001']);
  });

  it('fetch 带 30s 超时信号', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal;
      return new Response(JSON.stringify({ error: false, data: [{ groupItems: [] }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));
    await submitPurchasePlan({
      warehouseId: 1, scope: 'global', storeId: 0, remark: '',
      skus: OK_SKUS, authToken: 'tok',
    }).catch(() => { /* 错误路径不测 */ });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
