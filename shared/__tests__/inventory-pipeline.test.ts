import { describe, it, expect } from 'vitest';
// 2026-09-08 调拨发运管线口径（AGENTS.md"调拨发运管线口径"节）：
//   在途量 inTransitQty 是货件口径（Amazon 货件已发货+正在接收），与发货单四阶段
//   （待出库/待出运/已发货/待入库）是两套账，同货可能双记 → max 去重；
//   待出运 erpWaitShipped 不在任何在途/已发货里（云途 48>avail 28 反证），独立相加。
//   待出库 erpWorking 的货仍在源仓可用量里：采购总盘视角必排除（双计）、
//   调拨调入仓视角计入（结论二，用户拍板）——所以 rowFutureInTransit 不含 working。
import { rowFutureInTransit } from '../inventory-pipeline';
import { parseFbaWarehouse } from '../fba-warehouse';
import { attributedFba } from '../jijia-data';

describe('rowFutureInTransit = max(在途, 已发货+待入库) + 待出运', () => {
  it('货件在途 < 已发货+待入库 → 取大者（实测形态 在途336/管线240+120=360 → 360）', () => {
    expect(rowFutureInTransit({ inTransitQty: 336, erpShipped: 240, erpReceiving: 120, erpWaitShipped: 0 })).toBe(360);
  });

  it('货件在途 > 已发货+待入库 → 取货件在途（100 vs 80 → 100）', () => {
    expect(rowFutureInTransit({ inTransitQty: 100, erpShipped: 30, erpReceiving: 50, erpWaitShipped: 0 })).toBe(100);
  });

  it('货件在途 0、管线有值 → 管线值（实测形态 0/264 → 264）', () => {
    expect(rowFutureInTransit({ inTransitQty: 0, erpShipped: 240, erpReceiving: 24, erpWaitShipped: 0 })).toBe(264);
  });

  it('待出运独立相加：云途中转形态 max(0,0)+48 = 48；组合形态 360+48 = 408', () => {
    expect(rowFutureInTransit({ inTransitQty: 0, erpShipped: 0, erpReceiving: 0, erpWaitShipped: 48 })).toBe(48);
    expect(rowFutureInTransit({ inTransitQty: 336, erpShipped: 240, erpReceiving: 120, erpWaitShipped: 48 })).toBe(408);
  });

  it('字段缺失按 0 处理（接口未回传管线字段的旧行为不变）', () => {
    expect(rowFutureInTransit({})).toBe(0);
    expect(rowFutureInTransit({ inTransitQty: 5 })).toBe(5);
  });
});

describe('parseFbaWarehouse 放宽 _FBT 后缀（TIKTOK_FBT 语义 = FBA/WFS，用户口径）', () => {
  it('SUPRENT-TK-US:US_FBT → 店铺 SUPRENT-TK-US、区域 US', () => {
    expect(parseFbaWarehouse('SUPRENT-TK-US:US_FBT')).toEqual({ store: 'SUPRENT-TK-US', region: 'US' });
  });

  it('_FBA 解析不回归（Yaoshu:EU_FBA → EU 区域）', () => {
    expect(parseFbaWarehouse('Yaoshu:EU_FBA')).toEqual({ store: 'Yaoshu', region: 'EU' });
  });

  it('非 FBA/FBT 仓名仍返回 null', () => {
    expect(parseFbaWarehouse('杭州仓')).toBeNull();
    expect(parseFbaWarehouse('Yaoshu:US_WFS')).toBeNull();
  });
});

describe('attributedFba 携带管线（在途=未来供给口径，working 单列不计入）', () => {
  it('inTransit = Σ rowFutureInTransit（max 去重 + 待出运），erpWorking 不并入', () => {
    const r = attributedFba([
      { name: 'Yaoshu:US_FBA', available: 10, inTransit: 336, reserved: 0, shipped: 240, receiving: 120, waitShipped: 48, working: 288 },
    ], 'Yaoshu', 'US');
    expect(r.inTransit).toBe(408);          // max(336, 360) + 48
    expect(r.available).toBe(10);
    expect(r.working).toBe(288);            // 调拨侧单独加，采购侧不用
  });

  it('匹配仓的管线分量（shipped/receiving/waitShipped）随归属返回', () => {
    const r = attributedFba([
      { name: 'Yaoshu:US_FBA', available: 0, inTransit: 0, reserved: 0, shipped: 240, receiving: 24, waitShipped: 12, working: 5 },
      { name: 'Other:US_FBA', available: 99, inTransit: 0, reserved: 0, shipped: 7, receiving: 7, waitShipped: 7, working: 7 }, // 别家店铺
    ], 'Yaoshu', 'US');
    expect(r.shipped).toBe(240);
    expect(r.receiving).toBe(24);
    expect(r.waitShipped).toBe(12);
    expect(r.working).toBe(5);
  });

  it('无管线字段的仓明细行为不变（旧调用方回归）', () => {
    const r = attributedFba([
      { name: 'Yaoshu:US_FBA', available: 10, inTransit: 4 },
    ], 'Yaoshu', 'US');
    expect(r.inTransit).toBe(4);
    expect(r.working).toBe(0);
  });
});
