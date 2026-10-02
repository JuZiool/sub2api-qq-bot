import { config } from './config.js';

// sub2api API 客户端工厂：每个凭证集合（管理员/绑定用户）独立缓存 token，过期或 401 自动重登

export function createClient({ email, password, label = 'client', baseUrl = config.sub2api.baseUrl, fetchImpl = globalThis.fetch }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function rawRequest(path, { method = 'GET', body, auth = true, idempotencyKey, timeoutMs = 15000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(data.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // sub2api 统一响应包裹 { code, message, data }，code=0 表示成功
    if (data && typeof data === 'object' && 'code' in data) {
      if (data.code !== 0) {
        const err = new Error(data.message || '请求失败');
        err.code = data.code;
        throw err;
      }
      return data.data;
    }
    return data;
  }

  async function login(timeoutMs = 15000) {
    const data = await rawRequest('/api/v1/auth/login', {
      method: 'POST',
      auth: false,
      timeoutMs,
      body: { email, password },
    });
    if (typeof data?.access_token !== 'string' || !data.access_token) {
      throw new Error('登录接口未返回有效 token');
    }
    token = data.access_token;
    // expires_in 为秒；提前 60 秒过期，避免边界请求失败
    tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  }

  async function loginBeforeRequest(timeoutMs) {
    try { await login(timeoutMs); }
    catch (err) {
      // 登录阶段失败，或首次写请求已被 401 拒绝；目标写操作尚未被接受。
      err.requestNotSent = true;
      throw err;
    }
  }

  async function request(path, options = {}) {
    if (!token || Date.now() >= tokenExpiresAt) {
      await loginBeforeRequest(options.timeoutMs);
    }
    try {
      return await rawRequest(path, options);
    } catch (err) {
      // token 失效则重登一次重试
      if (err.status === 401) {
        token = null;
        await loginBeforeRequest(options.timeoutMs);
        return rawRequest(path, options);
      }
      throw err;
    }
  }

  return {
    label,
    // 登录验证（绑定用）：成功返回用户信息，失败抛错
    async verify() {
      await login();
      return request('/api/v1/user/profile');
    },
    request,
  };
}

// 管理员客户端（/全站用量 等管理查询）
export const adminClient = createClient({
  email: config.sub2api.email,
  password: config.sub2api.password,
  label: 'admin',
});

// 为绑定用户创建客户端
export function createUserClient(email, password) {
  return createClient({ email, password, label: `user:${email}` });
}

export function getDashboardStats() {
  return adminClient.request('/api/v1/admin/dashboard/stats');
}

export function getDashboardModelStats(startDate, endDate) {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  return adminClient.request(`/api/v1/admin/dashboard/models?${params.toString()}`);
}

// 渠道监控 V2：模型维度 24h 聚合（平均首字、缓存命中率等）。需要后端已开启渠道监控且模式为 v2。
export function getChannelMonitorModels(range = '24h') {
  const params = new URLSearchParams({ range });
  return adminClient.request(`/api/v1/admin/channel-monitor-v2/models?${params.toString()}`);
}
