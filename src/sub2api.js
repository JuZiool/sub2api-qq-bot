import { config } from './config.js';

// sub2api 管理 API 客户端：登录缓存 token，过期自动重登
let token = null;
let tokenExpiresAt = 0;

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${config.sub2api.baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
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

async function login() {
  const data = await request('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: {
      email: config.sub2api.email,
      password: config.sub2api.password,
    },
  });
  token = data.access_token;
  // expires_in 为秒；提前 60 秒过期，避免边界请求失败
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return token;
}

async function authed(path, options = {}) {
  if (!token || Date.now() >= tokenExpiresAt) {
    await login();
  }
  try {
    return await request(path, options);
  } catch (err) {
    // token 失效则重登一次重试
    if (err.status === 401) {
      token = null;
      await login();
      return request(path, options);
    }
    throw err;
  }
}

// 仪表盘统计
export function getDashboardStats() {
  return authed('/api/v1/admin/dashboard/stats');
}

// 用户列表（支持分页与搜索）
export function getUsers(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return authed(`/api/v1/admin/users${qs ? `?${qs}` : ''}`);
}
