import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const routerReplace = vi.fn();
const routerPush = vi.fn();
const clearCachedData = vi.fn();
const handleError = vi.fn();

vi.mock('../../src/router', () => ({
  default: {
    push: routerPush,
    replace: routerReplace,
    currentRoute: {
      value: {
        path: '/dashboard'
      }
    }
  }
}));

vi.mock('../../src/lib/api', () => ({
  fetchInitialData: vi.fn(),
  login: vi.fn(),
  fetchPublicConfig: vi.fn()
}));

vi.mock('../../src/lib/http.js', () => ({
  api: {
    get: vi.fn()
  }
}));

vi.mock('../../src/utils/errorHandler.js', () => ({
  handleError
}));

vi.mock('../../src/stores/useDataStore', () => ({
  useDataStore: () => ({
    hydrateFromData: vi.fn(),
    clearCachedData
  })
}));

describe('session store auth expiry handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routerReplace.mockReset();
    routerPush.mockReset();
    clearCachedData.mockReset();
    handleError.mockReset();
  });

  it('redirects to the configured login path on real session expiry', async () => {
    const { useSessionStore } = await import('../../src/stores/session.js');
    const store = useSessionStore();

    store.publicConfig = {
      ...store.publicConfig,
      customLoginPath: 'signin'
    };

    await store.handleSessionExpired();

    expect(clearCachedData).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith({ path: '/signin' });
    expect(store.sessionState).toBe('loggedOut');
    expect(store.initialData).toBeNull();
  });

  it('only handles the same expiry burst once', async () => {
    const { useSessionStore } = await import('../../src/stores/session.js');
    const store = useSessionStore();

    await store.handleSessionExpired();
    await store.handleSessionExpired();

    expect(clearCachedData).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });
});
