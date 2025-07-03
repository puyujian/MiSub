import yaml from 'js-yaml';

const OLD_KV_KEY = 'misub_data_v1';
const KV_KEY_SUBS = 'misub_subscriptions_v1';
const KV_KEY_PROFILES = 'misub_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const COOKIE_NAME = 'auth_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

// --- [新] 默认设置中增加通知阈值 ---
const defaultSettings = {
  FileName: 'MiSub',
  mytoken: 'auto',
  profileToken: 'profiles',
  subConverter: 'url.v1.mk',
  subConfig: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini',
  prependSubName: true,
  NotifyThresholdDays: 3, 
  NotifyThresholdPercent: 90 
};

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes || bytes < 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // toFixed(dm) after dividing by pow(k, i) was producing large decimal numbers
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return '0 B'; // Handle log(0) case
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// --- TG 通知函式 (无修改) ---
async function sendTgNotification(settings, message) {
  if (!settings.BotToken || !settings.ChatID) {
    console.log("TG BotToken or ChatID not set, skipping notification.");
    return false;
  }
  // 为所有消息添加时间戳
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;
  
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  const payload = { 
    chat_id: settings.ChatID, 
    text: fullMessage, 
    parse_mode: 'Markdown',
    disable_web_page_preview: true // 禁用链接预览，使消息更紧凑
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      console.log("TG notification sent successfully.");
      return true;
    } else {
      const errorData = await response.json();
      console.error("Failed to send TG notification:", response.status, errorData);
      return false;
    }
  } catch (error) {
    console.error("Error sending TG notification:", error);
    return false;
  }
}

async function handleCronTrigger(env) {
    console.log("Cron trigger fired. Checking all subscriptions...");
    const allSubs = await env.MISUB_KV.get(KV_KEY_SUBS, 'json') || [];
    const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
    let changesMade = false;

    for (const sub of allSubs) {
        if (sub.url.startsWith('http') && sub.enabled) {
            // 複用 /api/node_count 的流量獲取邏輯
            try {
                const trafficRequest = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow" }));
                const response = await Promise.race([trafficRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))]);

                if (response.ok) {
                    const userInfoHeader = response.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        sub.userInfo = info; // 更新流量信息
                        await checkAndNotify(sub, settings, env); // 檢查並發送通知
                        changesMade = true;
                    }
                }
            } catch(e) {
                console.error(`Cron: Failed to update ${sub.name}`, e.message);
            }
        }
    }

    // 如果有任何通知時間戳被更新，則保存回 KV
    if (changesMade) {
        await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
        console.log("Subscription notification timestamps updated.");
    }
    return new Response("Cron job finished.", { status: 200 });
}

