// shared/auth.ts
// Reads the x-auth-token from the page's sessionStorage.
// Since the iframe is same-origin, we can access its contentWindow.sessionStorage
// directly without script injection.

let cachedToken: string | null = null;

export function getAuthToken(doc?: Document): string | null {
  if (cachedToken) return cachedToken;
  const win = (doc || document).defaultView;
  if (!win) return null;
  cachedToken = win.sessionStorage.getItem('x-auth-token');
  return cachedToken;
}

export function clearAuthToken(): void {
  cachedToken = null;
}
