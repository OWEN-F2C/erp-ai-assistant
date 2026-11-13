import { describe, it, expect } from 'vitest';
// 2026-08-28 评审建议：调拨目标市场优先级链（本轮修复的核心逻辑）原先
// 内联在 ui.ts 的 DOM 轮询里无法单测，抽为纯函数。语义与用户确认口径一致：
// ①调入仓库（仓名自带答案）②平台站点兜底 ③都无 → none（UI 层打警告）。
import { resolveTransferTarget } from '../transfer-target';

describe('resolveTransferTarget（调入仓库 → 平台站点 → 无）', () => {
  it('调入仓库 FBA 仓名直读：Yaoshu:EU_FBA → 区域 EU + 店铺 Yaoshu（修 EU_FBA 却分析 UK 的 bug）', () => {
    expect(resolveTransferTarget('Yaoshu:EU_FBA', '')).toEqual({
      country: 'EU', store: 'Yaoshu', source: 'warehouse',
    });
  });

  it('SUPRENT_Global:US_FBA → US + SUPRENT_Global（修 US_FBA 却分析 AE 的 bug）', () => {
    expect(resolveTransferTarget('SUPRENT_Global:US_FBA', '')).toEqual({
      country: 'US', store: 'SUPRENT_Global', source: 'warehouse',
    });
  });

  it('仓库切走/清空/国内仓（解析失败）→ 不残留旧仓答案，走平台站点兜底', () => {
    // 评审发现的残留 bug 场景：先选 EU_FBA 再切杭州仓，旧实现 EU 会持续覆盖
    expect(resolveTransferTarget('杭州仓', 'AMAZON:Yaoshu:DE')).toEqual({
      country: 'DE', store: 'Yaoshu', source: 'form',
    });
    expect(resolveTransferTarget('', 'AMAZON:Yaoshu:DE')).toEqual({
      country: 'DE', store: 'Yaoshu', source: 'form',
    });
  });

  it('平台站点三段式 AMAZON:Yaoshu:DE → 国家=末段 店铺=倒数第二段', () => {
    expect(resolveTransferTarget('', 'AMAZON:Yaoshu:DE')).toEqual({
      country: 'DE', store: 'Yaoshu', source: 'form',
    });
  });

  it('平台站点两段式 Yaoshu:de → 国家末段统一大写，店铺取首段', () => {
    expect(resolveTransferTarget('', 'Yaoshu:de')).toEqual({
      country: 'DE', store: 'Yaoshu', source: 'form',
    });
  });

  it('仓库优先于平台站点（两个都有值时）', () => {
    expect(resolveTransferTarget('Yaoshu:UK_FBA', 'AMAZON:Yaoshu:DE')).toEqual({
      country: 'UK', store: 'Yaoshu', source: 'warehouse',
    });
  });

  it('两者都无 → none（UI 层据此打警告，不再静默回落销量最高市场）', () => {
    expect(resolveTransferTarget('', '')).toEqual({
      country: '', store: undefined, source: 'none',
    });
    expect(resolveTransferTarget('杭州仓', '请选择')).toEqual({
      country: '', store: undefined, source: 'none',
    });
  });
});
