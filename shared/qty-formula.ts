// shared/qty-formula.ts
// 补货量确定性公式（2026-08-13 设计附录 A）。采购与调拨共用同一形状：
//   R = max(0, S + I − d×L)   到货时剩余库存
//   D = d × max(0, C − L)     到货后需求
//   qty = max(0, ceil((D − R) / box) × box)
// 采购：S=可用 I=在途 L=生产+头程；调拨：S=FBA可用 I=FBA在途 L=头程。
// 当库存足以撑过提前期时，公式化简为 d×C − S − I（总需求减总库存），
// 旧实现（先从覆盖天数扣掉提前期再减库存）会恰好少买 d×L。

export function computeReplenishQty(
  dailySales: number,
  available: number,
  inTransit: number,
  leadDays: number,
  coverageDays: number,
  boxQty: number,
): number {
  const d = dailySales > 0 ? dailySales : 0;
  const S = available > 0 ? available : 0;
  const I = inTransit > 0 ? inTransit : 0;
  const L = leadDays;
  const C = coverageDays;
  const box = boxQty > 0 ? boxQty : 1;

  const remainingAtArrival = Math.max(0, S + I - d * L);
  const postArrivalDemand = d * Math.max(0, C - L);
  return Math.max(0, Math.ceil((postArrivalDemand - remainingAtArrival) / box) * box);
}

/** 采购建议量：L = 生产天数 + 头程天数 */
export function computePurchaseQty(
  dailySales: number,
  available: number,
  inTransit: number,
  leadDays: number,
  coverageDays: number,
  boxQty: number,
): number {
  return computeReplenishQty(dailySales, available, inTransit, leadDays, coverageDays, boxQty);
}

/** 调拨建议量：库存基数为 FBA 可用+在途，L = 头程天数（调拨无生产周期） */
export function computeTransferQty(
  dailySales: number,
  fbaAvailable: number,
  fbaInTransit: number,
  shippingDays: number,
  coverageDays: number,
  boxQty: number,
): number {
  return computeReplenishQty(dailySales, fbaAvailable, fbaInTransit, shippingDays, coverageDays, boxQty);
}

export type RiskLevel = 'red' | 'yellow' | 'green';

/** 风险等级（2026-08-07 设计）：red = 剩余库存天数 ≤ 提前期（下单死线已到，
 *  再晚到货前就会断货），yellow = ≤ 提前期 + 冗余，green = 更远。
 *  采购 leadDays = 生产 + 头程；调拨 leadDays = 头程。 */
export function riskLevelFromRemainingDays(
  remainingDays: number,
  leadDays: number,
  bufferDays: number,
): RiskLevel {
  if (remainingDays <= leadDays) return 'red';
  if (remainingDays <= leadDays + bufferDays) return 'yellow';
  return 'green';
}
