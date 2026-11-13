// shared/logistics-days.ts
// 解析调拨单"物流方式"选项文本里的时效（如 欧洲卡航递延（30-40天））。
// 区间取中值四舍五入；无时效信息返回 null（调用方不应改动头程输入）。
export function parseLogisticsDays(text: string): number | null {
  const m = text.match(/(\d+)(?:\s*[-~－—至]\s*(\d+))?\s*天/);
  if (!m) return null;
  const lo = parseInt(m[1]!, 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  return Math.round((lo + hi) / 2);
}
