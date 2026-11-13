// modules/purchase-plan-generator/submit-plan.ts
// Direct API submission — calls createPlanItemGroup + newCreatePlan
// to save purchase plan drafts without DOM manipulation.

import { readErpJson, ErpApiError } from '../../shared/erp-errors';

interface PlanSku {
  sku: string;
  productName: string;
  planQty: number;
  deliveryDate: string;
  productNote: string;
  boxQty: number;
}

interface SubmitPayload {
  warehouseId: number;
  scope: string;        // "US:XIUMEI-GLOBAL" or "global"
  storeId: number;
  remark: string;
  skus: PlanSku[];
  authToken: string;
}

const GATEWAY = 'https://gateway.apist.gerpgo.com';

async function apiPost(token: string, path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(body),
    // 无超时的提交会让按钮永久停在"保存中…"，且无法区分错误
    signal: AbortSignal.timeout(30_000),
  });
  try {
    return await readErpJson(resp, '采购计划提交接口');
  } catch (e) {
    if (e instanceof ErpApiError) throw e;
    throw new Error(`提交接口 ${path} 返回了非 JSON 响应（可能已过期，请刷新页面重试）`);
  }
}

export async function submitPurchasePlan(payload: SubmitPayload): Promise<string[]> {
  const { warehouseId, scope, storeId, remark, skus, authToken } = payload;

  // Build items
  const items = skus.map(sku => ({
    sku: sku.sku,
    quantity: sku.planQty,
    singleQuantity: sku.boxQty || undefined,
    packageQuantity: sku.boxQty ? Math.ceil(sku.planQty / sku.boxQty) : undefined,
    arrivalWarehouseId: warehouseId,
    arrivalMarketId: scope !== 'global' ? storeId : 0,
    expectDeliveryDate: sku.deliveryDate || undefined,
    transportId: 0,
    memo: sku.productNote || undefined,
  }));

  // Step 1: Validate and group
  const groupResult = await apiPost(authToken, '/supply/srm/purchase/plan/createPlanItemGroup', { items });

  if (groupResult.error || !groupResult.data?.length) {
    throw new Error(groupResult.messages?.[0] || '数据验证失败');
  }

  // Step 2: Create draft plan
  const planPayload = {
    memo: remark || '',
    attachmentIds: [],
    groupItems: groupResult.data.map((g: any) => ({ items: g.groupItems })),
  };

  const createResult = await apiPost(authToken, '/supply/srm/purchase/plan/newCreatePlan', planPayload);

  if (createResult.error || createResult.code !== 0) {
    throw new Error(createResult.messages?.[0] || '创建计划失败');
  }

  return createResult.data as string[]; // e.g. ["PL202608120002"]
}

/** Convenience: submit + return success message with plan IDs */
export async function submitAndReport(
  warehouseId: number,
  warehouseLabel: string,
  scope: string,
  storeId: number,
  remark: string,
  skus: PlanSku[],
  authToken: string,
): Promise<{ success: boolean; planIds: string[]; message: string }> {
  try {
    const planIds = await submitPurchasePlan({
      warehouseId,
      scope,
      storeId,
      remark: remark || '',
      skus,
      authToken,
    });

    return {
      success: true,
      planIds,
      message: `草稿已保存！计划编号: ${planIds.join(', ')}`,
    };
  } catch (e: any) {
    return {
      success: false,
      planIds: [],
      message: `保存失败: ${e.message || '未知错误'}`,
    };
  }
}
