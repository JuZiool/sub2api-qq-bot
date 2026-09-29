import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCheckinService, getShanghaiDate, randomAmount } from '../src/checkin-service.js';

const binding = { userId: 100, email: 'user@fixture.invalid' };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-checkin-test-'));
  const storePath = path.join(dir, 'checkins.json');
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^qq-bot-checkin-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  if (options.initial !== undefined) fs.writeFileSync(storePath, JSON.stringify(options.initial));
  let clock = new Date('2026-09-30T04:00:00Z');
  let draws = 0;
  const posts = [], gets = [];
  const f = {
    dir, storePath, posts, gets,
    history: () => ({ items: [], pages: 1 }),
    read: () => JSON.parse(fs.readFileSync(storePath, 'utf8')),
    advance: date => { clock = new Date(date); },
    get draws() { return draws; },
  };
  const request = async (url, args = {}) => {
    if (args.method === 'POST') {
      posts.push(structuredClone({ url, ...args }));
      assert.equal(f.read().accounts[url.split('/')[5]].status, 'pending', '发放前必须持久化 pending');
      return options.post ? options.post(url, args, posts.length) : { balance: 10 };
    }
    gets.push(url);
    if (url.includes('/balance-history?')) return f.history(url);
    if (url.includes('/users?')) return { items: [{ id: 101, email: 'not-user@fixture.invalid' }, { id: 100, email: binding.email }] };
    return { id: 100, balance: 10 };
  };
  const serviceOptions = {
    storePath, request, now: () => clock,
    drawAmount: () => { draws++; return options.amounts?.[draws - 1] ?? 0.05; },
    storage: options.storage ?? fs,
  };
  f.service = createCheckinService(serviceOptions);
  f.restart = () => { f.service = createCheckinService(serviceOptions); };
  f.receipt = (post = posts[0]) => ({
    notes: post.body.notes, type: 'admin_balance', status: 'used',
    used_by: Number(post.url.split('/')[5]), value: post.body.balance,
  });
  return f;
}

function renameFault(nth) {
  let count = 0;
  return { ...fs, renameSync(from, to) {
    if (++count === nth) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
    fs.renameSync(from, to);
  } };
}

function timeout() { throw new Error('fixture response lost'); }

test('同一账号绑定两个 QQ，每天仅发放一次', async t => {
  const f = fixture(t);
  const first = await f.service.checkin('10001', binding);
  const second = await f.service.checkin('10002', binding);
  assert.equal(first.alreadyCheckedIn, false);
  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.draws, 1);
  assert.equal(first.amount, second.amount);
});

test('同账号 30 次并发签到仅有一个发放请求', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => f.service.checkin(String(10000 + i), binding)));
  assert.equal(f.posts.length, 1);
  assert.equal(results.filter(result => !result.alreadyCheckedIn).length, 1);
  assert.equal(f.draws, 1);
});

test('不同账号并发签到不会互相覆盖账本', async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.service.checkin(String(10000 + i), { ...binding, userId: 100 + i })));
  assert.equal(f.posts.length, 10);
  assert.equal(Object.keys(f.read().accounts).length, 10);
  assert.ok(Object.values(f.read().accounts).every(record => record.status === 'succeeded'));
});

test('上海跨日边界和奖励档位保持不变', () => {
  assert.equal(getShanghaiDate(new Date('2026-09-29T15:59:59Z')), '2026-09-29');
  assert.equal(getShanghaiDate(new Date('2026-09-29T16:00:00Z')), '2026-09-30');
  assert.deepEqual([0.1, 0.5, 0.75, 0.9, 0.97, 0.995, 0.999].map(roll => randomAmount(() => roll)), [0.05, 0.1, 0.3, 0.5, 1, 2, 5]);
});

test('成功签到后下一上海日期可以再领，幂等键随日期变化', async t => {
  const f = fixture(t);
  await f.service.checkin('10001', binding);
  f.advance('2026-09-30T16:00:00Z');
  await f.service.checkin('10001', binding);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].idempotencyKey, 'qq-checkin:100:2026-09-30');
  assert.equal(f.posts[1].idempotencyKey, 'qq-checkin:100:2026-10-01');
});