// --- 认证与API处理的核心函数 (无修改) ---
async function createSignedToken(key, data) {
    if (!key || !data) throw new Error("Key and data are required for signing.");
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const dataToSign = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataToSign);
    return `${data}.${Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
async function verifySignedToken(key, token) {
    if (!key || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data] = parts;
    const expectedToken = await createSignedToken(key, data);
    return token === expectedToken ? data : null;
}
async function authMiddleware(request, env) {
    if (!env.COOKIE_SECRET) return false;
    const cookie = request.headers.get('Cookie');
    const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
    if (!sessionCookie) return false;
    const token = sessionCookie.split('=')[1];
    const verifiedData = await verifySignedToken(env.COOKIE_SECRET, token);
    return verifiedData && (Date.now() - parseInt(verifiedData, 10) < SESSION_DURATION);
}

// sub: 要检查的订阅对象
// settings: 全局设置
// env: Cloudflare 环境
async function checkAndNotify(sub, settings, env) {
    if (!sub.userInfo) return; // 没有流量信息，无法检查

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 1. 检查订阅到期
    if (sub.userInfo.expire) {
        const expiryDate = new Date(sub.userInfo.expire * 1000);
        const daysRemaining = Math.ceil((expiryDate - now) / ONE_DAY_MS);
        
        // 检查是否满足通知条件：剩余天数 <= 阈值
        if (daysRemaining <= (settings.NotifyThresholdDays || 7)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
                const message = `🗓️ *订阅临期提醒* 🗓️\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`${daysRemaining < 0 ? '已过期' : `仅剩 ${daysRemaining} 天到期`}\`\n*到期日期:* \`${expiryDate.toLocaleDateString('zh-CN')}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedExpire = now; // 更新通知时间戳
                }
            }
        }
    }

    // 2. 检查流量使用
    const { upload, download, total } = sub.userInfo;
    if (total > 0) {
        const used = upload + download;
        const usagePercent = Math.round((used / total) * 100);

        // 检查是否满足通知条件：已用百分比 >= 阈值
        if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
                const formatBytes = (bytes) => {
                    if (!+bytes) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
                };
                
                const message = `📈 *流量预警提醒* 📈\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`已使用 ${usagePercent}%\`\n*详情:* \`${formatBytes(used)} / ${formatBytes(total)}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedTraffic = now; // 更新通知时间戳
                }
            }
        }
    }
}


// --- 主要 API 請求處理 ---
async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    // [新增] 安全的、可重复执行的迁移接口
    if (path === '/migrate') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
        try {
            const oldData = await env.MISUB_KV.get(OLD_KV_KEY, 'json');
            const newDataExists = await env.MISUB_KV.get(KV_KEY_SUBS) !== null;

            if (newDataExists) {
                return new Response(JSON.stringify({ success: true, message: '无需迁移，数据已是最新结构。' }), { status: 200 });
            }

            if (!oldData) {
                return new Response(JSON.stringify({ success: false, message: '未找到需要迁移的旧数据。' }), { status: 404 });
            }
            
            await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
            await env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
            
            // 将旧键重命名，防止重复迁移
            await env.MISUB_KV.put(OLD_KV_KEY + '_migrated_on_' + new Date().toISOString(), JSON.stringify(oldData));
            await env.MISUB_KV.delete(OLD_KV_KEY);

            return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }), { status: 200 });

        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: `迁移失败: ${e.message}` }), { status: 500 });
        }
    }


    if (path !== '/login') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
    }

    try {
        switch (path) {
            case '/login': {
                if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
                const { password } = await request.json();
                if (password === env.ADMIN_PASSWORD) {
                    const token = await createSignedToken(env.COOKIE_SECRET, String(Date.now()));
                    const headers = new Headers({ 'Content-Type': 'application/json' });
                    headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
                    return new Response(JSON.stringify({ success: true }), { headers });
                }
                return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
            }
            case '/logout': {
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            // [修改] /data 接口，现在需要读取多个KV值
            case '/data': {
                // [最终修正] 如果 KV.get 返回 null (键不存在), 则使用 `|| []` 来确保得到的是一个空数组，防止崩溃
                const [misubs, profiles, settings] = await Promise.all([
                    env.MISUB_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {})
                ]);
                const config = { 
                    FileName: settings.FileName || 'MISUB', 
                    mytoken: settings.mytoken || 'auto',
                    profileToken: settings.profileToken || 'profiles' // 將 profileToken 也返回給前端
                };
                  return new Response(JSON.stringify({ misubs, profiles, config }), { headers: { 'Content-Type': 'application/json' } });
            }
            case '/misubs': {
                // [优化] 保存数据后，触发一次全面的检查
                const { misubs, profiles } = await request.json();
                if (typeof misubs === 'undefined' || typeof profiles === 'undefined') {
                    return new Response(JSON.stringify({ success: false, message: '请求体中缺少 misubs 或 profiles 字段' }), { status: 400 });
                }
                
                // 获取最新设置用于通知
                const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;

                // 遍历所有订阅进行检查
                for (const sub of misubs) {
                    if (sub.url.startsWith('http')) {
                        await checkAndNotify(sub, settings, env);
                    }
                }

                // 保存更新后的数据（包含了 lastNotified 时间戳）
                await Promise.all([
                    env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(misubs)),
                    env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
                ]);
                
                return new Response(JSON.stringify({ success: true, message: '订阅源及订阅组已保存' }));
            }
            case '/node_count': {
                // [优化] 更新单个订阅后，立即检查并通知
                if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
                const { url: subUrl } = await request.json();
                if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//.test(subUrl)) {
                    return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
                }
                const result = { count: 0, userInfo: null };
                
                 try {
                    // ... (获取流量和节点数的逻辑无变化)
                    const trafficRequest = fetch(new Request(subUrl, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow" }));
                    const nodeCountRequest = fetch(new Request(subUrl, { headers: { 'User-Agent': 'MiSub-Node-Counter/2.0' }, redirect: "follow" }));
                    const [trafficResponse, nodeCountResponse] = await Promise.all([trafficRequest, nodeCountRequest]);
                    if (trafficResponse.ok) {
                        const userInfoHeader = trafficResponse.headers.get('subscription-userinfo');
                        if (userInfoHeader) {
                            const info = {};
                            userInfoHeader.split(';').forEach(part => {
                                const [key, value] = part.trim().split('=');
                                if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                            });
                            result.userInfo = info;
                        }
                    }
                    if (nodeCountResponse.ok) {
                        const text = await nodeCountResponse.text();
                        let nodeCount = 0;

                        // 检查是否为 YAML 格式
                        if (isYamlFormat(text)) {
                            try {
                                console.log('检测到 YAML 格式，开始计算节点数量');
                                const yamlNodes = await processYamlSubscription(text, context, 'MiSub-Node-Counter/2.0', 'count');
                                nodeCount = yamlNodes.length;
                                console.log(`YAML 格式节点计数: ${nodeCount}`);
                            } catch (e) {
                                console.error('YAML 节点计数失败，回退到传统方式:', e);
                                // 回退到传统计数方式
                            }
                        }

                        // 传统计数方式（如果 YAML 处理失败或不是 YAML 格式）
                        if (nodeCount === 0) {
                            let decoded = '';
                            try {
                                decoded = atob(text.replace(/\s/g, ''));
                            } catch {
                                decoded = text;
                            }
                            const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic):\/\//gm);
                            if (lineMatches) {
                                nodeCount = lineMatches.length;
                            }
                        }

                        result.count = nodeCount;
                    }
                } catch (e) {
                    console.error('Failed to fetch subscription:', e);
                }
                
                
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
            }
            case '/settings': {
                // [优化] 保存设置后，发送一条通知
                if (request.method === 'GET') {
                    const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
                }
                if (request.method === 'POST') {
                    const newSettings = await request.json();
                    const oldSettings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    const finalSettings = { ...oldSettings, ...newSettings };
                    await env.MISUB_KV.put(KV_KEY_SETTINGS, JSON.stringify(finalSettings));
                    // 构造更丰富的通知消息
                    const message = `⚙️ *MiSub 设置更新* ⚙️\n\n您的 MiSub 应用设置已成功更新。`;
                    await sendTgNotification(finalSettings, message);
                    return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
                }
                return new Response('Method Not Allowed', { status: 405 });
            }
        }
    } catch (e) { 
        console.error("API Error:", e);
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    }
    return new Response('API route not found', { status: 404 });
}
// --- 名称前缀辅助函数 (无修改) ---
function prependNodeName(link, prefix) {
  if (!prefix) return link;
  const appendToFragment = (baseLink, namePrefix) => {
    const hashIndex = baseLink.lastIndexOf('#');
    const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
    const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
    if (originalName.startsWith(namePrefix)) {
        return baseLink;
    }
    const newName = originalName ? `${namePrefix} - ${originalName}` : namePrefix;
    return `${base}#${encodeURIComponent(newName)}`;
  }
  if (link.startsWith('vmess://')) {
    try {
      const base64Part = link.substring('vmess://'.length);
      const binaryString = atob(base64Part);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
      }
      const jsonString = new TextDecoder('utf-8').decode(bytes);
      const nodeConfig = JSON.parse(jsonString);
      const originalPs = nodeConfig.ps || '';
      if (!originalPs.startsWith(prefix)) {
        nodeConfig.ps = originalPs ? `${prefix} - ${originalPs}` : prefix;
      }
      const newJsonString = JSON.stringify(nodeConfig);
      const newBase64Part = btoa(unescape(encodeURIComponent(newJsonString)));
      return 'vmess://' + newBase64Part;
    } catch (e) {
      console.error("为 vmess 节点添加名称前缀失败，将回退到通用方法。", e);
      return appendToFragment(link, prefix);
    }
  }
  return appendToFragment(link, prefix);
}

