// shared/__tests__/llm-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseLlmResponse } from '../llm-parser';

describe('parseLlmResponse', () => {
  const validInput = JSON.stringify([
    { sku: 'SKU-001', suggestion: '建议补货200件', riskLevel: 'red' },
  ]);

  it('parses clean JSON array', () => {
    const result = parseLlmResponse(validInput);
    expect(result).toHaveLength(1);
    expect(result[0]!.sku).toBe('SKU-001');
    expect(result[0]!.suggestion).toBe('建议补货200件');
    expect(result[0]!.riskLevel).toBe('red');
  });

  it('parses markdown-wrapped JSON', () => {
    const input = '```json\n' + validInput + '\n```';
    const result = parseLlmResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.sku).toBe('SKU-001');
  });

  it('returns empty array for truncated JSON', () => {
    const result = parseLlmResponse('[{"sku":"SKU-001","suggestion":"补货');
    expect(result).toEqual([]);
  });

  it('fills missing fields with defaults', () => {
    const input = JSON.stringify([{ sku: 'X', suggestion: 'test' }]);
    const result = parseLlmResponse(input);
    expect(result[0]!.riskLevel).toBe('green');
  });

  it('returns empty array for non-array JSON', () => {
    const result = parseLlmResponse('{"sku":"X"}');
    expect(result).toEqual([]);
  });

  it('returns empty array for garbage input', () => {
    const result = parseLlmResponse('not json at all');
    expect(result).toEqual([]);
  });

  it('handles invalid riskLevel gracefully', () => {
    const input = JSON.stringify([{ sku: 'X', suggestion: 'test', riskLevel: 'unknown' }]);
    const result = parseLlmResponse(input);
    expect(result[0]!.riskLevel).toBe('green');
  });
});

describe('parseLlmResponse（SKU/scope 匹配容错）', () => {
  const expected = [{ sku: 'HC586TX', scopes: ['global', 'DE:Yaoshu'] }];

  it('AI 返回的 SKU 带空格/大小写差异仍能匹配，且输出回写为规范 SKU', () => {
    const raw = JSON.stringify([
      { sku: ' HC586tx ', scope: 'GLOBAL', suggestion: '判断+预测', riskLevel: 'yellow', suggestedQty: 0, predictedDailySales: 5 },
      { sku: 'hc586tx', scope: 'de:yaoshu', suggestion: '站点建议', riskLevel: 'green', suggestedQty: 0, predictedDailySales: 3 },
    ]);
    const result = parseLlmResponse(raw, expected);
    expect(result).toHaveLength(2);
    // 输出必须是规范形式——下游 selectedSkus.get(sug.sku) 与 scope 匹配依赖它
    expect(result.map(r => r.sku)).toEqual(['HC586TX', 'HC586TX']);
    expect(result.map(r => r.scope).sort()).toEqual(['DE:Yaoshu', 'global'].sort());
    expect(result.every(r => r.suggestion !== '该站点暂无销售数据，无法生成采购计划')).toBe(true);
  });

  it('确实无法匹配的 SKU 仍走占位兜底，不误吞', () => {
    const raw = JSON.stringify([
      { sku: 'OTHER-SKU', scope: 'global', suggestion: 'x', riskLevel: 'green' },
    ]);
    const result = parseLlmResponse(raw, expected);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.suggestedQty === 0)).toBe(true); // 全部为占位
  });
});
