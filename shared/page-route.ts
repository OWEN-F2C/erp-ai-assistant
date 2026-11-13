// 积加 iframe URL → 应注入的模块。纯函数，单测覆盖防路由回归。
export type PageRoute = 'generator' | 'purchase' | 'transfer' | 'profit' | 'none';

export function pageRoute(href: string): PageRoute {
  const h = href.toLowerCase();
  // 采购计划列表页：/purchasePlan 结尾、带 ?/#。生成器只在列表页。
  if (/\/purchaseplan(\?|#|$)/.test(h) && !/\/purchaseplan[a-z\/]/.test(h)) return 'generator';
  // 旧 AI 采购分析面板：仅【添加采购计划页】（运营确认 2026-08-21——面板固定且仅
  // 出现在添加页；详情页 purchasePlanInfo、采购订单等其它 /purchase 页面一律不注入）。
  if (h.includes('/purchaseplanadd')) return 'purchase';
  if (h.includes('/wms/transferorderadd')) return 'transfer';
  if (h.includes('/stats/index')) return 'profit';
  return 'none';
}
