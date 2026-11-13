// shared/status.ts
//
// Toolbar icon status manager for ERP enhancer extension.
// Maps extension health to icon color and provides priority-based resolution.

export const IconStatus = {
  OK: 'blue',
  NO_API_KEY: 'yellow',
  SESSION_EXPIRED: 'red',
} as const;

export type IconStatusType = (typeof IconStatus)[keyof typeof IconStatus];

// Priority: red > yellow > blue
export function resolveStatus(
  sessionExpired: boolean,
  hasApiKey: boolean,
): IconStatusType {
  if (sessionExpired) return 'red';
  if (!hasApiKey) return 'yellow';
  return 'blue';
}

export async function updateIconStatus(status: IconStatusType): Promise<void> {
  const path16 = `/icons/icon-${status}-16.png`;
  const path32 = `/icons/icon-${status}-32.png`;
  await chrome.action.setIcon({
    path: { '16': path16, '32': path32 },
  });
}
