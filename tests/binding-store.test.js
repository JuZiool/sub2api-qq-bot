import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBindingStore, maskEmail } from '../src/binding-store.js';

function record(email = 'a@fixture.invalid', password = 'fixture-password-a', userId = 100) {
  return { email, password, userId, emailMasked: maskEmail(email), boundAt: '2026-09-30T04:00:00.000Z' };
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-binding-test-'));
  const storePath = path.join(dir, 'bindings.json');
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^qq-bot-binding-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  if (options.raw !== undefined) fs.writeFileSync(storePath, options.raw);
  else if (options.initial !== undefined) fs.writeFileSync(storePath, JSON.stringify(options.initial, null, 2));
  const clients = [];
  const f = {
    dir, storePath, clients,
    read: () => JSON.parse(fs.readFileSync(storePath, 'utf8')),
    raw: () => fs.readFileSync(storePath, 'utf8'),
  };
  const factory = (email, password) => {
    if (options.factory) return options.factory(email, password);
    const client = { email, password, serial: clients.length + 1, request: async () => ({ account: email }) };
    clients.push(client);
    return client;
  };
  const args = { storePath, createUserClient: factory, now: () => new Date('2026-09-30T05:00:00Z'), storage: options.storage ?? fs };
  f.store = createBindingStore(args);
  f.restart = () => { f.store = createBindingStore(args); };
  return f;
}

function failRenamePrimary() {
  return { ...fs, renameSync(from, to) {
    if (to.endsWith('bindings.json')) throw new Error('fixture-password-sensitive disk failure');
    fs.renameSync(from, to);
  } };
}

test('真正首次空目录可读取为未绑定，不主动创建文件', t => {
  const f = fixture(t);
  assert.equal(f.store.getBinding('10001'), null);
  assert.equal(f.store.getClient('10001'), null);
  assert.equal(f.store.unbind('10001'), false);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('首次绑定保持明文格式和原字段，成功持久化后才能查询', t => {
  const f = fixture(t);
  f.store.bind('10001', 'a@fixture.invalid', 'fixture-password-a', 100);
  const binding = f.read()['10001'];
  assert.equal(binding.password, 'fixture-password-a');
  assert.equal(binding.userId, 100);
  assert.equal(binding.boundAt, '2026-09-30T05:00:00.000Z');
  assert.equal(binding.emailMasked, 'a***@fixture.invalid');
  assert.equal(f.store.getClient('10001').email, 'a@fixture.invalid');
});

test('绑定不变时复用同一个客户端和 token 缓存', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  assert.equal(f.store.getClient('10001'), f.store.getClient(10001));
  assert.equal(f.clients.length, 1);
});

test('直接从 A 换绑 B，后续用量查询必须使用 B 客户端', async t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200);
  const current = f.store.getClient('10001');
  assert.notEqual(current, previous);
  assert.equal(current.password, 'fixture-password-b');
  assert.equal((await current.request('/api/v1/usage/dashboard/stats')).account, 'b@fixture.invalid');
  assert.equal(f.store.getBinding('10001').userId, 200);
});

test('同邮箱改密码也必须重新创建客户端', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  f.store.bind('10001', 'a@fixture.invalid', 'fixture-password-new', 100);
  const current = f.store.getClient('10001');
  assert.notEqual(current, previous);
  assert.equal(current.password, 'fixture-password-new');
});

test('同样凭证主动重新绑定后也会失效旧客户端', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  f.store.bind('10001', 'a@fixture.invalid', 'fixture-password-a', 100);
  assert.notEqual(f.store.getClient('10001'), previous);
});

test('换绑只失效对应 QQ，其它 QQ 缓存和未知字段保留', t => {
  const other = { ...record('other@fixture.invalid', 'fixture-other-password', 300), futureField: { keep: true } };
  const f = fixture(t, { initial: { '10001': record(), '10002': other } });
  const previous = f.store.getClient('10002');
  f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200);
  assert.equal(f.store.getClient('10002'), previous);
  assert.deepEqual(f.read()['10002'], other);
});

test('成功解绑由存储层清缓存，重新绑定不能复用已解绑客户端', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  assert.equal(f.store.unbind('10001'), true);
  assert.equal(f.store.getBinding('10001'), null);
  assert.equal(f.store.getClient('10001'), null);
  assert.equal(f.store.unbind('10001'), false);
  f.store.bind('10001', 'a@fixture.invalid', 'fixture-password-a', 100);
  assert.notEqual(f.store.getClient('10001'), previous);
});

test('绑定保存失败不替换主文件、不变更原绑定、不清理旧缓存', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: failRenamePrimary() });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200),
    err => /保存失败/.test(err.message) && !err.message.includes('fixture-password-sensitive'));
  assert.equal(f.raw(), original);
  assert.equal(f.store.getBinding('10001').email, 'a@fixture.invalid');
  assert.equal(f.store.getClient('10001'), previous);
  assert.equal(fs.readFileSync(`${f.storePath}.backup`, 'utf8'), original);
});

