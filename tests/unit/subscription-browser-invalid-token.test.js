import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAdapter = vi.hoisted(() => vi.fn());
const getStorageType = vi.hoisted(() => vi.fn());
const authMiddleware = vi.hoisted(() => vi.fn());
const isBrowserAgent = vi.hoisted(() => vi.fn());
const resolveRequestContext = vi.hoisted(() => vi.fn());

vi.mock('../../functions/storage-adapter.js', () => ({
  StorageFactory: {
    createAdapter: (...args) => createAdapter(...args),
    getStorageType: (...args) => getStorageType(...args)
  }
}));

vi.mock('../../functions/modules/auth-middleware.js', () => ({
  authMiddleware: (...args) => authMiddleware(...args)
}));

vi.mock('../../functions/modules/subscription/user-agent-utils.js', () => ({
  isBrowserAgent: (...args) => isBrowserAgent(...args),
  determineTargetFormat: vi.fn().mockReturnValue('base64'),
  isMetaCore: vi.fn().mockReturnValue(false)
}));

vi.mock('../../functions/modules/subscription/request-context.js', () => ({
  resolveRequestContext: (...args) => resolveRequestContext(...args)
}));

describe('subscription browser invalid token fallback', () => {
  beforeEach(() => {
    createAdapter.mockReset();
    getStorageType.mockReset();
    authMiddleware.mockReset();
    isBrowserAgent.mockReset();
    resolveRequestContext.mockReset();

    getStorageType.mockResolvedValue('kv');
    createAdapter.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        mytoken: 'real-token',
        profileToken: 'profiles',
        customLoginPath: 'signin'
      }),
      getAllSubscriptions: vi.fn().mockResolvedValue([]),
      getAllProfiles: vi.fn().mockResolvedValue([])
    });
    isBrowserAgent.mockReturnValue(true);
    resolveRequestContext.mockReturnValue({
      token: 'stale-token',
      profileIdentifier: null
    });
  });

  it('sends authenticated browsers back to dashboard instead of raw Invalid Token', async () => {
    authMiddleware.mockResolvedValue(true);
    const { handleMisubRequest } = await import('../../functions/modules/subscription/main-handler.js');

    const response = await handleMisubRequest({
      request: new Request('https://example.com/stale-token'),
      env: {},
      waitUntil: vi.fn()
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://example.com/dashboard');
  });

  it('sends unauthenticated browsers to the login route', async () => {
    authMiddleware.mockResolvedValue(false);
    const { handleMisubRequest } = await import('../../functions/modules/subscription/main-handler.js');

    const response = await handleMisubRequest({
      request: new Request('https://example.com/stale-token'),
      env: {},
      waitUntil: vi.fn()
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://example.com/signin');
  });
});
