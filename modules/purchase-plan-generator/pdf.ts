// modules/purchase-plan-generator/pdf.ts
// Two-page PDF report: summary table + analysis (page 1), curve + per-SKU details (page 2).
// Chinese text is rendered via canvas (system font) and embedded as images,
// since jsPDF's built-in fonts cannot render CJK glyphs.

import { jsPDF } from 'jspdf';
import type { GenResult } from './ui';

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Render Chinese text block to a PNG data URL (white bg, dark text). */
function renderTextToImage(lines: string[], fontSize = 14, lineHeight = 24, pad = 12): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = Math.max(40, lines.length * lineHeight + pad * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1E293B';
  ctx.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillText(line, pad, pad + i * lineHeight);
  });
  return canvas.toDataURL('image/png');
}

/** 把文本行按每页可容纳的行数分块。首页与后续页容量可以不同（首页从当前 y 继续）。
 *  单块超页高会被 jsPDF 裁剪丢失内容，且超长 canvas 有 32767px 高度上限。 */
export function chunkLinesForPages(
  lines: string[],
  firstPageCapacity: number,
  laterPageCapacity: number,
): string[][] {
  if (lines.length === 0) return [];
  const chunks: string[][] = [];
  let idx = 0;
  let cap = Math.max(1, firstPageCapacity);
  const laterCap = Math.max(1, laterPageCapacity);
  while (idx < lines.length) {
    chunks.push(lines.slice(idx, idx + cap));
    idx += cap;
    cap = laterCap;
  }
  return chunks;
}

export async function generatePdfReport(
  results: GenResult[],
  curveCanvas: HTMLCanvasElement,
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;

  // ---------- Page 1: title + summary table + analysis ----------
  doc.setFontSize(16);
  doc.text('Purchase Plan Report', margin, 20);
  doc.setFontSize(9);
  doc.text('Generated: ' + new Date().toISOString().slice(0, 10), margin, 26);

  // Summary table — manual drawing (no autoTable dependency)
  const headers = ['SKU', 'Plan Qty', 'Boxes', 'Delivery', 'Risk'];
  const colW = [70, 24, 20, 32, 18];
  const tableX = margin;
  const colStart: number[] = [];
  let acc = tableX;
  for (const w of colW) { colStart.push(acc); acc += w; }
  const rowH = 8;
  let y = 34;

  // Header row
  doc.setFillColor(99, 102, 241);
  doc.rect(tableX, y - 5, colW.reduce((a, b) => a + b, 0), rowH, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  headers.forEach((h, i) => doc.text(h, colStart[i] + 2, y));
  y += rowH;

  // Data rows
  doc.setTextColor(30, 41, 59);
  for (const r of results) {
    if (y > pageH - 30) { doc.addPage(); y = 20; }
    doc.text(r.suggestion.sku, colStart[0] + 2, y);
    doc.text(String(r.planQty), colStart[1] + 2, y);
    doc.text(String(r.boxes), colStart[2] + 2, y);
    doc.text(r.suggestion.restockDate || '--', colStart[3] + 2, y);
    doc.text(r.suggestion.riskLevel.toUpperCase(), colStart[4] + 2, y);
    doc.line(tableX, y + 2, tableX + colW.reduce((a, b) => a + b, 0), y + 2);
    y += rowH;
  }

  // Analysis suggestions (Chinese → canvas image)
  y += 8;
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.text('Analysis & Suggestions', margin, y);
  y += 6;

  const textCanvas = document.createElement('canvas');
  textCanvas.width = 1400;
  const textCtx = textCanvas.getContext('2d');
  if (textCtx) {
    textCtx.font = '14px "Microsoft YaHei", "PingFang SC", sans-serif';
  }

  const suggestionLines: string[] = [];
  for (const r of results) {
    suggestionLines.push(`[${r.suggestion.sku}] (${r.suggestion.riskLevel.toUpperCase()})`);
    const wrapped = textCtx
      ? wrapText(textCtx, r.suggestion.suggestion, 1330)
      : [r.suggestion.suggestion];
    suggestionLines.push(...wrapped, '');
  }

  // Render in page-sized chunks — one giant canvas image would be clipped
  // where it exceeds a page and risks the 32767px canvas height limit.
  const imgW = pageW - margin * 2;
  // canvas 行高 24px + 上下 pad 共 24px，按 imgW/1400 比例换算成 mm
  const chunkHeightMm = (n: number) => (n * 24 + 24) * imgW / 1400;
  const capFor = (availMm: number) => Math.max(1, Math.floor((availMm * 1400 / imgW - 24) / 24));
  const chunks = chunkLinesForPages(
    suggestionLines,
    capFor(pageH - 15 - y),           // 首页：从当前 y 到页底
    capFor(pageH - 20 - 15),          // 后续页：新页从 y=20 起
  );
  for (const chunk of chunks) {
    const chunkH = chunkHeightMm(chunk.length);
    if (y + chunkH > pageH - 15) { doc.addPage(); y = 20; }
    const imgData = renderTextToImage(chunk);
    if (imgData) doc.addImage(imgData, 'PNG', margin, y, imgW, chunkH);
    y += chunkH + 4;
  }

  // ---------- Page 2: curve + per-SKU details ----------
  doc.addPage();
  doc.setFontSize(14);
  doc.text('Inventory Projection', margin, 20);

  const imgW2 = pageW - margin * 2;
  const imgH2 = (curveCanvas.height / curveCanvas.width) * imgW2;
  const maxImgH = pageH - 60;
  const scale = imgH2 > maxImgH ? maxImgH / imgH2 : 1;
  doc.addImage(curveCanvas.toDataURL('image/png'), 'PNG', margin, 26, imgW2 * scale, imgH2 * scale);

  let y2 = 26 + imgH2 * scale + 12;
  doc.setFontSize(12);
  doc.text('Per-SKU Details', margin, y2);
  y2 += 8;
  doc.setFontSize(9);
  for (const r of results) {
    if (y2 > pageH - 20) { doc.addPage(); y2 = 20; }
    doc.text(
      r.suggestion.sku + ' | Plan: ' + r.planQty + ' (' + r.boxes + ' boxes) | ' +
      'Delivery: ' + (r.suggestion.restockDate || '--') + ' | Risk: ' + r.suggestion.riskLevel,
      margin, y2,
    );
    y2 += 6;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save('采购计划报告_' + dateStr + '.pdf');
}
