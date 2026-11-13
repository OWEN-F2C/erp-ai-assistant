import type { EnhancerModule } from '../types';
import { purchasePlanGeneratorHandler } from './logic';
import { render } from './ui';

export const purchasePlanGenerator: EnhancerModule = {
  id: 'purchase-plan-generator',
  name: '采购计划生成器',
  description: 'AI自动生成采购计划，可视化库存曲线，一键提交新增页',
  matches: ['/purchaseplan'],
  ui: { render },
  handler: purchasePlanGeneratorHandler,
};
