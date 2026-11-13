import { describe, it, expect } from 'vitest';
import { legendItemHtml, tooltipHtml } from '../../modules/purchase-plan-generator/visualization';

// label 来自 ERP API 的站点名/SKU（甚至经 LLM 输出），插入 innerHTML 前必须转义
const EVIL = '<img src=x onerror=alert(1)>';

describe('legendItemHtml / tooltipHtml（XSS 转义）', () => {
  it('legend label 被转义，不产生可执行的 HTML', () => {
    const html = legendItemHtml(EVIL, '#5B8FF9', '1.2k');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('#5B8FF9');
    expect(html).toContain('max:1.2k');
  });

  it('tooltip 的 label 与数值被转义', () => {
    const html = tooltipHtml(EVIL, '08-24', '1,234', '2,000');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('08-24');
    expect(html).toContain('不采购');
    expect(html).toContain('建议采购');
  });
});