test('解绑保存失败不删除原绑定，也不清理旧缓存', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: failRenamePrimary() });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.unbind('10001'), /保存失败/);
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('备份写入失败也必须保留主文件和旧客户端', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, openSync(file, ...args) {
    if (file.endsWith('.backup.tmp')) throw new Error('fixture backup denied');
    return fs.openSync(file, ...args);
  } } });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), /保存失败/);
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('新快照 fsync 失败不能提交绑定或失效缓存', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, fsyncSync() { throw new Error('fixture sync failed'); } } });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), /保存失败/);
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('成功换绑或解绑前保留上一版完整有效字节作为备份', t => {
  const f = fixture(t, { initial: { '10001': record(), '10002': record('other@fixture.invalid', 'fixture-other-password', 300) } });
  const original = f.raw();
  f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200);
  assert.equal(fs.readFileSync(`${f.storePath}.backup`, 'utf8'), original);
  const afterBind = f.raw();
  f.store.unbind('10002');
  assert.equal(fs.readFileSync(`${f.storePath}.backup`, 'utf8'), afterBind);
  assert.equal(f.read()['10002'], undefined);
});

test('JSON 损坏时构造模块不崩溃，读取和变更全部暂停且不回显密码', t => {
  const raw = '{"password":"fixture-secret-sensitive", broken';
  const f = fixture(t, { raw });
  for (const operation of [() => f.store.getBinding('10001'), () => f.store.getClient('10001'),
    () => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), () => f.store.unbind('10001')]) {
    assert.throws(operation, err => /格式损坏/.test(err.message) && !err.message.includes('fixture-secret-sensitive'));
  }
  assert.equal(f.raw(), raw);
  assert.deepEqual(fs.readdirSync(f.dir), ['bindings.json']);
});

test('异常根结构、QQ 键、必需字段、日期及 userId 均拒绝覆盖', t => {
  const invalid = [null, [], 1, 'bad', { 'bad-qq': record() },
    { '10001': { ...record(), password: null } }, { '10001': { ...record(), userId: -1 } },
    { '10001': { ...record(), boundAt: 'not-a-date' } }, { '10001': { ...record(), emailMasked: {} } },
    { '10001': { email: 'a@fixture.invalid', password: 'fixture-password-a' } }];
  for (const initial of invalid) {
    const f = fixture(t, { initial });
    const original = f.raw();
    assert.throws(() => f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200), /格式损坏/);
    assert.equal(f.raw(), original);
  }
});

test('任一旧绑定损坏不能被丢弃后写入其它 QQ', t => {
  const f = fixture(t, { initial: { '10001': record(), '10002': { password: 'fixture-password-2' } } });
  const original = f.raw();
  assert.throws(() => f.store.bind('10003', 'b@fixture.invalid', 'fixture-password-b', 200), /格式损坏/);
  assert.equal(f.raw(), original);
});

test('读取权限错误不当作空数据，不能写文件', t => {
  let writes = 0;
  const f = fixture(t, { initial: { '10001': record() }, storage: { ...fs,
    readFileSync() { throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' }); },
    writeFileSync(...args) { writes++; return fs.writeFileSync(...args); },
  } });
  const original = f.raw();
  assert.throws(() => f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200), /无法读取/);
  assert.equal(writes, 0);
  assert.equal(f.raw(), original);
});

test('运行中主文件损坏，不能复用旧客户端或覆盖坏文件；修复后可继续使用', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const original = f.raw(), previous = f.store.getClient('10001');
  fs.writeFileSync(f.storePath, '{broken');
  assert.throws(() => f.store.getClient('10001'), /格式损坏/);
  assert.throws(() => f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200), /格式损坏/);
  assert.equal(f.raw(), '{broken');
  fs.writeFileSync(f.storePath, original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('读到过主文件后意外丢失，不能重新创建空绑定文件', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  f.store.getClient('10001');
  fs.unlinkSync(f.storePath);
  assert.throws(() => f.store.getClient('10001'), /意外丢失/);
  assert.throws(() => f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200), /意外丢失/);
  assert.equal(fs.existsSync(f.storePath), false);
});

test('主文件缺失但有临时文件或备份，重启不能当作首次空目录', t => {
  for (const suffix of ['.tmp', '.backup', '.backup.tmp']) {
    const f = fixture(t);
    const original = JSON.stringify({ '10001': record() });
    fs.writeFileSync(`${f.storePath}${suffix}`, original);
    f.restart();
    assert.throws(() => f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200), /意外丢失/);
    assert.equal(fs.existsSync(f.storePath), false);
    assert.equal(fs.readFileSync(`${f.storePath}${suffix}`, 'utf8'), original);
  }
});

test('主文件有效时以主文件为准，不启用失败写入留下的临时新绑定', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  fs.writeFileSync(`${f.storePath}.tmp`, JSON.stringify({ '10001': record('b@fixture.invalid', 'fixture-password-b', 200) }));
  assert.equal(f.store.getClient('10001').email, 'a@fixture.invalid');
  f.store.bind('10002', 'c@fixture.invalid', 'fixture-password-c', 300);
  assert.equal(f.store.getClient('10001').email, 'a@fixture.invalid');
});

