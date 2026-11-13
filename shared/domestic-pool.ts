// shared/domestic-pool.ts
// 国内库存按站点借用排除（2026-09-08，spec:
// docs/superpowers/specs/2026-09-08-domestic-borrowing-exclusion-design.md）。
// 国内自营仓名按站点编码（仓树实测）：CN_A_US / CN_B_DE / CN_B_UK / CN_C_CA /
// CN_A_Tiktok / CN_A_TEMU / CN_C_WMSP……每个运营负责一个站点，其他站点的国内货
// 是否可借只有口头约定（ERP 无记录），分析时由运营勾选不可借站点，程序按仓名
// 末段码归组直接扣减对应仓的可用量。
import { EU_COUNTRIES } from './fba-warehouse';

/** 站点组 id（chips 的勾选值） */
export type DomesticSiteGroup =
  | 'US' | 'UK' | 'EU' | 'CA' | 'JP' | 'AU' | 'SA' | 'SG' | 'AE'
  | 'TikTok' | 'TEMU' | 'Walmart';

/** 单国码 → 组。EU_COUNTRIES 成员全部归 EU（用户口径：欧洲汇总组所有站点命中的
 *  国内仓相加；将来 NL/BE 建仓自动并入），UK 独立不并。 */
const COUNTRY_TO_GROUP: Record<string, DomesticSiteGroup> = {
  US: 'US', UK: 'UK', CA: 'CA', JP: 'JP', AU: 'AU', SA: 'SA', SG: 'SG', AE: 'AE',
  TIKTOK: 'TikTok', TEMU: 'TEMU', WMSP: 'Walmart',
};
for (const c of EU_COUNTRIES) COUNTRY_TO_GROUP[c] = 'EU';

/** 面板 chips 的固定组清单（v1 不预取仓名，缺仓的组扣减自然为 0） */
export const DOMESTIC_SITE_GROUPS: DomesticSiteGroup[] = [
  'US', 'UK', 'EU', 'TikTok', 'TEMU', 'Walmart', 'CA', 'JP', 'AU', 'SA', 'SG', 'AE',
];

/** 仓名 → 站点组；解析不出（通用仓/非 CN 前缀）返回 null = 默认可借不可勾除。
 *  规则：CN_ 前缀（大小写不敏感）取最后一个下划线后的段码查表；
 *  CN-MS-TEMU 这类连字符命名解析不出，按通用仓处理（v1 边界，spec 记录）。 */
export function parseDomesticSiteGroup(warehouseName: string): DomesticSiteGroup | null {
  if (!/^(cn|CN)_/.test(warehouseName)) return null;
  const code = warehouseName.split('_').pop();
  if (!code) return null;
  return COUNTRY_TO_GROUP[code.toUpperCase()] ?? null;
}

/** 勾选组命中的仓行 availableQty 求和 = 国内不可借扣减数。
 *  detail 可直接喂 warehouseDetail / domesticWarehouses（FBA 等非 CN 仓名解析不出自然跳过）。 */
export function domesticNonLendable(
  detail: Array<{ name: string; available?: number }> | undefined,
  selected: Set<DomesticSiteGroup>,
): number {
  if (!detail || selected.size === 0) return 0;
  let sum = 0;
  for (const w of detail) {
    const g = parseDomesticSiteGroup(w.name);
    if (g && selected.has(g)) sum += w.available || 0;
  }
  return sum;
}

/** 调拨来源可动用 = 国内可用 − 预占 − 国内不可借（下限 0） */
export function transferSourceCapacity(
  domesticAvailable: number,
  domesticReserved: number,
  nonLendable: number,
): number {
  return Math.max(0, (domesticAvailable || 0) - (domesticReserved || 0) - (nonLendable || 0));
}

/** 建议调拨量超出国内可动用 → 警告行文本；未超出返回 null。
 *  可行性校验与是否勾选不可借无关（预占本身也可能吃掉来源）。 */