// --- YAML 格式检测函数 ---
function isYamlFormat(text) {
    if (!text || typeof text !== 'string') return false;

    console.log('开始检测 YAML 格式，内容长度:', text.length);
    console.log('内容前 200 字符:', text.substring(0, 200));

    // 检查 YAML 特征标识符（包括 Clash 配置特有字段）
    const yamlIndicators = [
        'proxies:',
        'proxy-providers:',
        'proxy-groups:',
        'rules:',
        'dns:',
        // Clash 配置特有字段
        'port:',
        'socks-port:',
        'allow-lan:',
        'mode:',
        'log-level:',
        'external-controller:'
    ];

    // 检查是否包含至少一个 YAML 特征
    const hasYamlFeatures = yamlIndicators.some(indicator => {
        const found = text.includes(indicator);
        if (found) {
            console.log('发现 YAML 特征:', indicator);
        }
        return found;
    });

    // 改进的 base64 排除逻辑
    // 1. 检查是否主要由 base64 字符组成
    const base64Pattern = /^[A-Za-z0-9+/=\s\n\r]+$/;
    const isLikelyBase64 = base64Pattern.test(text.trim()) &&
                          text.length > 100 &&
                          !text.includes(':') &&
                          !text.includes('-') &&
                          !text.includes('{') &&
                          !text.includes('}');

    // 2. 检查是否包含典型的 YAML 结构字符
    const hasYamlStructure = text.includes(':') ||
                            text.includes('- ') ||
                            text.includes('- {') ||
                            text.includes('name:');

    console.log('YAML 特征检测结果:', hasYamlFeatures);
    console.log('Base64 排除检测:', isLikelyBase64);
    console.log('YAML 结构检测:', hasYamlStructure);

    const result = hasYamlFeatures && !isLikelyBase64 && hasYamlStructure;
    console.log('最终 YAML 格式检测结果:', result);

    return result;
}

