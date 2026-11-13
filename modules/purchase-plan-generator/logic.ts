import type { StreamEvent } from '../types';

export async function* purchasePlanGeneratorHandler(
  _payload: unknown,
  _signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  yield { type: 'error', message: 'Generator runs directly in content script' };
}
