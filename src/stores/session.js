
import { ref } from 'vue';
import { defineStore } from 'pinia';
import router from '../router';
import { fetchInitialData, login as apiLogin, fetchPublicConfig } from '../lib/api';
import { api } from '../lib/http.js';
import { handleError } from '../utils/errorHandler.js';
import { useDataStore } from './useDataStore';

export const useSessionStore = defineStore('session', () => {
  const sessionState = ref('loading'); // loading, loggedIn, loggedOut
  const initialData = ref(null);
  const subscriptionConfig = ref({}); // [NEW] Added subscriptionConfig
  let hasHandledSessionExpiry = false;
  const publicConfig = ref({
    enablePublicPage: true,
    customPage: {
      enabled: false,
      useDefaultLayout: true,
      allowExternalStylesheets: false,
      allowScripts: false,
      hideBranding: false,
      hideHeader: false,
      hideFooter: false
    }
  }); // Default true until fetched

  function normalizeLoginPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return '/login';
    const normalized = rawPath.trim().replace(/^\/+/, '');
    return normalized && normalized !== 'login' ? `/${normalized}` : '/login';
  }

  function getLoginPath() {
    return normalizeLoginPath(publicConfig.value?.customLoginPath);
  }

  function clearSessionState() {
    sessionState.value = 'loggedOut';
    initialData.value = null;
    subscriptionConfig.value = {};

    const dataStore = useDataStore();
    dataStore.clearCachedData();
  }

  function markSessionActive() {
    hasHandledSessionExpiry = false;
  }

  async function handleSessionExpired(options = {}) {
    const { notify = true, message = '登录状态已失效，请重新登录' } = options;
    if (hasHandledSessionExpiry) return;

    hasHandledSessionExpiry = true;
    clearSessionState();

    if (notify) {
      handleError(new Error(message), '会话失效', { errorType: 'auth' });
    }

    const targetPath = getLoginPath();
    if (router.currentRoute?.value?.path !== targetPath) {
      await router.replace({ path: targetPath });
    }
  }

  async function checkSession() {
    // Parallel fetch of initial data (auth check) and public config
    const [dataResult, pConfigResult] = await Promise.all([
      fetchInitialData(),
      fetchPublicConfig()
    ]);

    // Update public config
    if (pConfigResult.success) {
      publicConfig.value = pConfigResult.data;
    } else {
      // Fallback to default if fetch fails
      publicConfig.value = {
        enablePublicPage: false,
        customPage: {
          enabled: false,
          allowExternalStylesheets: false,
          allowScripts: false,
          hideBranding: false,
          hideHeader: false,
          hideFooter: false
        }
      };
    }

    if (dataResult.success) {
      markSessionActive();
      initialData.value = dataResult.data;
      if (dataResult.data.config) {
        subscriptionConfig.value = dataResult.data.config;
      }

      // 直接注入数据到 dataStore，避免 Dashboard 重复请求
      const dataStore = useDataStore();
      dataStore.hydrateFromData(dataResult.data);

      sessionState.value = 'loggedIn';
    } else {
      // Auth failed or other error
      if (dataResult.errorType === 'auth') {
        clearSessionState();
      } else {
        // Network or other error, still show logged out
        console.error("Session check failed:", dataResult.error);
        handleError(new Error(dataResult.error || '会话检查失败'), '会话检查', {
          errorType: dataResult.errorType
        });
        clearSessionState();
      }
    }
  }

  async function login(password) {
    const result = await apiLogin(password);
    if (result.success) {
      handleLoginSuccess();
      // 登录成功后跳转到仪表盘
      router.push({ path: '/dashboard' });
    } else {
      throw new Error(result.error || '登录失败');
    }
  }

  function handleLoginSuccess() {
    markSessionActive();
    sessionState.value = 'loading';
    checkSession();
  }

  async function logout() {
    try {
      await api.get('/api/logout');
    } catch (error) {
      console.warn('Logout request failed:', error);
    }
    markSessionActive();
    clearSessionState();

    // 跳转到首页（公开页）
    router.push({ path: '/' });
  }

  return {
    sessionState,
    initialData,
    publicConfig,
    subscriptionConfig,
    checkSession,
    login,
    logout,
    handleSessionExpired
  };
});
