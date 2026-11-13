// shared/purchase-conclusion.ts
// 采购建议"结论块"——前端确定性渲染（2026-09-03 用户报两个问题：①LLM 输出结论
// 格式不稳定 ②风险灯与结论矛盾——旧实现灯用 FBA 基数+suggestedQty≤0 强制 green、
// 日期用 FBA 基数、结论块用总可用基数，三套口径同卡打架出"库存充足"+"尽快"）。
// 现在结论块是唯一事实源：灯/日期/数量/结论行同基数（totalAvailable）同口径，
// 灯走文档口径 riskLevelFromRemainingDays（红≤提前期 / 黄≤提前期+冗余），
// 数量走 computePurchaseQty；面板不再另行计算。
import { computePurchaseQty, riskLevelFromRemainingDays, type RiskLevel } from './qty-formula';

export interface ConclusionInput {
  /** LLM 结构化预测日均，缺失/非正时回退 fallbackDaily */
  predictedDailySales: number | null | undefined;
  fallbackDaily: number;
  /** = 国内 + FBA在库 + 海外（SkuSummary.totalAvailable，截图口径"国内+海外+已到货"） */
  totalAvailable: number;
  /** 未来口径在途（2026-09-08 管线）：max(货件在途, 已发货+待入库)+待出运 各桶求和 */
  totalInTransit: number;
  /** 全仓 Σ 调拨待出运（已出库未发运，货在中转）——已计入 totalInTransit，仅参考行 */
  transferWaitShippedTotal?: number;
  /** 国内不可借（勾选站点组的国内仓扣减，domestic-pool）。0/缺省 = 全部可借（现状）；
   *  >0 时基数切换为可借口径，量/灯/覆盖/日期同基联动（单源口径不变） */
  domesticNonLendable?: number;
  productionDays: number;
  shippingDays: number;
  bufferDays: number;
  /** YYYY-MM-DD；空 = 未设置（coverage 兜底 0） */
  sellUntilDate: string;
  boxQty: number;
  now?: number;
}

export interface ConclusionLine { label: string; value: string; }

export function buildPurchaseConclusion(input: ConclusionInput): {
  lines: ConclusionLine[];
  qty: number;
  daily: number;
  coverageDays: number;
  /** 文档口径风险灯（与可覆盖天数同基数） */
  riskLevel: RiskLevel;
  /** 建议采购日期（YYYY-MM-DD；''=已过下单死线尽快，面板头部"预计补货日"同源） */
  restockDate: string;
} {
  let daily = input.predictedDailySales ?? 0;
  if (!(daily > 0)) daily = input.fallbackDaily > 0 ? input.fallbackDaily : 0;

  // 覆盖天数口径同生成器：(卖到日期 − 今天) + 冗余天数
  let coverageDays = 0;
  if (input.sellUntilDate) {
    const until = new Date(input.sellUntilDate + 'T00:00:00').getTime();
    if (Number.isFinite(until)) {
      coverageDays = Math.floor((until - (input.now ?? Date.now())) / 86400000) + input.bufferDays;
    }
  }

  const leadDays = (input.productionDays || 0) + (input.shippingDays || 0);
  const box = input.boxQty > 0 ? input.boxQty : 1;
  // 国内不可借扣减（>0 时基数=可借口径；下限 0），量/灯/覆盖/日期全部走同一基数
  const nonLendable = Math.max(0, input.domesticNonLendable || 0);
  const effectiveAvailable = Math.max(0, input.totalAvailable - nonLendable);
  const qty = computePurchaseQty(daily, effectiveAvailable, input.totalInTransit, leadDays, coverageDays, box);

  // 风险与日期：剩余天数 = 总可用 ÷ 预测日均（与可覆盖天数同源）。
  // 无销量 → 无断货风险（green），日期无基准显示 —
  const remainingDays = daily > 0 ? effectiveAvailable / daily : Infinity;
  const riskLevel = daily > 0
    ? riskLevelFromRemainingDays(remainingDays, leadDays, input.bufferDays || 0)
    : 'green';
  const orderDayOffset = daily > 0 ? Math.round(remainingDays - (input.bufferDays || 0) - leadDays) : 0;
  let restockDate = '';
  if (daily > 0 && orderDayOffset > 0) {
    const d = new Date((input.now ?? Date.now()) + orderDayOffset * 86400000);
    restockDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 下单死线已过（offset ≤ 0）必为红/黄 → "尽快"语义自洽；绿灯 offset>0 必有日期
  const dateText = daily > 0 ? (restockDate || '尽快') : '—';

  const coverageText = daily > 0 ? Math.floor(effectiveAvailable / daily) + ' 天' : '—';
  const lines: ConclusionLine[] = [
    nonLendable > 0
      ? { label: '总可用库存(国内可借+海外+FBA)', value: effectiveAvailable + ' 件（国内不可借已扣 ' + nonLendable + '）' }
      : { label: '总可用库存(国内+海外+FBA)', value: input.totalAvailable + ' 件' },
    { label: '在途(全部,含已发货/待入库/待出运)', value: input.totalInTransit + ' 件' },
    { label: '待出运(中转,已计入在途)', value: (input.transferWaitShippedTotal || 0) + ' 件' },
    { label: '预测日均', value: daily + ' 件/天' },
    { label: '可覆盖天数', value: coverageText },
    { label: '补货提前期(生产+头程)', value: leadDays + ' 天' },
    { label: '建议采购日期', value: dateText },
    { label: '建议采购量', value: qty + ' 件' },
  ];

  return { lines, qty, daily, coverageDays, riskLevel, restockDate };
}
