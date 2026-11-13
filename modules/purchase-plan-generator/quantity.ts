// Deterministic purchase quantity (spec 4.1).
// 公式本体已抽到 shared/qty-formula.ts（采购/调拨共用），此处保留原导出以维持既有引用。
export { computePurchaseQty } from '../../shared/qty-formula';

// Pad/truncate an AI weeklyForecast to expectedWeeks, filling missing weeks
// with fillPerWeek (spec 4.6 fallback).
export function padWeeklyForecast(
  wf: number[] | undefined,
  expectedWeeks: number,
  fillPerWeek: number,
): number[] {
  const n = Math.max(1, Math.floor(expectedWeeks));
  if (!wf || wf.length === 0) return Array(n).fill(fillPerWeek);
  if (wf.length < n) return wf.concat(Array(n - wf.length).fill(fillPerWeek));
  return wf.slice(0, n);
}