test('合法外部换绑必须刷新对应客户端', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  fs.writeFileSync(f.storePath, JSON.stringify({ '10001': record('b@fixture.invalid', 'fixture-password-b', 200) }));
  const current = f.store.getClient('10001');
  assert.notEqual(current, previous);
  assert.equal(current.email, 'b@fixture.invalid');
});

test('合法外部解绑后不能返回已缓存客户端', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  fs.writeFileSync(f.storePath, '{}');
  assert.equal(f.store.getClient('10001'), null);
  fs.writeFileSync(f.storePath, JSON.stringify({ '10001': record() }));
  assert.notEqual(f.store.getClient('10001'), previous);
});

test('外部更新 userId 刷新缓存，仅修改派生元数据不刷新凭证缓存', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001');
  fs.writeFileSync(f.storePath, JSON.stringify({ '10001': { ...record(), emailMasked: 'custom-mask' } }));
  assert.equal(f.store.getClient('10001'), previous);
  fs.writeFileSync(f.storePath, JSON.stringify({ '10001': { ...record(), userId: 200 } }));
  assert.notEqual(f.store.getClient('10001'), previous);
});

test('写入期间外部变更主文件，拒绝覆盖外部新数据', t => {
  let f, changed = false;
  const external = JSON.stringify({ '10001': record('external@fixture.invalid', 'fixture-external-password', 300) });
  f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, fsyncSync(fd) {
    fs.fsyncSync(fd);
    if (!changed) { changed = true; fs.writeFileSync(f.storePath, external); }
  } } });
  const previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), /保存期间发生变化/);
  assert.equal(f.raw(), external);
  assert.notEqual(f.store.getClient('10001'), previous);
  assert.equal(f.store.getClient('10001').email, 'external@fixture.invalid');
});

test('旧记录缺少 userId 或 emailMasked 可读，不改写其它旧字段', t => {
  const old = record(); delete old.userId; delete old.emailMasked;
  old.legacyField = { keep: true };
  const f = fixture(t, { initial: { '10001': old } });
  const original = f.raw();
  const binding = f.store.getBinding('10001');
  assert.equal(binding.userId, null);
  assert.equal(binding.emailMasked, 'a***@fixture.invalid');
  assert.equal(f.raw(), original);
  f.store.bind('10002', 'b@fixture.invalid', 'fixture-password-b', 200);
  assert.deepEqual(f.read()['10001'], old);
});

test('调用者修改 getBinding 返回对象不能修改真实绑定', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const binding = f.store.getBinding('10001');
  binding.email = 'external@fixture.invalid';
  binding.password = 'fixture-external-password';
  assert.equal(f.store.getClient('10001').email, 'a@fixture.invalid');
  assert.equal(f.read()['10001'].password, 'fixture-password-a');
});

test('兼容 removeClient 导出，不改变绑定本身', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const previous = f.store.getClient('10001'), original = f.raw();
  f.store.removeClient('10001');
  assert.notEqual(f.store.getClient('10001'), previous);
  assert.equal(f.raw(), original);
});

test('不完整新绑定、非法 QQ 或用户 ID 不得改动已有绑定', t => {
  const f = fixture(t, { initial: { '10001': record() } });
  const original = f.raw(), previous = f.store.getClient('10001');
  for (const args of [['10001', 'no-email', 'fixture-password', 100], ['10001', 'a@fixture.invalid', '', 100],
    ['10001', 'a@fixture.invalid', 'fixture-password', -1], ['bad-qq', 'a@fixture.invalid', 'fixture-password', 100]]) {
    assert.throws(() => f.store.bind(...args));
  }
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('临时文件部分写入后失败，主文件和原客户端仍完整', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, writeFileSync(file, content, ...args) {
    if (typeof file === 'number') {
      fs.writeFileSync(file, content.slice(0, 12), ...args);
      throw new Error('fixture-password-sensitive partial write');
    }
    return fs.writeFileSync(file, content, ...args);
  } } });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200),
    err => /保存失败/.test(err.message) && !err.message.includes('fixture-password-sensitive'));
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('关闭临时文件失败也不能提交新绑定', t => {
  const f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, closeSync(fd) {
    fs.closeSync(fd); throw new Error('fixture close failure');
  } } });
  const original = f.raw(), previous = f.store.getClient('10001');
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), /保存失败/);
  assert.equal(f.raw(), original);
  assert.equal(f.store.getClient('10001'), previous);
});

test('保存期间主文件被删除时不重新创建，保留可供核对的有效备份', t => {
  let f, deleted = false;
  f = fixture(t, { initial: { '10001': record() }, storage: { ...fs, fsyncSync(fd) {
    fs.fsyncSync(fd);
    if (!deleted) { deleted = true; fs.unlinkSync(f.storePath); }
  } } });
  const original = f.raw();
  assert.throws(() => f.store.bind('10001', 'b@fixture.invalid', 'fixture-password-b', 200), /保存期间发生变化/);
  assert.equal(fs.existsSync(f.storePath), false);
  assert.equal(fs.readFileSync(`${f.storePath}.backup`, 'utf8'), original);
  assert.throws(() => f.store.getBinding('10001'), /意外丢失/);
});
