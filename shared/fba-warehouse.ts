// shared/fba-warehouse.ts
// FBA 仓与市场归属。欧盟 EFN 共享仓（EU_FBA）的同一个库存池会在销售分析接口里
// 被复制到每个欧洲站点的快照上（DE/FR/IT/ES/NL/BE 各显示 ~577），跨市场求和会把
// 同一批货计 6 次。库存接口的 EU_FBA 行只有一条（真实池量），因此 FBA 库存一律
// 以库存接口为准，并用本模块把仓库归属到国家/汇总组。

/** 欧盟成员国家码（EFN 共享池覆盖范围；UK 有独立仓不在此列） */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE', 'FI', 'DK', 'AT', 'PT',
  'CZ', 'RO', 'GR', 'HU', 'SK', 'SI', 'HR', 'BG', 'LU', 'LT', 'LV', 'EE', 'CY', 'MT',
]);

/** 'Yaoshu:EU_FBA' → { store: 'Yaoshu', region: 'EU' }；非 FBA 仓名返回 null。
 *  _FBT（TIKTOK_FBT 仓，如 'SUPRENT-TK-US:US_FBT'）语义相当于 FBA/WFS（用户口径，
 *  FBT 虚拟仓已弃用）——同样按 店铺:区域 解析归属。 */
export function parseFbaWarehouse(name: string): { store: string; region: string } | null {
  const m = name.match(/^(.+):([A-Z]{2})_FB[AT]$/);
  if (!m) return null;
  return { store: m[1]!, region: m[2]! };
}

/** 区域是否服务该国家：EU 区域服务任一欧盟国；其它区域精确匹配国家码 */
export function isRegionOfCountry(region: string, country: string): boolean {
  const r = region.toUpperCase();
  const c = country.toUpperCase();
  if (r === 'EU') return EU_COUNTRIES.has(c);
  return r === c;
}
