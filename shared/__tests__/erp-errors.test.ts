import { describe, it, expect } from 'vitest';
import { readErpJson, ErpApiError, erpErrorNoticeHtml, dataWarningHtml } from '../erp-errors';

function resp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

describe('readErpJson（失败分类启发式）', () => {
  it('HTTP 403 → 无权限', async () => {
    await expect(readErpJson(resp(403, {}), '库存数据'))
      .rejects.toMatchObject({ kind: 'permission', datasets: ['库存数据'] });
  });

  it('HTTP 401 → 登录失效', async () => {
    await expect(readErpJson(resp(401, {}), '库存数据'))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('HTTP 200 + error:true + 消息含权限关键词 → 无权限', async () => {
    await expect(readErpJson(resp(200, { error: true, code: 500, messages: ['您无权限访问该报表'] }), '利润数据'))
      .rejects.toMatchObject({ kind: 'permission', datasets: ['利润数据'] });
  });

  it('HTTP 200 + 登录失效文案 → auth（真实样本：{msg:"登录已过期，请重新登录",code:401}）', async () => {
    await expect(readErpJson(resp(200, { msg: '登录已过期，请重新登录', code: 401 }), '库存数据'))
      .rejects.toMatchObject({ kind: 'auth', datasets: ['库存数据'] });
  });

  it('HTTP 200 + code 非 0 但消息无权限词 → 普通失败，透出接口消息', async () => {
    await expect(readErpJson(resp(200, { error: true, code: 500, messages: ['参数错误'] }), '库存数据'))
      .rejects.toMatchObject({ kind: 'api', message: expect.stringContaining('参数错误') });
  });

  it('正常响应（code:0 或无 error 字段）→ 原样返回 JSON，不抛错', async () => {
    await expect(readErpJson(resp(200, { code: 0, data: { rows: [1] } }), 'x'))
      .resolves.toEqual({ code: 0, data: { rows: [1] } });
    await expect(readErpJson(resp(200, { data: [1, 2] }), 'x'))
      .resolves.toEqual({ data: [1, 2] });
  });

  it('其它非 2xx → 普通失败带状态码', async () => {
    await expect(readErpJson(resp(500, 'boom'), '库存数据'))
      .rejects.toMatchObject({ kind: 'api', message: expect.stringContaining('500') });
  });
});

describe('ErpApiError.aggregate', () => {
  it('聚合多个失败：数据集去重、auth 优先于 permission、permission 优先于 api', () => {
    const agg = ErpApiError.aggregate([
      new ErpApiError('permission', ['销售分析数据'], 'API 403'),
      new ErpApiError('permission', ['库存数据'], 'API 403'),
      new ErpApiError('permission', ['销售分析数据'], 'API 403'), // 5 个窗口重复
      new ErpApiError('api', ['多渠道销售数据'], '超时'),
    ]);
    expect(agg.kind).toBe('permission');
    expect(agg.datasets).toEqual(['销售分析数据', '库存数据', '多渠道销售数据']);
    expect(agg.message).toContain('销售分析数据');
    expect(agg.message).toContain('库存数据');
    expect(agg.message).toContain('管理员');
  });

  it('任一 auth → 整体按登录失效提示', () => {
    const agg = ErpApiError.aggregate([
      new ErpApiError('auth', ['销售分析数据'], '401'),
      new ErpApiError('permission', ['库存数据'], '403'),
    ]);
    expect(agg.kind).toBe('auth');
    expect(agg.message).toContain('刷新页面');
  });
});

describe('警告框 HTML', () => {
  it('erpErrorNoticeHtml：无权限 → 列出数据集 + 找管理员提示', () => {
    const html = erpErrorNoticeHtml(new ErpApiError('permission', ['库存数据', '销售分析数据'], 'x'));
    expect(html).toContain('库存数据');
    expect(html).toContain('销售分析数据');
    expect(html).toContain('管理员');
    expect(html).not.toContain('<script'); // 纯文本拼接经转义
  });

  it('erpErrorNoticeHtml：登录失效 → 刷新提示', () => {
    const html = erpErrorNoticeHtml(new ErpApiError('auth', ['库存数据'], 'x'));
    expect(html).toContain('刷新页面');
  });

  it('dataWarningHtml：降级警告点名数据与后果', () => {
    const html = dataWarningHtml('多渠道销售数据获取失败', '已回退亚马逊口径，TikTok 等非亚马逊平台销量未计入');
    expect(html).toContain('多渠道销售数据获取失败');
    expect(html).toContain('TikTok');
  });
});
