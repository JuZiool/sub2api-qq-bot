import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/sub2api.js';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function client(fetchImpl) {
  return createClient({ baseUrl: 'http://fixture.invalid', email: 'admin@fixture.invalid', password: 'fixture-password', fetchImpl });
}

test('余额写请求传递 Idempotency-Key 和超时信号', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    return response({ code: 0, data: url.endsWith('/auth/login') ? { access_token: 'fixture-token', expires_in: 3600 } : { balance: 10 } });
  });
  await api.request('/api/v1/admin/users/100/balance', { method: 'POST', idempotencyKey: 'qq-checkin:100:2026-09-30', body: { balance: 0.3, operation: 'add' } });
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'qq-checkin:100:2026-09-30');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fixture-token');
  assert.deepEqual(JSON.parse(calls[1].options.body), { balance: 0.3, operation: 'add' });
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
  assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
});

test('401 后重登只重试一次，保持相同幂等键和请求体', async () => {
  let loginCount = 0, postCount = 0;
  const writes = [];
  const api = client(async (url, options) => {
    if (url.endsWith('/auth/login')) return response({ code: 0, data: { access_token: `fixture-token-${++loginCount}`, expires_in: 3600 } });
    writes.push(options);
    if (++postCount === 1) return response({ message: 'fixture expired' }, 401);
    return response({ code: 0, data: { balance: 10 } });
  });
  await api.request('/balance', { method: 'POST', idempotencyKey: 'fixture-key', body: { balance: 0.3 } });
  assert.equal(loginCount, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body, writes[1].body);
  assert.equal(writes[0].headers['Idempotency-Key'], writes[1].headers['Idempotency-Key']);
  assert.equal(writes[1].headers.Authorization, 'Bearer fixture-token-2');
});

test('登录和余额请求均应用超时，不自动重试超时写请求', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push(url);
    if (url.endsWith('/auth/login')) return response({ code: 0, data: { access_token: 'fixture-token', expires_in: 3600 } });
    // AbortSignal.timeout 的定时器不保持进程存活；测试保活 timer 仅作用于本 fixture。
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('fixture abort not fired')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
    });
  });
  await assert.rejects(api.request('/balance', { method: 'POST', idempotencyKey: 'fixture-key', body: { balance: 0.3 }, timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.equal(calls.length, 2);
});

test('登录验证仍然可用，成功后复用已有 token', async () => {
  let logins = 0;
  const api = client(async url => {
    if (url.endsWith('/auth/login')) { logins++; return response({ code: 0, data: { access_token: 'fixture-token', expires_in: 3600 } }); }
    return response({ code: 0, data: { id: 100 } });
  });
  assert.equal((await api.verify()).id, 100);
  await api.request('/another-query');
  assert.equal(logins, 1);
});

test('登录阶段超时不会发送余额请求，错误标记允许安全重试', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('fixture abort not fired')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
    });
  });
  await assert.rejects(api.request('/balance', { method: 'POST', idempotencyKey: 'fixture-key', timeoutMs: 10 }),
    err => err.name === 'TimeoutError' && err.requestNotSent === true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/auth/login'));
});

test('无效登录结果不能继续发送无认证余额请求', async () => {
  const calls = [];
  const api = client(async url => { calls.push(url); return response({ code: 0, data: {} }); });
  await assert.rejects(api.request('/balance', { method: 'POST' }),
    err => /有效 token/.test(err.message) && err.requestNotSent === true);
  assert.equal(calls.length, 1);
});
