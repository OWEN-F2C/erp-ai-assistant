// modules/purchase-plan-generator/visualization.ts
// Canvas inventory projection curve: 不采购 (dashed) vs AI建议采购 (solid).

export interface CurveInput {
  sku: string;
  label: string;
  currentStock: number;
  inTransit: number;
  weeklyForecast: number[];
  suggestedQty: number;
  /** 预计采购日期 (purchase date) */
  restockDate: string;
  /** 补货到仓日期 = 采购日期 + 生产 + 头程 */
  arrivalDate?: string;
  /** Per-week sales for weeks beyond the AI forecast window (default 0).
   *  Sales continue past the sell-until horizon, so the extension weeks
   *  should decline at the predicted rate instead of staying flat. */
  tailFillPerWeek?: number;
}

export interface CurveData {
  weeks: string[];
  noPurchase: number[];
  withPurchase: number[];
  stockoutWeek: number; // -1 if no stockout within forecast
  restockWeek: number;  // -1 if purchase date not in forecast window
  arrivalWeek: number;  // -1 if arrival date not in forecast window
  absMax: number;       // peak absolute stock value before normalization
}

const COLORS = {
  bg: '#0B1121',
  grid: '#141E33',
  axis: '#1E2A4A',
  noPurchase: '#FF3B3B',
  withPurchase: '#00E5A0',
  stockout: '#FF8C42',
  text: '#8E9CB8',
  labelDim: '#4A5A7B',
};

/** label 来自 ERP API 站点名/SKU（甚至经 LLM 输出），插入 innerHTML 前必须转义 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

/** 图例项 HTML：色条 + 转义后的 label + max 值 */
export function legendItemHtml(label: string, color: string, maxLabel: string): string {
  return (
    '<span style="display:inline-block;width:16px;height:0;border-top:2.5px solid ' + color + ';vertical-align:middle;margin-right:4px;"></span>' +
    escapeHtml(label) +
    ' <span style="color:#4A5A7B;font-size:10px;">max:' + escapeHtml(maxLabel) + '</span>'
  );
}

/** 悬浮 tooltip HTML：label/周次/数值全部转义 */
export function tooltipHtml(label: string, week: string, absNo: string, absWith: string): string {
  return (
    '<div style="font-weight:600;margin-bottom:2px;">' + escapeHtml(label + ' · ' + week) + '</div>' +
    '<div>不采购: <b>' + escapeHtml(absNo) + '</b></div>' +
    '<div>建议采购: <b>' + escapeHtml(absWith) + '</b></div>'
  );
}