test('旧 QQ 索引记录迁移为账号索引并保留原文件备份', async t => {
  const initial = { '10001': { date: '2026-09-30', amount: 0.3, userId: 100 } };
  const f = fixture(t, { initial });
  const result = await f.service.checkin('10002', binding);
  assert.equal(result.alreadyCheckedIn, true);
  assert.equal(result.amount, 0.3);
  assert.equal(f.posts.length, 0);
  assert.equal(f.read().version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.storePath}.legacy-backup`, 'utf8')), initial);
});

test('同一账号多条旧签到记录取最近日期，不允许再次发放', async t => {
  const f = fixture(t, { initial: {
    '10001': { date: '2026-09-30', amount: 0.1, userId: 100 },
    '10002': { date: '2026-09-29', amount: 0.3, userId: 100 },
  } });
  assert.equal((await f.service.checkin('10003', binding)).amount, 0.1);
  assert.equal(f.posts.length, 0);
});

test('无法归属账号的当日旧记录保守暂停，不能换 QQ 绕过', async t => {
  const initial = { '10001': '2026-09-30' };
  const f = fixture(t, { initial });
  await assert.rejects(f.service.checkin('10002', binding), /无法归属账号/);
  assert.deepEqual(f.read(), initial);
  assert.equal(f.posts.length, 0);
});

test('过期的未知账号旧记录保留，但不阻塞新日期', async t => {
  const f = fixture(t, { initial: { '10001': '2026-09-29' } });
  await f.service.checkin('10002', binding);
  assert.equal(f.posts.length, 1);
  assert.equal(f.read().legacyQQ['10001'].date, '2026-09-29');
});

test('JSON 损坏不得清空或发放', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.storePath, '{broken');
  await assert.rejects(f.service.checkin('10001', binding), /格式损坏/);
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), '{broken');
  assert.equal(f.posts.length, 0);
});

test('错误账本结构、非法金额和状态均保守拒绝', async t => {
  for (const initial of [[], { version: 9 }, { '10001': { date: '2026-09-30', amount: -1, userId: 100 } }]) {
    const f = fixture(t, { initial });
    await assert.rejects(f.service.checkin('10001', binding), /格式损坏/);
    assert.equal(f.posts.length, 0);
  }
});

test('非 ENOENT 读盘错误不得当成新账本', async t => {
  const f = fixture(t, { storage: { ...fs, readFileSync() { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); } } });
  await assert.rejects(f.service.checkin('10001', binding), /无法读取/);
  assert.equal(f.posts.length, 0);
});

test('发放前写盘失败不允许发送余额请求；孤立临时文件重启后不能当空账本', async t => {
  const f = fixture(t, { storage: renameFault(1) });
  await assert.rejects(f.service.checkin('10001', binding), /本次未发送余额请求/);
  assert.equal(f.posts.length, 0);
  assert.ok(fs.existsSync(`${f.storePath}.tmp`));
  f.restart();
  await assert.rejects(f.service.checkin('10001', binding), /无法读取/);
  assert.equal(f.posts.length, 0);
});

test('到账后写盘失败，当前进程仍去重且可修复落盘', async t => {
  const f = fixture(t, { storage: renameFault(2) });
  await assert.rejects(f.service.checkin('10001', binding), /奖励已到账.*保存失败/);
  assert.equal(f.read().accounts['100'].status, 'pending');
  const second = await f.service.checkin('10002', binding);
  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.read().accounts['100'].status, 'succeeded');
});

test('到账后写盘失败并重启，从精确流水恢复，不能重复 POST', async t => {
  const f = fixture(t, { storage: renameFault(2) });
  await assert.rejects(f.service.checkin('10001', binding), /保存失败/);
  f.history = () => ({ items: [f.receipt()], pages: 1 });
  f.restart();
  const second = await f.service.checkin('10002', binding);
  assert.equal(second.recovered, true);
  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(f.posts.length, 1);
});

test('超时后没有到账证明，重复签到和重启都不能重复发放', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
  f.restart();
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.draws, 1);
  assert.equal(f.read().accounts['100'].status, 'pending');
});

test('响应丢失但流水证明到账，可恢复本地成功状态', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  f.history = () => ({ items: [f.receipt()], pages: 1 });
  const result = await f.service.checkin('10002', binding);
  assert.equal(result.recovered, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.draws, 1);
});

test('核对流水会分页，非第一页的到账证明也能恢复', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  f.history = url => url.includes('page=1&')
    ? { items: Array.from({ length: 100 }, () => ({ notes: 'other' })), pages: 2 }
    : { items: [f.receipt()], pages: 2 };
  assert.equal((await f.service.checkin('10002', binding)).recovered, true);
  assert.equal(f.posts.length, 1);
});

test('金额、账号、类型或状态不匹配的流水不能视为到账证明', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  for (const patch of [{ value: 1 }, { used_by: 200 }, { type: 'balance' }, { status: 'unused' }, { notes: 'other' }]) {
    f.history = () => ({ items: [{ ...f.receipt(), ...patch }], pages: 1 });
    await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
  }
  assert.equal(f.posts.length, 1);
});

test('核对流水失败或结构异常不触发再次加款', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  for (const history of [() => { throw new Error('fixture offline'); }, () => ({ items: null })]) {
    f.history = history;
    await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
  }
  assert.equal(f.posts.length, 1);
});

test('跨日的 pending 不能被当天抽奖覆盖', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  f.advance('2026-10-01T04:00:00Z');
  await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
  assert.equal(f.read().accounts['100'].date, '2026-09-30');
  assert.equal(f.posts.length, 1);
});

test('旧 pending 确认到账后可以正常领取新日期奖励', async t => {
  const f = fixture(t, { post: (url, args, count) => { if (count === 1) timeout(); return { balance: 10 }; } });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  f.history = () => ({ items: [f.receipt()], pages: 1 });
  f.advance('2026-10-01T04:00:00Z');
  assert.equal((await f.service.checkin('10002', binding)).alreadyCheckedIn, false);
  assert.equal(f.posts.length, 2);
  assert.equal(f.read().accounts['100'].date, '2026-10-01');
});

test('明确拒绝后不同 QQ 重试仍保持原金额、幂等键和原 payload', async t => {
  for (const status of [401, 403, 429]) {
    const f = fixture(t, { amounts: [0.3, 5], post: (url, args, count) => {
      if (count === 1) throw Object.assign(new Error('fixture denied'), { status });
      return { balance: 10 };
    } });
    await assert.rejects(f.service.checkin('10001', binding), /本次未发放/);
    f.restart();
    const result = await f.service.checkin('10002', binding);
    assert.equal(result.amount, 0.3);
    assert.equal(f.draws, 1);
    assert.deepEqual(f.posts[0], f.posts[1]);
    assert.equal(f.read().accounts['100'].status, 'succeeded');
  }
});

test('500/503 和无效成功结果均视为待核对，不盲目重发', async t => {
  for (const post of [() => { throw Object.assign(new Error('fixture failure'), { status: 500 }); },
    () => { throw Object.assign(new Error('fixture failure'), { status: 503 }); }, () => ({})]) {
    const f = fixture(t, { post });
    await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
    await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
    assert.equal(f.posts.length, 1);
  }
});

test('历史绑定缺少 userId 时按邮箱精确匹配，而不是使用首个模糊匹配', async t => {
  const f = fixture(t);
  await f.service.checkin('10001', { email: binding.email });
  assert.match(f.posts[0].url, /users\/100\/balance$/);
});

test('系统时间倒退不能覆盖未来签到记录', async t => {
  const f = fixture(t);
  await f.service.checkin('10001', binding);
  f.advance('2026-09-29T04:00:00Z');
  await assert.rejects(f.service.checkin('10002', binding), /系统时间/);
  assert.equal(f.posts.length, 1);
});

test('登录前失败可原样重试，不能重新抽奖', async t => {
  const f = fixture(t, { amounts: [0.1, 5], post: (url, args, count) => {
    if (count === 1) throw Object.assign(new Error('fixture login timeout'), { requestNotSent: true });
    return { balance: 10 };
  } });
  await assert.rejects(f.service.checkin('10001', binding), /本次未发放/);
  await f.service.checkin('10002', binding);
  assert.deepEqual(f.posts[0], f.posts[1]);
  assert.equal(f.draws, 1);
});

test('pending 的请求标识或日期被损坏时暂停，而不是重新抽奖', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  const ledger = f.read();
  ledger.accounts['100'].idempotencyKey = 'other-key';
  fs.writeFileSync(f.storePath, JSON.stringify(ledger));
  f.restart();
  await assert.rejects(f.service.checkin('10002', binding), /格式损坏/);
  assert.equal(f.posts.length, 1);
});

test('已确认到账后余额展示接口失败，仍能恢复去重', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  const service = createCheckinService({ storePath: f.storePath, now: () => new Date('2026-09-30T04:00:00Z'),
    request: async url => {
      if (url.includes('/balance-history?')) return { items: [f.receipt()], pages: 1 };
      throw new Error('fixture profile offline');
    } });
  const result = await service.checkin('10002', binding);
  assert.equal(result.recovered, true);
  assert.equal(result.balance, null);
  assert.equal(f.posts.length, 1);
});

test('流水核对最多 20 页，超出上限保守暂停', async t => {
  const f = fixture(t, { post: timeout });
  await assert.rejects(f.service.checkin('10001', binding), /结果待确认/);
  let pages = 0;
  f.history = () => { pages++; return { items: Array.from({ length: 100 }, () => null), pages: 100 }; };
  await assert.rejects(f.service.checkin('10002', binding), /结果待确认/);
  assert.equal(pages, 20);
  assert.equal(f.posts.length, 1);
});
