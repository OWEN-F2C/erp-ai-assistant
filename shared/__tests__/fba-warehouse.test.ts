import { describe, it, expect } from 'vitest';
import { parseFbaWarehouse, isRegionOfCountry, EU_COUNTRIES } from '../fba-warehouse';

describe('parseFbaWarehouse（FBA 仓名 → 店铺+区域）', () => {
  it('解析 Store:XX_FBA 格式', () => {
    expect(parseFbaWarehouse('Yaoshu:EU_FBA')).toEqual({ store: 'Yaoshu', region: 'EU' });
    expect(parseFbaWarehouse('XIUMEI-GLOBAL:US_FBA')).toEqual({ store: 'XIUMEI-GLOBAL', region: 'US' });
    expect(parseFbaWarehouse('Yaoshu:UK_FBA')).toEqual({ store: 'Yaoshu', region: 'UK' });
    expect(parseFbaWarehouse('SUPRENT_Global:CA_FBA')).toEqual({ store: 'SUPRENT_Global', region: 'CA' });
  });

  it('非 FBA 仓名返回 null', () => {
    expect(parseFbaWarehouse('杭州仓')).toBeNull();
    expect(parseFbaWarehouse('CN_A_Tiktok')).toBeNull();
    expect(parseFbaWarehouse('US-Tiktok-FBT虚拟仓')).toBeNull();
  });
});

describe('isRegionOfCountry（区域归属）', () => {
  it('EU 仓服务欧盟国家，每个国家只匹配一次（防 EFN 共享池重复求和）', () => {
    for (const c of ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE']) {
      expect(isRegionOfCountry('EU', c)).toBe(true);
    }
    expect(isRegionOfCountry('EU', 'UK')).toBe(false); // UK 独立仓
    expect(isRegionOfCountry('EU', 'US')).toBe(false);
  });

  it('非 EU 区域精确匹配国家码', () => {
    expect(isRegionOfCountry('US', 'US')).toBe(true);
    expect(isRegionOfCountry('US', 'CA')).toBe(false);
    expect(isRegionOfCountry('UK', 'UK')).toBe(true);
    expect(isRegionOfCountry('UK', 'DE')).toBe(false);
  });

  it('EU_COUNTRIES 不含 UK/US', () => {
    expect(EU_COUNTRIES).not.toContain('UK');
    expect(EU_COUNTRIES).not.toContain('US');
  });
});
