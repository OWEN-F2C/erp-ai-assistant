import { describe, it, expect } from 'vitest';
// 2026-09-08 国内库存按站点借用排除（spec: docs/superpowers/specs/
// 2026-09-08-domestic-borrowing-exclusion-design.md）。
// 国内自营仓名按站点编码（仓树实测）：CN_A_US、CN_B_DE、CN_B_UK、CN_A_Tiktok、
// CN_A_TEMU、CN_C_WMSP……解析末段码归组；解析不出的通用仓（CN-独立站、
// CN_DISTRIBUTION 等）默认可借不可勾除。
import { parseDomesticSiteGroup, domesticNonLendable, transferSourceCapacity, transferSourceWarning } from '../domestic-pool';

describe('parseDomesticSiteGroup（仓名末段码 → 站点组）', () => {
  it('单国码直映射：CN_A_US→US、CN_B_UK→UK、CN_C_CA→CA、CN_A_AE→AE', () => {
    expect(parseDomesticSiteGroup('CN_A_US')).toBe('US');
    expect(parseDomesticSiteGroup('CN_B_UK')).toBe('UK');
    expect(parseDomesticSiteGroup('CN_C_CA')).toBe('CA');
    expect(parseDomesticSiteGroup('CN_A_AE')).toBe('AE');
  });

  it('EU_COUNTRIES 成员码都归 EU 组（DE/ES/FR/IT，将来 NL/BE 建仓自动并入）；UK 不并', () => {
    expect(parseDomesticSiteGroup('CN_B_DE')).toBe('EU');
    expect(parseDomesticSiteGroup('CN_B_ES')).toBe('EU');
    expect(parseDomesticSiteGroup('CN_B_FR')).toBe('EU');
    expect(parseDomesticSiteGroup('CN_B_IT')).toBe('EU');
    expect(parseDomesticSiteGroup('CN_B_NL')).toBe('EU');
    expect(parseDomesticSiteGroup('CN_B_UK')).not.toBe('EU');
  });

  it('平台仓：Tiktok/TIKTOK→TikTok、TEMU→TEMU、WMSP→Walmart（大小写不敏感）', () => {
    expect(parseDomesticSiteGroup('CN_A_Tiktok')).toBe('TikTok');
    expect(parseDomesticSiteGroup('CN_DE_TIKTOK')).toBe('TikTok');
    expect(parseDomesticSiteGroup('CN_A_TEMU')).toBe('TEMU');
    expect(parseDomesticSiteGroup('CN_C_WMSP')).toBe('Walmart');
  });

  it('解析不出返回 null（通用仓默认可借）：CN-独立站 / CN_DISTRIBUTION / CN-MS-TEMU / GZ_ZFH', () => {
    expect(parseDomesticSiteGroup('CN-独立站')).toBeNull();
    expect(parseDomesticSiteGroup('CN_DISTRIBUTION')).toBeNull();
    expect(parseDomesticSiteGroup('CN-MS-TEMU')).toBeNull();
    expect(parseDomesticSiteGroup('GZ_ZFH')).toBeNull();
    expect(parseDomesticSiteGroup('CN-宁波备品仓')).toBeNull();
  });

  it('非 CN 前缀仓名不归组（FBA/中转仓名防误伤）', () => {
    expect(parseDomesticSiteGroup('Yaoshu:US_FBA')).toBeNull();
    expect(parseDomesticSiteGroup('云途云仓(东莞仓):YunTu')).toBeNull();
    expect(parseDomesticSiteGroup('杭州仓')).toBeNull();
  });
});

describe('domesticNonLendable（勾选组的国内仓扣减数）', () => {
  const detail = [
    { name: 'CN_A_US', available: 300 },
    { name: 'CN_B_DE', available: 120 },
    { name: 'CN_B_ES', available: 30 },
    { name: 'CN_B_UK', available: 80 },
    { name: 'CN_A_Tiktok', available: 15 },
    { name: 'CN-独立站', available: 40 },          // 通用仓：任何组都不扣
    { name: 'Yaoshu:US_FBA', available: 999 },      // FBA 行防误伤
  ];

  it('不勾选 = 0（现状行为）', () => {
    expect(domesticNonLendable(detail, new Set())).toBe(0);
  });

  it('勾 US = CN_A_US 的 300', () => {
    expect(domesticNonLendable(detail, new Set(['US']))).toBe(300);
  });

  it('勾 EU = 欧洲成员仓求和（DE 120 + ES 30 = 150，UK 不并）', () => {
    expect(domesticNonLendable(detail, new Set(['EU']))).toBe(150);
  });

  it('多组勾选求和：US + EU + UK + TikTok = 300+150+80+15', () => {
    expect(domesticNonLendable(detail, new Set(['US', 'EU', 'UK', 'TikTok']))).toBe(545);
  });

  it('明细缺 available 字段按 0；空明细 = 0', () => {
    expect(domesticNonLendable([{ name: 'CN_A_US' }], new Set(['US']))).toBe(0);
    expect(domesticNonLendable(undefined, new Set(['US']))).toBe(0);
  });
});

describe('transferSourceCapacity（调拨来源可动用 = 国内可用 − 预占 − 不可借）', () => {
  it('正常扣减：500 − 80(预占) − 300(不可借) = 120', () => {
    expect(transferSourceCapacity(500, 80, 300)).toBe(120);
  });

  it('不足扣为负时归零（可动用不为负数）', () => {
    expect(transferSourceCapacity(100, 80, 300)).toBe(0);
  });
});

describe('transferSourceWarning（建议调拨量超出国内可动用时的警告行）', () => {
  it('建议量 500 > 可动用 200 → 警告行带三个数', () => {
    expect(transferSourceWarning(500, 500, 80, 300))
      .toBe('⚠ 建议调拨 500 超出国内可动用 120（不可借已扣 300），需协调或分批调拨');
  });

  it('建议量 ≤ 可动用 → null（不打扰）', () => {
    expect(transferSourceWarning(100, 500, 80, 300)).toBeNull();
    expect(transferSourceWarning(120, 500, 80, 300)).toBeNull();   // 恰好等于不警告
  });

  it('无勾选但建议量超出 可用−预占 也警告（可行性校验与勾选无关， paren 省略）', () => {
    expect(transferSourceWarning(500, 500, 80, 0))
      .toBe('⚠ 建议调拨 500 超出国内可动用 420，需协调或分批调拨');
  });
});
