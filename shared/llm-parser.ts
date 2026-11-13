// shared/llm-parser.ts
import type { LlmSuggestion } from './types';

function isValidRiskLevel(v: unknown): v is LlmSuggestion['riskLevel'] {
  return v === 'red' || v === 'yellow' || v === 'green';
}

function parseOneBlock(text: string): LlmSuggestion[] {
  let cleaned = text.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // Find the outermost JSON array
  const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!arrayMatch) return [];

  try {
    const items: unknown[] = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(items)) return [];

    return items
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
      )
      .map((item) => ({
        scope:
          typeof item.scope === 'string' ? item.scope : 'global',
        sku: typeof item.sku === 'string' ? item.sku : String(item.sku ?? ''),
        suggestion:
          typeof item.suggestion === 'string'
            ? item.suggestion
            : '--',
        riskLevel: isValidRiskLevel(item.riskLevel)
          ? (item.riskLevel as LlmSuggestion['riskLevel'])
          : 'green',
        suggestedQty:
          typeof item.suggestedQty === 'number' ? item.suggestedQty : undefined,
        predictedDailySales:
          typeof item.predictedDailySales === 'number' ? item.predictedDailySales : undefined,
        restockDate:
          typeof item.restockDate === 'string' ? item.restockDate : undefined,
        weeklyForecast:
          Array.isArray(item.weeklyForecast) &&
          item.weeklyForecast.every((v: unknown) => typeof v === 'number')
            ? (item.weeklyForecast as number[])
            : undefined,
      }));
  } catch {
    return [];
  }
}

export function parseLlmResponse(
  raw: string,
  expectedScopes?: { sku: string; scopes: string[] }[],
): LlmSuggestion[] {
  const results = parseRaw(raw);

  if (expectedScopes && expectedScopes.length > 0) {
    return validateAndPatch(results, expectedScopes);
  }
  return results;
}

/** Internal: parse without validation (backward compat) */
function parseRaw(raw: string): LlmSuggestion[] {
  // Split on --- separators (multi-ASIN prompts produce separate blocks)
  const blocks = raw.split(/\n---\n/);
  const results: LlmSuggestion[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    try {
      results.push(...parseOneBlock(trimmed));
    } catch {
      // skip blocks that fail to parse
    }
  }
  // Fallback: if splitting didn't work, try the whole text at once
  if (results.length === 0) {
    results.push(...parseOneBlock(raw));
  }
  return results;
}

/** SKU/scope 归一化：AI 返回的值可能带空格或大小写差异，
 *  严格字符串匹配会把真实建议误判为缺失 → 静默按 0 采购。 */
function normKey(s: string): string {
  return s.trim().toUpperCase();
}

/** Validate parsed results against expected scopes. Missing scopes get
 *  placeholder entries; extra/unrecognized scopes are dropped.
 *  匹配按归一化键进行；命中后输出回写为期望侧的规范 SKU/scope。 */
function validateAndPatch(
  parsed: LlmSuggestion[],
  expected: { sku: string; scopes: string[] }[],
): LlmSuggestion[] {
  const result: LlmSuggestion[] = [];
  const parsedMap = new Map<string, LlmSuggestion>();
  for (const p of parsed) {
    const key = normKey(p.sku) + '::' + normKey(p.scope);
    if (!parsedMap.has(key)) parsedMap.set(key, p);
  }

  for (const exp of expected) {
    for (const scope of exp.scopes) {
      const key = normKey(exp.sku) + '::' + normKey(scope);
      const existing = parsedMap.get(key);
      if (existing) {
        // 回写规范形式：下游用 selectedSkus.get(sug.sku) 与 scope 字符串精确匹配
        result.push({ ...existing, sku: exp.sku, scope });
      } else {
        // Patch missing entry
        result.push({
          scope,
          sku: exp.sku,
          suggestion: scope === 'global'
            ? 'AI 未返回全渠道计划'
            : '该站点暂无销售数据，无法生成采购计划',
          riskLevel: 'green',
          suggestedQty: 0,
          predictedDailySales: 0,
          restockDate: '',
          weeklyForecast: [],
        });
      }
    }
  }

  // Drop entries whose scope isn't in expected (unrecognized or extra)
  return result.filter(r => {
    const exp = expected.find(e => normKey(e.sku) === normKey(r.sku));
    return exp !== undefined && exp.scopes.some(s => normKey(s) === normKey(r.scope));
  });
}