// --- YAML 节点转换函数 ---
function convertYamlProxyToNodeLink(proxy) {
    if (!proxy || !proxy.type || !proxy.server || !proxy.port) {
        console.log('代理配置不完整:', proxy);
        return null;
    }

    const name = proxy.name || 'Unknown';
    const server = proxy.server;
    const port = proxy.port;

    console.log(`转换代理节点: ${name} (${proxy.type})`);

    try {
        switch (proxy.type.toLowerCase()) {
            case 'ss': {
                const method = proxy.cipher || 'aes-256-gcm';
                const password = proxy.password || '';
                const auth = btoa(`${method}:${password}`);
                const fragment = encodeURIComponent(name);
                return `ss://${auth}@${server}:${port}#${fragment}`;
            }

            case 'ssr': {
                const method = proxy.cipher || 'aes-256-cfb';
                const password = proxy.password || '';
                const protocol = proxy.protocol || 'origin';
                const obfs = proxy.obfs || 'plain';
                const auth = btoa(`${method}:${password}`);
                const params = new URLSearchParams({
                    protocol,
                    obfs,
                    remarks: name
                });
                return `ssr://${auth}@${server}:${port}?${params}`;
            }

            case 'vmess': {
                const vmessConfig = {
                    v: '2',
                    ps: name,
                    add: server,
                    port: port.toString(),
                    id: proxy.uuid || '',
                    aid: (proxy.alterId || proxy.alterid || 0).toString(),
                    net: proxy.network || 'tcp',
                    type: proxy.type || 'none',
                    host: proxy.host || '',
                    path: proxy.path || '',
                    tls: proxy.tls ? 'tls' : '',
                    sni: proxy.sni || '',
                    cipher: proxy.cipher || 'auto'
                };
                console.log(`VMess 配置:`, vmessConfig);
                const vmessJson = JSON.stringify(vmessConfig);
                const vmessBase64 = btoa(unescape(encodeURIComponent(vmessJson)));
                return `vmess://${vmessBase64}`;
            }

            case 'vless': {
                const params = new URLSearchParams();
                if (proxy.network) params.set('type', proxy.network);
                if (proxy.security) params.set('security', proxy.security);
                if (proxy.sni) params.set('sni', proxy.sni);
                if (proxy.host) params.set('host', proxy.host);
                if (proxy.path) params.set('path', proxy.path);

                const uuid = proxy.uuid || '';
                const fragment = encodeURIComponent(name);
                const query = params.toString() ? `?${params}` : '';
                return `vless://${uuid}@${server}:${port}${query}#${fragment}`;
            }

            case 'trojan': {
                const password = proxy.password || '';
                const params = new URLSearchParams();
                if (proxy.sni) params.set('sni', proxy.sni);
                if (proxy.alpn) params.set('alpn', proxy.alpn);

                const fragment = encodeURIComponent(name);
                const query = params.toString() ? `?${params}` : '';
                return `trojan://${password}@${server}:${port}${query}#${fragment}`;
            }

            case 'hysteria':
            case 'hysteria2':
            case 'hy':
            case 'hy2': {
                const auth = proxy.auth || proxy.password || '';
                const params = new URLSearchParams();
                if (proxy.sni) params.set('sni', proxy.sni);
                if (proxy.alpn) params.set('alpn', proxy.alpn);

                const protocol = proxy.type === 'hysteria2' || proxy.type === 'hy2' ? 'hy2' : 'hysteria';
                const fragment = encodeURIComponent(name);
                const query = params.toString() ? `?${params}` : '';
                return `${protocol}://${auth}@${server}:${port}${query}#${fragment}`;
            }

            case 'tuic': {
                const uuid = proxy.uuid || '';
                const password = proxy.password || '';
                const params = new URLSearchParams();
                if (proxy.sni) params.set('sni', proxy.sni);
                if (proxy.alpn) params.set('alpn', proxy.alpn);

                const fragment = encodeURIComponent(name);
                const query = params.toString() ? `?${params}` : '';
                return `tuic://${uuid}:${password}@${server}:${port}${query}#${fragment}`;
            }

            default:
                console.warn(`不支持的代理类型: ${proxy.type}`);
                return null;
        }
    } catch (e) {
        console.error(`转换 YAML 节点失败:`, proxy, e);
        return null;
    }
}