export function transferSourceWarning(
  suggestedQty: number,
  domesticAvailable: number,
  domesticReserved: number,
  nonLendable: number,
): string | null {
  const cap = transferSourceCapacity(domesticAvailable, domesticReserved, nonLendable);
  if (!(suggestedQty > cap)) return null;
  return '⚠ 建议调拨 ' + suggestedQty + ' 超出国内可动用 ' + cap +
    (nonLendable > 0 ? '（不可借已扣 ' + nonLendable + '）' : '') +
    '，需协调或分批调拨';
}

/** 替代调出仓（评审 #2，2026-09-21）：国内仓中可动用最大者（口径复用
 *  transferSourceCapacity）；勾选不可借组的仓跳过，解析不出的通用仓可借。
 *  无可动用仓返回 null。确定性选仓——不解析 AI 推荐文本。 */
export function pickFallbackSourceWarehouse(
  warehouses: Array<{ name: string; available?: number; reserved?: number }> | undefined,
  nonLendableGroups: ReadonlySet<DomesticSiteGroup>,
): { name: string; movable: number } | null {
  let best: { name: string; movable: number } | null = null;
  for (const w of warehouses || []) {
    const g = parseDomesticSiteGroup(w.name);
    if (g && nonLendableGroups.has(g)) continue;
    const movable = transferSourceCapacity(w.available || 0, w.reserved || 0, 0);
    if (movable <= 0) continue;
    if (!best || movable > best.movable) best = { name: w.name, movable };
  }
  return best;
}

/** 问号 tooltip 文案（spec 定稿原文） */
export const NON_LENDABLE_TOOLTIP =
  '国内库存为整条 SKU 共享，但各站点由不同运营负责。勾选后，该站点专属国内仓' +
  '（如 US→CN_A_US）的可用量将不计入你的分析基数：采购建议按可动用库存收紧，' +
  '调拨会校验国内来源是否够调。默认不勾 = 国内库存全部可借（原行为）。' +
  'EU 组 = 所有欧洲站点的国内仓合计（现仅 CN_B_DE），UK 独立。';

/** chips 行 HTML（两面板参数区共用）。勾选值读/写由各面板接线：
 *  checkbox 带 class="erp-nl-chip" data-group="US"，监听器用事件委托挂在容器上
 *  （容器本身不被 innerHTML 重建，避免重复绑监听）。 */
export function nonLendableChipsHtml(selected: ReadonlySet<DomesticSiteGroup>): string {
  const chips = DOMESTIC_SITE_GROUPS.map(function (g) {
    return '<label style="display:inline-flex;align-items:center;gap:2px;font-size:10px;' +
      'color:#64748b;cursor:pointer;user-select:none;">' +
      '<input type="checkbox" class="erp-nl-chip" data-group="' + g + '"' +
      (selected.has(g) ? ' checked' : '') + ' style="margin:0;accent-color:#6366f1;">' +
      g + '</label>';
  }).join(' ');
  return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">' +
    '<span style="font-size:10px;color:#64748b;flex-shrink:0;">国内不可借:</span>' +
    chips +
    '<span title="' + NON_LENDABLE_TOOLTIP.replace(/"/g, '&quot;') + '" ' +
    'style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;' +
    'border-radius:50%;background:#e2e8f0;color:#64748b;font-size:10px;font-weight:700;' +
    'cursor:help;flex-shrink:0;">?</span>' +
    '</div>';
}

/** 从容器内勾选的 chips 读回组集合（容器级委托监听器调用） */
export function readNonLendableGroups(container: HTMLElement | Document): Set<DomesticSiteGroup> {
  const set = new Set<DomesticSiteGroup>();
  for (const cb of container.querySelectorAll<HTMLInputElement>('.erp-nl-chip')) {
    if (cb.checked) set.add(cb.dataset.group as DomesticSiteGroup);
  }
  return set;
}
