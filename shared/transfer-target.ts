// shared/transfer-target.ts
// 调拨目标市场解析（2026-08-28 评审建议从 ui.ts 抽出为纯函数以便单测——
// 该优先级链是"选 US_FBA/EU_FBA 却分析了 AE/UK"bug 修复的核心逻辑）。
// 数据源优先级（用户确认口径）：
// ① 调入仓库（主数据源，仓名自带答案：Yaoshu:EU_FBA → 店铺 Yaoshu + 区域 EU；
//    "平台站点"控件是条件渲染且可能为空）
// ② 平台站点控件兜底（三段式 AMAZON:Yaoshu:DE 取末两段；两段式 Yaoshu:DE）
// ③ 都无 → none（UI 层打警告，不再静默回落销量最高市场）
// 手动输入不在此层：ui 层用 dirty 标记保护，本函数只产出自动填充值。
// 纯函数无跨轮询状态——仓库切走/清空后自然回落兜底，不会残留旧仓答案。
import { parseFbaWarehouse } from './fba-warehouse';

export interface TransferTarget {
  /** 国家码或区域码（EU），统一大写；'' = 未识别 */
  country: string;
  /** 店铺码（原始大小写，库存仓行归属过滤用）；无来源时 undefined */
  store: string | undefined;
  source: 'warehouse' | 'form' | 'none';
}

export function resolveTransferTarget(warehouseLabel: string, formSiteLabel: string): TransferTarget {
  const whVal = (warehouseLabel || '').trim();
  const fw = whVal ? parseFbaWarehouse(whVal) : null;
  if (fw) return { country: fw.region, store: fw.store, source: 'warehouse' };
  const seg = (formSiteLabel || '').split(':').map(s => s.trim()).filter(Boolean);
  if (seg.length >= 2) {
    return {
      country: seg[seg.length - 1]!.toUpperCase(),
      store: seg.length >= 3 ? seg[seg.length - 2]! : seg[0]!,
      source: 'form',
    };
  }
  return { country: '', store: undefined, source: 'none' };
}
