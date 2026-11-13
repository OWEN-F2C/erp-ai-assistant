import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPlatformMarkets, fetchMultiChannelSales, platformMarketWarehouses } from '../../shared/api-client';

afterEach(() => vi.unstubAllGlobals());

describe('fetchPlatformMarkets', () => {
  it('过滤 deleteMarket=1 并映射字段', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: '1000051', text: 'SUPRENT PRO ACCU:US', group: 'TIKTOK', groupAlias: 'Tiktok自运营', countryCode: 'US', deleteMarket: 0 },
        { id: '22', text: 'Eukey-JP-已删除:JP', group: 'AMAZON', groupAlias: 'Amazon', countryCode: 'JP', deleteMarket: 1 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const list = await fetchPlatformMarkets('tok');
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: '1000051', text: 'SUPRENT PRO ACCU:US', group: 'TIKTOK',
      groupAlias: 'Tiktok自运营', country: 'US', deleteMarket: 0,
    });
  });
});

describe('fetchMultiChannelSales', () => {
  it('发送 MONTH 聚合查询并解析行', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { rows: [{ sku: 'S1', marketId: 1000051, marketName: 'TK:US', platformCode: 'TIKTOK', unitsOrdered: 35, orders: 5 }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const rows = await fetchMultiChannelSales(['S1'], '2026-08-06', '2026-08-12', 'tok');
    expect(rows[0]).toEqual({ sku: 'S1', marketId: 1000051, marketName: 'TK:US', platformCode: 'TIKTOK', unitsOrdered: 35, orders: 5 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.keywordsSearch).toEqual({ skuList: ['S1'] });
    expect(body.viewType).toBe('MONTH');
    expect(body.pagesize).toBe(500);
  });
});

describe('platformMarketWarehouses', () => {
  it('TikTok DE → CN_A_Tiktok + DE-Tiktok-FBT虚拟仓', () => {
    expect(platformMarketWarehouses({ group: 'TIKTOK', country: 'DE' }))
      .toEqual({ domesticWh: 'CN_A_Tiktok', overseasWh: 'DE-Tiktok-FBT虚拟仓' });
  });
  it('TikTok US → CN_A_Tiktok + US-Tiktok-FBT虚拟仓', () => {
    expect(platformMarketWarehouses({ group: 'TIKTOK', country: 'US' }))
      .toEqual({ domesticWh: 'CN_A_Tiktok', overseasWh: 'US-Tiktok-FBT虚拟仓' });
  });
  it('TikTok 未支持国家（GB/FR 等）→ null，不错配到 US FBT 虚拟仓', () => {
    expect(platformMarketWarehouses({ group: 'TIKTOK', country: 'GB' })).toBeNull();
    expect(platformMarketWarehouses({ group: 'TIKTOK', country: 'FR' })).toBeNull();
    expect(platformMarketWarehouses({ group: 'TIKTOK', country: '' })).toBeNull();
  });
  it('Temu/Walmart/独立站只有国内仓；未知平台返回 null', () => {
    expect(platformMarketWarehouses({ group: 'TEMU_POP_MANAGED', country: '' }))
      .toEqual({ domesticWh: 'CN_A_TEMU' });
    expect(platformMarketWarehouses({ group: 'WALMART', country: '' }))
      .toEqual({ domesticWh: 'CN_C_WMSP' });
    expect(platformMarketWarehouses({ group: 'SHOPIFY', country: '' }))
      .toEqual({ domesticWh: 'CN-独立站' });
    expect(platformMarketWarehouses({ group: 'SHEIN', country: '' })).toBeNull();
  });
});