// --- proxy-providers 处理函数 ---
async function processProxyProviders(proxyProviders, context, userAgent) {
    if (!proxyProviders || typeof proxyProviders !== 'object') {
        return [];
    }

    const allNodes = [];

    for (const [providerName, provider] of Object.entries(proxyProviders)) {
        if (!provider.url) continue;

        try {
            console.log(`处理 proxy-provider: ${providerName}, URL: ${provider.url}`);

            const requestHeaders = { 'User-Agent': userAgent };
            const response = await Promise.race([
                fetch(new Request(provider.url, {
                    headers: requestHeaders,
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                })),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 10000))
            ]);

            if (!response.ok) {
                console.error(`获取 proxy-provider ${providerName} 失败: ${response.status}`);
                continue;
            }

            let text = await response.text();

            // 尝试 base64 解码
            try {
                const decoded = atob(text.replace(/\s/g, ''));
                if (decoded && decoded.length > 0) {
                    text = decoded;
                }
            } catch (e) {
                // 不是 base64，使用原始文本
            }

            let providerNodes = [];

            // 检查是否为 YAML 格式
            if (isYamlFormat(text)) {
                try {
                    const yamlData = yaml.load(text);
                    if (yamlData && yamlData.proxies && Array.isArray(yamlData.proxies)) {
                        providerNodes = yamlData.proxies
                            .map(proxy => convertYamlProxyToNodeLink(proxy))
                            .filter(node => node !== null);
                    }
                } catch (e) {
                    console.error(`解析 proxy-provider ${providerName} YAML 失败:`, e);
                }
            } else {
                // 处理传统格式（节点链接）
                const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls):\/\//;
                providerNodes = text.replace(/\r\n/g, '\n').split('\n')
                    .map(line => line.trim())
                    .filter(line => nodeRegex.test(line));
            }

            // 应用 additional-prefix
            if (provider.override && provider.override['additional-prefix']) {
                const prefix = provider.override['additional-prefix'];
                providerNodes = providerNodes.map(node => {
                    try {
                        return prependNodeName(node, prefix);
                    } catch (e) {
                        console.error(`为节点添加前缀失败:`, e);
                        return node;
                    }
                });
            }

            allNodes.push(...providerNodes);
            console.log(`从 proxy-provider ${providerName} 获取到 ${providerNodes.length} 个节点`);

        } catch (e) {
            console.error(`处理 proxy-provider ${providerName} 失败:`, e);
        }
    }

    return allNodes;
}

