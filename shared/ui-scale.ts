// shared/ui-scale.ts
// 插件面板整体缩放（zoom）：面板样式全是内联 px，仅调根节点 font-size 会被内联
// 值覆盖，zoom 等比缩放字体+间距（相当于面板专用的 Ctrl+加减）。范围 70%–150%，
// 步进 10%（2026-08-28 用户确认方案）。作用：设置弹窗 + 四个数据面板；悬浮球不缩放。

export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
const STEP = 0.1;
const DEFAULT = 1;

/** A± 步进（dir=+1 放大 / -1 缩小），夹紧边界；浮点结果保留两位小数 */
export function stepUiScale(current: number, dir: 1 | -1): number {
  const base = normalizeUiScale(current);
  return clamp(Math.round((base + dir * STEP) * 100) / 100);
}

/** 存储值兜底：NaN/undefined/非正数 → 默认 1；越界夹紧到 [0.7, 1.5] */
export function normalizeUiScale(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT;
  return clamp(v);
}

function clamp(v: number): number {
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v));
}
