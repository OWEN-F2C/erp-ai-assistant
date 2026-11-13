// modules/transfer-plan/index.ts
import type { EnhancerModule } from '../types';
import { render } from './ui';
import { transferPlanHandler } from './logic';

export const transferPlan: EnhancerModule = {
  id: 'transfer-plan',
  name: '调拨计划增强',
  description: '在调拨单页注入AI调拨建议',
  matches: ['/wms/transferorderadd'],
  ui: { render },
  handler: transferPlanHandler,
};