// --- YAML 订阅处理函数 ---
async function processYamlSubscription(text, context, userAgent, subName) {
    try {
        console.log('开始处理 YAML 订阅，内容长度:', text.length);
        console.log('订阅名称:', subName);

        const yamlData = yaml.load(text);
        if (!yamlData) {
            throw new Error('YAML 解析结果为空');
        }

        console.log('YAML 解析成功，数据结构:', Object.keys(yamlData));

        let allNodes = [];

        // 处理直接的 proxies 节点
        if (yamlData.proxies && Array.isArray(yamlData.proxies)) {
            console.log(`发现 proxies 字段，包含 ${yamlData.proxies.length} 个代理配置`);
            const directNodes = yamlData.proxies
                .map((proxy, index) => {
                    const node = convertYamlProxyToNodeLink(proxy);
                    if (!node) {
                        console.log(`第 ${index + 1} 个代理转换失败:`, proxy);
                    }
                    return node;
                })
                .filter(node => node !== null);
            allNodes.push(...directNodes);
            console.log(`从 YAML proxies 字段成功获取到 ${directNodes.length} 个节点`);
        } else {
            console.log('未发现 proxies 字段或格式不正确');
        }

        // 处理 proxy-providers
        if (yamlData['proxy-providers']) {
            console.log('发现 proxy-providers 字段');
            const providerNodes = await processProxyProviders(yamlData['proxy-providers'], context, userAgent);
            allNodes.push(...providerNodes);
            console.log(`从 proxy-providers 获取到 ${providerNodes.length} 个节点`);
        } else {
            console.log('未发现 proxy-providers 字段');
        }

        console.log(`YAML 订阅处理完成，总共获取到 ${allNodes.length} 个节点`);
        return allNodes;

    } catch (e) {
        console.error('处理 YAML 订阅失败:', e);
        console.error('错误详情:', e.message);
        console.error('YAML 内容前 500 字符:', text.substring(0, 500));
        throw e;
    }
}

// --- 节点列表生成函数 ---
async function generateCombinedNodeList(context, config, userAgent, misubs, prependedContent = '') {
    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls):\/\//;
    let manualNodesContent = '';
    const normalizeVmessLink = (link) => {
        if (!link.startsWith('vmess://')) return link;
        try {
            const base64Part = link.substring('vmess://'.length);
            const binaryString = atob(base64Part);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            const jsonString = new TextDecoder('utf-8').decode(bytes);
            const compactJsonString = JSON.stringify(JSON.parse(jsonString));
            const newBase64Part = btoa(unescape(encodeURIComponent(compactJsonString)));
            return 'vmess://' + newBase64Part;
        } catch (e) {
            console.error("标准化 vmess 链接失败，将使用原始链接:", link, e);
            return link;
        }
    };
    const httpSubs = misubs.filter(sub => {
        if (sub.url.toLowerCase().startsWith('http')) return true;
        manualNodesContent += sub.url + '\n';
        return false;
    });
    const processedManualNodes = manualNodesContent.split('\n')
        .map(line => line.trim())
        .filter(line => nodeRegex.test(line))
        .map(normalizeVmessLink)
        .map(node => (config.prependSubName) ? prependNodeName(node, '手动节点') : node)
        .join('\n');
    const subPromises = httpSubs.map(async (sub) => {
        try {
            const requestHeaders = { 'User-Agent': userAgent };
            const response = await Promise.race([
                fetch(new Request(sub.url, { headers: requestHeaders, redirect: "follow", cf: { insecureSkipVerify: true } })),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 10000))
            ]);
            if (!response.ok) return '';
            let text = await response.text();

            // 检查是否为 YAML 格式
            if (isYamlFormat(text)) {
                try {
                    console.log(`检测到 YAML 格式订阅: ${sub.name || sub.url}`);
                    const yamlNodes = await processYamlSubscription(text, context, userAgent, sub.name);

                    // 应用订阅名称前缀
                    const finalNodes = (config.prependSubName && sub.name)
                        ? yamlNodes.map(node => prependNodeName(node, sub.name))
                        : yamlNodes;

                    console.log(`YAML 订阅 ${sub.name || sub.url} 处理完成，获得 ${finalNodes.length} 个节点`);
                    return finalNodes.join('\n');
                } catch (e) {
                    console.error(`处理 YAML 订阅失败，回退到传统处理: ${sub.name || sub.url}`, e);
                    // 继续使用传统处理方式
                }
            }

            // 传统处理方式（base64 和节点链接）
            try {
                const cleanedText = text.replace(/\s/g, '');
                if (cleanedText.length > 20 && /^[A-Za-z0-9+/=]+$/.test(cleanedText)) {
                    const binaryString = atob(cleanedText);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
                    text = new TextDecoder('utf-8').decode(bytes);
                }
            } catch (e) {}
            let validNodes = text.replace(/\r\n/g, '\n').split('\n')
                .map(line => line.trim()).filter(line => nodeRegex.test(line));
            validNodes = validNodes.filter(nodeLink => {
                try {
                    const hashIndex = nodeLink.lastIndexOf('#');
                    if (hashIndex === -1) return true;
                    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
                    return !nodeName.includes('https://');
                } catch (e) { return false; }
            });
            return (config.prependSubName && sub.name)
                ? validNodes.map(node => prependNodeName(node, sub.name)).join('\n')
                : validNodes.join('\n');
        } catch (e) { return ''; }
    });
    const processedSubContents = await Promise.all(subPromises);
    const combinedContent = (processedManualNodes + '\n' + processedSubContents.join('\n'));
    const uniqueNodesString = [...new Set(combinedContent.split('\n').map(line => line.trim()).filter(line => line))].join('\n');

    // 将虚假节点（如果存在）插入到列表最前面
    if (prependedContent) {
        return `${prependedContent}\n${uniqueNodesString}`;
    }
    return uniqueNodesString;
}

