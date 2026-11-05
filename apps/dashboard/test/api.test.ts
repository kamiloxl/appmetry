import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api';

const assign = vi.fn();

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('window', { location: { assign, pathname: '/' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('returns parsed JSON and sends same-origin credentials', async () => {
    respond(200, [{ id: 'a' }]);
    await expect(api('/api/apps')).resolves.toEqual([{ id: 'a' }]);
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.credentials).toBe('same-origin');
  });

  it('sends a JSON body with a content type', async () => {
    respond(201, { id: 'a' });
    await api('/api/apps', { method: 'POST', json: { name: 'x' } });
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{"name":"x"}');
  });

  it('throws ApiError with status and the server message', async () => {
    respond(400, { error: 'name must be a string' });
    const err = (await api('/api/apps', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('name must be a string');
    expect(assign).not.toHaveBeenCalled();
  });

  it('redirects to /login on a 401 from a data route', async () => {
    respond(401, { error: 'unauthorized' });
    await expect(api('/api/apps')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('does not redirect on a 401 from /api/auth/*', async () => {
    respond(401, { error: 'Wrong password' });
    await expect(api('/api/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 401, message: 'Wrong password' });
    expect(assign).not.toHaveBeenCalled();
  });
});
