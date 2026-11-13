import { describe, it, expect } from 'vitest';
import { pageRoute } from '../page-route';

describe('pageRoute', () => {
  it('采购计划列表页 → generator', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlan')).toBe('generator');
  });

  it('采购计划列表页带查询参数 → generator', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlan?page=1&size=20')).toBe('generator');
  });

  it('hash 路由的列表页 → generator', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/#/srm/purchase/purchasePlan')).toBe('generator');
  });

  it('添加采购计划页 → purchase（运营确认 2026-08-21：AI 采购分析面板固定且仅在此页）', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlanAddV3?addModel=purchase')).toBe('purchase');
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlanAddV3?addModel=purchase&timestamp=1787307124830')).toBe('purchase');
  });

  it('采购计划详情页（purchasePlanInfo）→ none', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlanInfo?code=PL202608170001')).toBe('none');
  });

  it('其它 purchaseplan 子页（Detail、尾斜杠、list 等）→ none', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchasePlanDetail?id=1')).toBe('none');
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchaseplan/')).toBe('none');
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchaseplanlist')).toBe('none');
  });

  it('非 purchaseplan 的 /purchase 页面（如采购订单）→ none', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/purchaseOrder')).toBe('none');
  });

  it('splitTask 页 → none（无权限页面不注入任何面板）', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/splitTask')).toBe('none');
  });

  it('调拨单新增页 → transfer', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/wms/transferorderadd')).toBe('transfer');
  });

  it('财务统计页 → profit', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/stats/index')).toBe('profit');
  });

  it('jijia 域名的页面同样参与路由', () => {
    expect(pageRoute('https://www.jijia.com.cn/amzv-web/srm/purchase/purchasePlan')).toBe('generator');
    expect(pageRoute('https://www.jijia.com.cn/amzv-web/stats/index')).toBe('profit');
  });

  it('无关页面 → none', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/other/xyz')).toBe('none');
  });

  it('URL 大小写不敏感', () => {
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/SRM/PURCHASE/PurchasePlan')).toBe('generator');
    expect(pageRoute('https://bckj.app.gerpgo.com/amzv-web/srm/purchase/SplitTask')).toBe('none');
  });
});
