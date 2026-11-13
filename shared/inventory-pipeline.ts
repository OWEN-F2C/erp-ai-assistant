// shared/inventory-pipeline.ts
// 调拨发运管线（2026-09-08 调查锤定，字段语义见 AGENTS.md"调拨发运管线口径"节）：
//   在途量 inTransitQty 是货件口径（货件已发货+正在接收），与发货单四阶段管线
//   （待出库 erpWorking / 待出运 erpWaitShipped / 已发货 erpShipped / 待入库 erpReceiving，
//   四阶段按目的仓行归属）是两套账——同一批货可能在两边都有数 → 用 max 去重
//   （实测 6 个 FBA 行全部 在途 ≤ 管线，支持子集关系）。
//   待出运不在任何可用量/在途/已发货里（云途 48>avail 28 反证系统性包含），独立相加。
//   待出库的货仍在源仓可用量里：采购总盘视角必排除（计入即双计）；
//   调拨调入仓视角由调用方另行加本仓 erpWorking（结论二）——故本函数不含 working。

/** 管线字段的子集（库存行 / warehouseDetail 明细均可喂进来） */
export interface PipelineRow {
  inTransitQty?: number | null;
  erpShipped?: number | null;
  erpReceiving?: number | null;
  erpWaitShipped?: number | null;
}

/** 行级未来在途 = max(货件在途, 已发货+待入库) + 待出运；字段缺失按 0 */
export function rowFutureInTransit(row: PipelineRow): number {
  const pipeline = (row.erpShipped || 0) + (row.erpReceiving || 0);
  return Math.max(row.inTransitQty || 0, pipeline) + (row.erpWaitShipped || 0);
}
