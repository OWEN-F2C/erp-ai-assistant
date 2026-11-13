// modules/purchase-plan/index.ts
import type { EnhancerModule } from '../types';
import { render } from './ui';
import { purchasePlanHandler } from './logic';

export const purchasePlan: EnhancerModule = {
  id: 'purchase-plan',
  name: '采购计划增强',
  description: '在采购计划页注入销售数据列和AI采购建议',
  matches: ['/purchase'],
  ui: { render },
  handler: purchasePlanHandler,
};
