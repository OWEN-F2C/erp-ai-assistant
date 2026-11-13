// shared/analysis-log.ts
// Persistent log buffer shared between purchase panel (producer) and dev panel (consumer).
// Survives dev panel mount/unmount cycles so logs accumulate across the page lifetime.

export interface LogEntry {
  ts: number;
  step: string;
  message: string;
}

const logs: LogEntry[] = [];
const listeners: Array<(entry: LogEntry) => void> = [];
const MAX = 200;

export function addLog(step: string, message: string): void {
  const entry: LogEntry = { ts: Date.now(), step, message };
  logs.push(entry);
  if (logs.length > MAX) logs.shift();
  for (const cb of listeners) cb(entry);
}

/** Update the last log entry if its step matches; otherwise append a new one.
 *  Used for continuously updating streaming output (e.g. reasoning chunks)
 *  without flooding the log with individual entries. */
export function updateLastLog(step: string, message: string): void {
  const last = logs[logs.length - 1];
  if (last && last.step === step) {
    last.message = message;
    last.ts = Date.now();
    for (const cb of listeners) cb(last);
  } else {
    addLog(step, message);
  }
}

export function getLogs(): LogEntry[] {
  return [...logs];
}

export function clearLogs(): void {
  logs.length = 0;
}

export function onLog(cb: (entry: LogEntry) => void): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
