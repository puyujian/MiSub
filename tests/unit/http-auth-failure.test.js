import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('src/lib/http auth failure handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { setAuthFailureHandler } = await import('../../src/lib/http.js');
    setAuthFailureHandler(null);
    vi.unstubAllGlobals();
  });

  it('calls the global auth failure handler for protected 401 API responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request, setAuthFailureHandler } = await import('../../src/lib/http.js');
    const handler = vi.fn();
    setAuthFailureHandler(handler);

    await expect(request('/api/misubs')).rejects.toMatchObject({
      name: 'APIError',
      status: 401
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      pathname: '/api/misubs',
      reason: 'http_401'
    }));
  });

  it('does not treat login failures as session expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: '密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request, setAuthFailureHandler } = await import('../../src/lib/http.js');
    const handler = vi.fn();
    setAuthFailureHandler(handler);

    await expect(request('/api/login')).rejects.toMatchObject({
      name: 'APIError',
      status: 401
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('promotes /api/data authenticated:false payloads into auth failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false, message: 'Not logged in' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request, setAuthFailureHandler } = await import('../../src/lib/http.js');
    const handler = vi.fn();
    setAuthFailureHandler(handler);

    await expect(request('/api/data')).rejects.toMatchObject({
      name: 'APIError',
      status: 401
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      pathname: '/api/data',
      reason: 'unauthenticated_payload'
    }));
  });
});