// Smooth accelerate-decelerate for line reveals. Spring easing overshoots,
// which makes the pen tip draw past the end and retract — jittery.
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function weekLabel(weekIdx: number): string {
  const d = new Date(Date.now() + weekIdx * 7 * 86400000);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/** Chart horizon cap — arrivals beyond this many weeks are not drawn. */
const MAX_WEEKS = 26;

export function computeCurve(input: CurveInput): CurveData {
  const total = input.currentStock + input.inTransit;

  const weekOf = (dateStr: string): number => {
    const d = new Date(dateStr);
    const now = new Date();
    const dayOffset = Math.ceil((d.getTime() - now.getTime()) / 86400000);
    if (dayOffset < 0) return -1;
    return Math.floor(dayOffset / 7);
  };

  // Purchase week: when the order is placed (预计采购)
  const restockWeek = input.restockDate ? weekOf(input.restockDate) : -1;

  // Arrival week: when goods land in warehouse (补货到仓 = 采购 + 生产 + 头程)
  const arrivalWeek = (input.arrivalDate || input.restockDate)
    ? weekOf(input.arrivalDate || input.restockDate)
    : -1;

  // Extend the forecast when arrival lands beyond the sell-until horizon so
  // the restock bump stays visible. Extension weeks decline at the tail fill
  // rate (predicted daily × 7) — sales don't stop at the sell-until date.
  const forecast = [...(input.weeklyForecast || [])];
  const n0 = forecast.length;
  if (arrivalWeek >= n0 && arrivalWeek < MAX_WEEKS) {
    while (forecast.length <= arrivalWeek) forecast.push(input.tailFillPerWeek ?? 0);
  }
  const n = forecast.length;

  const weeks = forecast.map((_, i) => weekLabel(i));
  const noPurchase: number[] = [];
  const withPurchase: number[] = [];
  let remaining = total;
  let stockoutWeek = -1;

  for (let i = 0; i < n; i++) {
    remaining -= forecast[i] ?? 0;
    const rounded = Math.round(remaining);
    noPurchase.push(Math.max(0, rounded));
    if (stockoutWeek === -1 && rounded <= 0) stockoutWeek = i;
  }

  // With-purchase projection: qty is added only when goods ARRIVE.
  // The accumulator must be clamped at 0 each step — otherwise a large
  // pre-arrival deficit swallows the arriving qty (plot stays flat at 0).
  const inWindow = arrivalWeek >= 0 && arrivalWeek < n;
  let wpRemaining = total;
  for (let i = 0; i < n; i++) {
    if (inWindow && i === arrivalWeek) wpRemaining += input.suggestedQty;
    wpRemaining -= forecast[i] ?? 0;
    wpRemaining = Math.max(0, Math.round(wpRemaining));
    withPurchase.push(wpRemaining);
  }

  const absMax = Math.max(maxOf(noPurchase), maxOf(withPurchase), total);
  return {
    weeks, noPurchase, withPurchase, stockoutWeek,
    restockWeek: restockWeek >= 0 && restockWeek < n ? restockWeek : -1,
    arrivalWeek: inWindow ? arrivalWeek : -1,
    absMax,
  };
}

function maxOf(...arrs: number[][]): number {
  let m = 100;
  for (const a of arrs) for (const v of a) if (v > m) m = v;
  return m;
}

interface PlotGeom {
  padLeft: number; padTop: number; pw: number; ph: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

function makeGeom(width: number, height: number, n: number, maxVal: number): PlotGeom {
  const pad = { top: 36, right: 20, bottom: 44, left: 48 };
  const pw = width - pad.left - pad.right;
  const ph = height - pad.top - pad.bottom;
  return {
    padLeft: pad.left, padTop: pad.top, pw, ph,
    x: (i: number) => pad.left + (n <= 1 ? pw / 2 : i * (pw / (n - 1))),
    y: (v: number) => pad.top + ph - (v / maxVal) * ph,
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, g: PlotGeom, weeks: string[], maxVal: number): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i < weeks.length; i++) {
    const gx = g.x(i);
    ctx.beginPath(); ctx.moveTo(gx, g.padTop); ctx.lineTo(gx, g.padTop + g.ph); ctx.stroke();
  }
  const isPct = maxVal === 100;
  const step = isPct ? 25 : Math.max(1, Math.ceil(maxVal / 6));
  for (let v = 0; v <= maxVal; v += step) {
    const gy = g.y(v);
    ctx.beginPath(); ctx.moveTo(g.padLeft, gy); ctx.lineTo(g.padLeft + g.pw, gy); ctx.stroke();
    ctx.fillStyle = COLORS.labelDim;
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(isPct ? v + '%' : String(v), g.padLeft - 6, gy + 4);
  }

  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(g.padLeft, g.padTop); ctx.lineTo(g.padLeft, g.padTop + g.ph); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(g.padLeft, g.padTop + g.ph); ctx.lineTo(g.padLeft + g.pw, g.padTop + g.ph); ctx.stroke();

  ctx.fillStyle = COLORS.labelDim;
  ctx.textAlign = 'center';
  weeks.forEach((w, i) => {
    if (weeks.length > 20 && i % 2 === 1) return; // thin labels when crowded
    ctx.fillText(w, g.x(i), g.padTop + g.ph + 18);
  });
}

function strokeLine(ctx: CanvasRenderingContext2D, data: number[], g: PlotGeom, color: string, alpha: number, from = 0, to?: number, dash?: number[]): void {
  const end = to ?? data.length - 1;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  for (let i = from; i <= end; i++) {
    const px = g.x(i), py = g.y(data[i] ?? 0);
    if (i === from) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawPartial(ctx: CanvasRenderingContext2D, data: number[], g: PlotGeom, color: string, progress: number, from = 0, dash?: number[], alpha = 1): void {
  if (progress <= 0) return;
  const totalSegs = data.length - 1 - from;
  const rawIdx = progress * totalSegs;
  const segIdx = Math.min(Math.floor(rawIdx), totalSegs - 1);
  const segT = rawIdx - segIdx;
  const absIdx = from + segIdx;

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(g.x(from), g.y(data[from] ?? 0));
  for (let i = from + 1; i <= absIdx; i++) {
    ctx.lineTo(g.x(i), g.y(data[i] ?? 0));
  }
  if (segIdx < totalSegs) {
    const t = easeOut(segT);
    const cx = g.x(absIdx) + (g.x(absIdx + 1) - g.x(absIdx)) * t;
    const cy = g.y((data[absIdx] ?? 0) + ((data[absIdx + 1] ?? 0) - (data[absIdx] ?? 0)) * t);
    ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  if (dash) ctx.setLineDash([]);

  // Pen tip glow at the leading edge — scales in as the pen touches down and
  // fades out as the line completes, so it never pops into view or vanishes.
  const tipT = segIdx < totalSegs ? easeOut(segT) : 1;
  const tipAbsIdx = segIdx < totalSegs ? absIdx : data.length - 2;
  const tipX = g.x(tipAbsIdx) + (g.x(tipAbsIdx + 1) - g.x(tipAbsIdx)) * tipT;
  const tipY = g.y((data[tipAbsIdx] ?? 0) + ((data[tipAbsIdx + 1] ?? 0) - (data[tipAbsIdx] ?? 0)) * tipT);
  const appear = Math.min(1, progress / 0.08, (1 - progress) / 0.05);
  if (appear > 0) {
    const scale = 0.4 + 0.6 * appear;
    ctx.globalAlpha = alpha * appear;
    const glowR = 12 * scale;
    const glow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(tipX, tipY, glowR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(tipX, tipY, 2.5 * scale, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRipple(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, radius: number, alpha: number): void {
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Marker text with right-edge clamping so labels never overflow the canvas. */
function drawMarkerLabel(
  ctx: CanvasRenderingContext2D, x: number, y: number, text: string,
  color: string, width: number, above: boolean, size = 11,
): void {
  ctx.fillStyle = color;
  ctx.font = 'bold ' + size + 'px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  const tw = ctx.measureText(text).width;
  let tx = x + 8;
  if (tx + tw > width - 10) tx = x - tw - 8;
  const ty = above ? y - 8 : y + size + 4;
  ctx.fillText(text, tx, ty);
}

/** Tooltip anchor: 14px right of the cursor; flips to the left of the cursor
 *  when it would overflow the right edge of the canvas. */
export function tooltipPosition(
  mx: number, my: number, tooltipW: number, canvasW: number,
): { left: number; top: number } {
  let left = mx + 14;
  if (left + tooltipW > canvasW) left = Math.max(0, mx - 14 - tooltipW);
  return { left, top: my - 10 };
}

/** Dashed connector from stockout point to arrival point. */
function drawArrivalConnector(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number, toX: number, toY: number, color: string, alpha = 0.5,
): void {
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawStatic(ctx: CanvasRenderingContext2D, width: number, height: number, data: CurveData, fade = 1): void {
  const maxVal = maxOf(data.noPurchase, data.withPurchase);
  const g = makeGeom(width, height, data.weeks.length, maxVal);
  drawGrid(ctx, width, height, g, data.weeks, maxVal);
  strokeLine(ctx, data.noPurchase, g, COLORS.noPurchase, 0.7, 0, undefined, [12, 8]);
  if (data.arrivalWeek >= 0) {
    // Solid line re-traces the dashed path from the left, diverging at the arrival fork
    strokeLine(ctx, data.withPurchase, g, COLORS.withPurchase, 0.85, 0);
  }

  // 断货 marker + connector (connector only when arrival is also visible)
  if (data.stockoutWeek >= 0) {
    const sx = g.x(data.stockoutWeek), sy = g.y(0);
    drawRipple(ctx, sx, sy, COLORS.stockout, 22, 0.35 * fade);
    drawMarkerLabel(ctx, sx, sy, '断货', COLORS.stockout, width, true);
    if (data.arrivalWeek >= 0) {
      const rx = g.x(data.arrivalWeek), ry = g.y(data.withPurchase[data.arrivalWeek] ?? 0);
      drawArrivalConnector(ctx, sx, sy, rx, ry, 'rgba(0,229,160,0.45)', 0.5 * fade);
    }
  }

  // 补货到仓 marker — independent of stockout
  if (data.arrivalWeek >= 0) {
    const rx = g.x(data.arrivalWeek), ry = g.y(data.withPurchase[data.arrivalWeek] ?? 0);
    const nearBottom = ry > g.padTop + g.ph * 0.85;
    ctx.globalAlpha = fade;
    drawMarkerLabel(ctx, rx, ry, '补货到仓', COLORS.withPurchase, width, nearBottom);
    ctx.globalAlpha = 1;
  }

  // 预计采购 marker on the dashed line — independent of stockout
  if (data.restockWeek >= 0) {
    const px = g.x(data.restockWeek), py = g.y(data.noPurchase[data.restockWeek] ?? 0);
    drawRipple(ctx, px, py, COLORS.noPurchase, 18, 0.3);
    drawMarkerLabel(ctx, px, py, '预计采购', COLORS.noPurchase, width, true);
  }
}

function drawCurveMarkers(
  ctx: CanvasRenderingContext2D, d: CurveData, g: PlotGeom,
  color: string, width: number, fade = 1,
): void {
  // 断货 marker + connector (connector only when arrival is also visible)
  if (d.stockoutWeek >= 0) {
    const sx = g.x(d.stockoutWeek), sy = g.y(0);
    drawRipple(ctx, sx, sy, color, 20, 0.35 * fade);
    ctx.globalAlpha = fade;
    drawMarkerLabel(ctx, sx, sy, '断货', color, width, true, 9);
    ctx.globalAlpha = 1;
    if (d.arrivalWeek >= 0) {
      const rx = g.x(d.arrivalWeek), ry = g.y(d.withPurchase[d.arrivalWeek] ?? 0);
      drawArrivalConnector(ctx, sx, sy, rx, ry, color, 0.5 * fade);
    }
  }

  // 补货到仓 marker — independent of stockout
  if (d.arrivalWeek >= 0) {
    const rx = g.x(d.arrivalWeek), ry = g.y(d.withPurchase[d.arrivalWeek] ?? 0);
    const nearBottom = ry > g.padTop + g.ph * 0.85;
    ctx.globalAlpha = fade;
    drawMarkerLabel(ctx, rx, ry, '补货', color, width, nearBottom, 9);
    ctx.globalAlpha = 1;
  }

  // 采购 marker on the dashed (no-purchase) line — independent of stockout
  if (d.restockWeek >= 0) {
    const px = g.x(d.restockWeek), py = g.y(d.noPurchase[d.restockWeek] ?? 0);
    drawRipple(ctx, px, py, color, 18, 0.3 * fade);
    ctx.globalAlpha = fade;
    drawMarkerLabel(ctx, px, py, '采购', color, width, true, 9);
    ctx.globalAlpha = 1;
  }
}

/**
 * Render the inventory projection curve with a ~2.7s animation:
 * dashed line flows → stockout ripple pause → solid line re-traces the same
 * path from the left edge and lifts off at the arrival fork → static with
 * breathing stockout pulse. Animated and static geometry match exactly so
 * nothing pops when the animation settles.
 * Multi-curve: each SKU one color, dashed=不采购, solid=建议采购.
 * Returns an unmount function.
 */
export function renderCurve(container: HTMLElement, inputs: CurveInput[], filterSkus?: string[]): () => void {
  const filtered = filterSkus && filterSkus.length > 0
    ? inputs.filter(c => filterSkus.includes(c.sku))
    : inputs;

  if (filtered.length === 0) {
    container.innerHTML =
      '<div style="padding:20px;text-align:center;color:#8E9CB8;">请选择SKU查看曲线</div>';
    return () => {};
  }

  const curves = filtered.map(c => computeCurve(c));

  // Different arrival dates may extend curves by different amounts — pad
  // shorter curves so all share the same week axis.
  const maxN = Math.max(...curves.map(d => d.weeks.length));
  for (const d of curves) {
    while (d.weeks.length < maxN) {
      d.weeks.push(weekLabel(d.weeks.length));
      d.noPurchase.push(d.noPurchase[d.noPurchase.length - 1] ?? 0);
      d.withPurchase.push(d.withPurchase[d.withPurchase.length - 1] ?? 0);
    }
  }

  // Multi-curve: normalize to percentage so curves with very different scales are all visible
  if (curves.length > 1) {
    for (const d of curves) {
      if (d.absMax <= 0) continue;
      for (let i = 0; i < d.noPurchase.length; i++) {
        d.noPurchase[i] = Math.round((d.noPurchase[i] / d.absMax) * 100);
        d.withPurchase[i] = Math.round((d.withPurchase[i] / d.absMax) * 100);
      }
    }
  }

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const C = { w: container.clientWidth || 720, h: 300 };
  canvas.width = C.w * dpr;
  canvas.height = C.h * dpr;
  canvas.style.cssText = `width:${C.w}px;height:${C.h}px;border-radius:8px;`;
  container.innerHTML = '';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  ctx.scale(dpr, dpr);
  const W = C.w, H = C.h;
  const maxVal = curves.length > 1 ? 100 : Math.max(...curves.map(d => maxOf(d.noPurchase, d.withPurchase)), 100);
  const g = makeGeom(W, H, curves[0].weeks.length, maxVal);

  // Each SKU one color. Dashed = no-purchase, solid = with-purchase.
  const CURVE_COLORS = [
    '#FF3B3B',  // red
    '#4488FF',  // blue
    '#00C896',  // green
    '#FF8C42',  // orange
    '#E040FB',  // magenta
    '#FFD740',  // amber
  ];
  const NO_PURCHASE_DASH = [12, 8];

  // HTML legend below canvas
  const legend = document.createElement('div');
  legend.style.cssText =
    'display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;padding:8px 12px 4px;' +
    'font-size:11px;color:#8E9CB8;font-family:Inter,system-ui,sans-serif;';
  const hdr = document.createElement('span');
  hdr.style.cssText = 'color:#4A5A7B;margin-right:4px;';
  const legendDashColor = curves.length === 1 ? COLORS.noPurchase : '#8E9CB8';
  const legendSolidColor = curves.length === 1 ? COLORS.withPurchase : '#8E9CB8';
  hdr.innerHTML =
    '<span style="display:inline-block;width:16px;height:0;border-top:2px dashed ' + legendDashColor + ';vertical-align:middle;margin-right:3px;"></span>不采购' +
    ' <span style="display:inline-block;width:16px;height:0;border-top:2.5px solid ' + legendSolidColor + ';vertical-align:middle;margin:0 3px 0 8px;"></span>建议采购';
  legend.appendChild(hdr);
  if (curves.length > 1) {
    for (let ci = 0; ci < curves.length; ci++) {
      const d = curves[ci];
      const color = CURVE_COLORS[ci % CURVE_COLORS.length]!;
      const item = document.createElement('span');
      item.style.cssText = 'color:#CCD6E0;white-space:nowrap;';
      const maxLabel = d.absMax >= 1000 ? (d.absMax / 1000).toFixed(1) + 'k' : String(d.absMax);
      item.innerHTML = legendItemHtml(filtered[ci]!.label || filtered[ci]!.sku, color, maxLabel);
      legend.appendChild(item);
    }
  }
  container.style.position = 'relative';
  container.appendChild(legend);

  // Hover tooltip for absolute values
  const tooltip = document.createElement('div');
  tooltip.style.cssText =
    'position:absolute;display:none;background:rgba(11,17,33,0.95);color:#CCD6E0;' +
    'padding:6px 10px;border-radius:6px;font-size:11px;font-family:Inter,system-ui,sans-serif;' +
    'pointer-events:none;z-index:10;white-space:nowrap;border:1px solid #1E2A4A;';
  container.appendChild(tooltip);

  const isMulti = curves.length > 1;
  canvas.style.cursor = 'crosshair';
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Find nearest week
    let bestWeek = 0, bestDist = Infinity;
    for (let i = 0; i < curves[0].weeks.length; i++) {
      const dist = Math.abs(g.x(i) - mx);
      if (dist < bestDist) { bestDist = dist; bestWeek = i; }
    }
    if (bestDist > 40) { tooltip.style.display = 'none'; return; }
    // Find nearest curve (or use the only one for single-curve)
    let ci = 0;
    if (isMulti) {
      let bestCiDist = Infinity;
      for (let j = 0; j < curves.length; j++) {
        const py = g.y(curves[j].noPurchase[bestWeek]);
        const d = Math.abs(py - my);
        if (d < bestCiDist) { bestCiDist = d; ci = j; }
      }
    }
    const d = curves[ci];
    const valNo = d.noPurchase[bestWeek] ?? 0;
    const valWith = d.withPurchase[bestWeek] ?? 0;
    // Multi: values are percentages, convert back to absolute. Single: already absolute.
    const absNo = isMulti ? Math.round((valNo / 100) * d.absMax) : valNo;
    const absWith = isMulti ? Math.round((valWith / 100) * d.absMax) : valWith;
    const label = filtered[ci]!.label || filtered[ci]!.sku;
    tooltip.innerHTML = tooltipHtml(label, curves[0]!.weeks[bestWeek] ?? '', absNo.toLocaleString(), absWith.toLocaleString());
    tooltip.style.display = 'block';
    const pos = tooltipPosition(mx, my, tooltip.offsetWidth, rect.width);
    tooltip.style.left = pos.left + 'px';
    tooltip.style.top = pos.top + 'px';
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

  let rid: number | null = null;
  const startTs = performance.now();
  const RED_END = 1.2, PAUSE_END = 1.5, GREEN_END = 2.45, TOTAL = 2.75;

  if (curves.length === 1) {
    // Single curve: full animation with stockout ripple
    const data = curves[0];

    function frame(now: number): void {
      const elapsed = (now - startTs) / 1000;
      drawGrid(ctx, W, H, g, data.weeks, maxVal);

      if (elapsed <= RED_END) {
        const progress = easeInOutCubic(elapsed / RED_END);
        drawPartial(ctx, data.noPurchase, g, COLORS.noPurchase, progress, 0, NO_PURCHASE_DASH, 0.7);
      } else if (elapsed <= PAUSE_END) {
        strokeLine(ctx, data.noPurchase, g, COLORS.noPurchase, 0.7, 0, undefined, NO_PURCHASE_DASH);
        if (data.stockoutWeek >= 0) {
          const sx = g.x(data.stockoutWeek), sy = g.y(0);
          const re = elapsed - RED_END;
          const rippleT = (re / (PAUSE_END - RED_END));
          drawRipple(ctx, sx, sy, COLORS.stockout, 8 + rippleT * 24, Math.max(0, 0.7 * (1 - rippleT)));
          ctx.globalAlpha = Math.min(1, re / 0.12);
          ctx.fillStyle = COLORS.stockout;
          ctx.font = 'bold 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText('断货', sx + 10, sy - 8);
          ctx.globalAlpha = 1;
        }
      } else if (elapsed <= GREEN_END) {
        strokeLine(ctx, data.noPurchase, g, COLORS.noPurchase, 0.7, 0, undefined, NO_PURCHASE_DASH);
        const pf = Math.min(1, (elapsed - PAUSE_END) / 0.3);
        if (data.stockoutWeek >= 0) {
          // Already visible since the pause — keep at full alpha, no re-fade
          drawMarkerLabel(ctx, g.x(data.stockoutWeek), g.y(0), '断货', COLORS.stockout, W, true);
        }
        if (data.restockWeek >= 0) {
          const px = g.x(data.restockWeek), py = g.y(data.noPurchase[data.restockWeek] ?? 0);
          drawRipple(ctx, px, py, COLORS.noPurchase, 18, 0.3 * pf);
          ctx.globalAlpha = pf;
          drawMarkerLabel(ctx, px, py, '预计采购', COLORS.noPurchase, W, true);
          ctx.globalAlpha = 1;
        }
        if (data.arrivalWeek >= 0) {
          const gp = easeInOutCubic((elapsed - PAUSE_END) / (GREEN_END - PAUSE_END));
          drawPartial(ctx, data.withPurchase, g, COLORS.withPurchase, gp, 0, undefined, 0.85);
        }
      } else {
        const settle = Math.min(1, (elapsed - GREEN_END) / 0.35);
        drawStatic(ctx, W, H, data, settle);
        if (data.stockoutWeek >= 0) {
          const sx = g.x(data.stockoutWeek), sy = g.y(0);
          const breathe = 0.25 + 0.15 * Math.sin(now / 800);
          drawRipple(ctx, sx, sy, COLORS.stockout, 22, breathe * settle);
        }
        if (elapsed <= TOTAL) rid = requestAnimationFrame(frame);
        return;
      }
      rid = requestAnimationFrame(frame);
    }
    rid = requestAnimationFrame(frame);
  } else {
    // Multi-curve: animate all dashed → pause → animate all solid simultaneously
    function frameMulti(now: number): void {
      const elapsed = (now - startTs) / 1000;
      drawGrid(ctx, W, H, g, curves[0].weeks, maxVal);

      if (elapsed <= RED_END) {
        const progress = easeInOutCubic(elapsed / RED_END);
        for (let ci = 0; ci < curves.length; ci++) {
          const color = CURVE_COLORS[ci % CURVE_COLORS.length];
          drawPartial(ctx, curves[ci].noPurchase, g, color, progress, 0, NO_PURCHASE_DASH, 0.7);
        }
      } else if (elapsed <= GREEN_END) {
        for (let ci = 0; ci < curves.length; ci++) {
          const color = CURVE_COLORS[ci % CURVE_COLORS.length];
          strokeLine(ctx, curves[ci].noPurchase, g, color, 0.7, 0, undefined, NO_PURCHASE_DASH);
        }
        const gp = easeInOutCubic((elapsed - PAUSE_END) / (GREEN_END - PAUSE_END));
        for (let ci = 0; ci < curves.length; ci++) {
          const d = curves[ci];
          if (d.arrivalWeek < 0) continue;
          const color = CURVE_COLORS[ci % CURVE_COLORS.length];
          drawPartial(ctx, d.withPurchase, g, color, gp, 0, undefined, 0.85);
        }
      } else {
        // Static: dashed no-purchase always; solid with-purchase re-traces from the left
        const settle = Math.min(1, (elapsed - GREEN_END) / 0.35);
        for (let ci = 0; ci < curves.length; ci++) {
          const d = curves[ci];
          const color = CURVE_COLORS[ci % CURVE_COLORS.length];
          strokeLine(ctx, d.noPurchase, g, color, 0.7, 0, undefined, NO_PURCHASE_DASH);
          if (d.arrivalWeek >= 0) {
            strokeLine(ctx, d.withPurchase, g, color, 0.85, 0);
          }
          drawCurveMarkers(ctx, d, g, color, W, settle);
        }
        if (elapsed <= TOTAL) rid = requestAnimationFrame(frameMulti);
        return;
      }
      rid = requestAnimationFrame(frameMulti);
    }
    rid = requestAnimationFrame(frameMulti);
  }

  return () => {
    if (rid) cancelAnimationFrame(rid);
    canvas.remove();
    legend.remove();
    tooltip.remove();
    container.style.position = '';
  };
}
