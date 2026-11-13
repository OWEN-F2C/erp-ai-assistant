// modules/index.ts
import type { EnhancerModule } from './types';

const registry = new Map<string, EnhancerModule>();

export function registerModule(mod: EnhancerModule): void {
  registry.set(mod.id, mod);
}

export function getModuleById(id: string): EnhancerModule | undefined {
  return registry.get(id);
}
