export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Options for api(): `json` is serialised as the body with a JSON content type. */
export type ApiInit = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null };

/**
 * fetch + JSON. Sends the session cookie, throws ApiError(status, server's `{error}`), and sends the browser to
 * /login on a 401 from any route except /api/auth/* (login itself answers 401 for a wrong password).
 */
export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.location.assign('/login');
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : res.statusText || `HTTP ${res.status}`);
  }
  return data as T;
}