// --- [核心修改] 订阅处理函数 ---
// --- [最終修正版 - 變量名校對] 訂閱處理函數 ---
async function handleMisubRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    const [settingsData, misubsData, profilesData] = await Promise.all([
        env.MISUB_KV.get(KV_KEY_SETTINGS, 'json'),
        env.MISUB_KV.get(KV_KEY_SUBS, 'json'),
        env.MISUB_KV.get(KV_KEY_PROFILES, 'json')
    ]);
    const settings = settingsData || {};
    const allMisubs = misubsData || [];
    const allProfiles = profilesData || [];
    // 關鍵：我們在這裡定義了 `config`，後續都應該使用它
    const config = { ...defaultSettings, ...settings }; 

    let token = '';
    let profileIdentifier = null;
    const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);

    if (pathSegments.length > 0) {
        token = pathSegments[0];
        if (pathSegments.length > 1) {
            profileIdentifier = pathSegments[1];
        }
    } else {
        token = url.searchParams.get('token');
    }

    let targetMisubs;
    let subName = config.FileName;
    let effectiveSubConverter;
    let effectiveSubConfig;

    if (profileIdentifier) {
        // [修正] 使用 config 變量
        if (config.profileToken === 'profiles') {
            return new Response('For security reasons, you must set a custom Profile Token in the settings before sharing profiles.', { status: 403 });
        }
        // [修正] 使用 config 變量
        if (!token || token !== config.profileToken) {
            return new Response('Invalid Profile Token', { status: 403 });
        }
        const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
        if (profile && profile.enabled) {
            subName = profile.name;
            const profileSubIds = new Set(profile.subscriptions);
            const profileNodeIds = new Set(profile.manualNodes);
            targetMisubs = allMisubs.filter(item => (item.url.startsWith('http') ? profileSubIds.has(item.id) : profileNodeIds.has(item.id)));
            
            // [修正] 使用 config 變量作為回退
            effectiveSubConverter = profile.subConverter && profile.subConverter.trim() !== '' ? profile.subConverter : config.subConverter;
            effectiveSubConfig = profile.subConfig && profile.subConfig.trim() !== '' ? profile.subConfig : config.subConfig;
        } else {
            return new Response('Profile not found or disabled', { status: 404 });
        }
    } else {
        // [修正] 使用 config 變量
        if (!token || token !== config.mytoken) {
            return new Response('Invalid Token', { status: 403 });
        }
        targetMisubs = allMisubs.filter(s => s.enabled);
        // [修正] 使用 config 變量
        effectiveSubConverter = config.subConverter;
        effectiveSubConfig = config.subConfig;
    }

    if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
        return new Response('Subconverter backend is not configured.', { status: 500 });
    }

    // --- 後續所有邏輯保持不變 ---
    
    let targetFormat = url.searchParams.get('target');
    if (!targetFormat) {
        const supportedFormats = ['clash', 'singbox', 'surge', 'loon', 'base64', 'v2ray', 'trojan'];
        for (const format of supportedFormats) {
            if (url.searchParams.has(format)) {
                if (format === 'v2ray' || format === 'trojan') { targetFormat = 'base64'; } else { targetFormat = format; }
                break;
            }
        }
    }
    if (!targetFormat) {
        const ua = userAgentHeader.toLowerCase();
        const uaMapping = {
            'clash': 'clash', 'meta': 'clash', 'stash': 'clash', 'nekoray': 'clash',
            'sing-box': 'singbox', 'shadowrocket': 'base64', 'v2rayn': 'base64',
            'v2rayng': 'base64', 'surge': 'surge', 'loon': 'loon',
            'quantumult%20x': 'quanx', 'quantumult': 'quanx',
        };
        for (const key in uaMapping) {
            if (ua.includes(key)) { targetFormat = uaMapping[key]; break; }
        }
    }
    if (!targetFormat) { targetFormat = 'clash'; }

    if (!url.searchParams.has('callback_token')) {
        const clientIp = request.headers.get('CF-Connecting-IP') || 'N/A';
        const country = request.headers.get('CF-IPCountry') || 'N/A';
        let message = `🛰️ *订阅被访问* 🛰️\n\n*客户端:* \`${userAgentHeader}\`\n*IP 地址:* \`${clientIp} (${country})\`\n*请求格式:* \`${targetFormat}\``;
        if (profileIdentifier) { message += `\n*订阅组:* \`${subName}\``; }
        context.waitUntil(sendTgNotification(config, message));
    }

    let fakeNodeString = '';
    const totalRemainingBytes = targetMisubs.reduce((acc, sub) => {
        if (sub.enabled && sub.userInfo && sub.userInfo.total > 0) {
            const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
            const remaining = sub.userInfo.total - used;
            return acc + Math.max(0, remaining);
        }
        return acc;
    }, 0);
    if (totalRemainingBytes > 0) {
        const formattedTraffic = formatBytes(totalRemainingBytes);
        const fakeNodeName = `流量剩余 ≫ ${formattedTraffic}`;
        fakeNodeString = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(fakeNodeName)}`;
    }

    const combinedNodeList = await generateCombinedNodeList(context, config, userAgentHeader, targetMisubs, fakeNodeString);
    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));

    if (targetFormat === 'base64') {
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(base64Content, { headers });
    }

    const callbackToken = await getCallbackToken(env);
    const callbackPath = profileIdentifier ? `/${token}/${profileIdentifier}` : `/${token}`;
    const callbackUrl = `${url.protocol}//${url.host}${callbackPath}?target=base64&callback_token=${callbackToken}`;
    if (url.searchParams.get('callback_token') === callbackToken) {
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(base64Content, { headers });
    }
    
    const subconverterUrl = new URL(`https://${effectiveSubConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);
    subconverterUrl.searchParams.set('url', callbackUrl);
    if (effectiveSubConfig && effectiveSubConfig.trim() !== '') {
        subconverterUrl.searchParams.set('config', effectiveSubConfig);
    }
    subconverterUrl.searchParams.set('new_name', 'true');
    
    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!subconverterResponse.ok) {
            const errorBody = await subconverterResponse.text();
            throw new Error(`Subconverter service returned status: ${subconverterResponse.status}. Body: ${errorBody}`);
        }
        const responseText = await subconverterResponse.text();
        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set("Content-Disposition", `attachment; filename*=utf-8''${encodeURIComponent(subName)}`);
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-store, no-cache');
        return new Response(responseText, { status: subconverterResponse.status, statusText: subconverterResponse.statusText, headers: responseHeaders });
    } catch (error) {
        console.error(`[MiSub Final Error] ${error.message}`);
        return new Response(`Error connecting to subconverter: ${error.message}`, { status: 502 });
    }
}

async function getCallbackToken(env) {
    const secret = env.COOKIE_SECRET || 'default-callback-secret';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode('callback-static-data'));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}


// --- [核心修改] Cloudflare Pages Functions 主入口 ---
export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);

    // **核心修改：判斷是否為定時觸發**
    if (request.headers.get("cf-cron")) {
        return handleCronTrigger(env);
    }

    if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, env);
    }
    const isStaticAsset = /^\/(assets|@vite|src)\//.test(url.pathname) || /\.\w+$/.test(url.pathname);
    if (!isStaticAsset && url.pathname !== '/') {
        return handleMisubRequest(context);
    }
    return next();
}
