import fs from 'node:fs';
import path from 'node:path';

const READ_ERROR = '绑定记录无法读取、格式损坏或意外丢失，已暂停绑定相关操作。请联系管理员检查；不会清空或覆盖原数据。';
const WRITE_ERROR = '绑定记录保存失败，本次未更新绑定，原绑定保持不变。请联系管理员检查存储。';
const CONFLICT_ERROR = '绑定记录在保存期间发生变化，本次未覆盖，请重试或联系管理员检查。';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validUserId(value) {
  return value === null || value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[1-9]\d*$/.test(value));
}

function validRecord(record) {
  return object(record) && typeof record.email === 'string' && record.email.includes('@')
    && typeof record.password === 'string' && record.password.length > 0
    && typeof record.boundAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.boundAt)
    && Number.isFinite(Date.parse(record.boundAt)) && validUserId(record.userId)
    && (record.emailMasked === undefined || typeof record.emailMasked === 'string');
}

function validate(records) {
  if (!object(records)) throw new Error(READ_ERROR);
  for (const [qq, record] of Object.entries(records)) {
    if (!/^[1-9]\d*$/.test(qq) || !validRecord(record)) throw new Error(READ_ERROR);
  }
  return records;
}

function qqKey(qq) {
  const key = String(qq);
  if (!/^[1-9]\d*$/.test(key)) throw new Error('无法确定你的 QQ 号，请重新发送指令。');
  return key;
}

export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${name.slice(0, 1)}***@${domain}`;
}

// 主文件是权威来源；仅单进程单实例使用，不将读取错误视为空数据。
export function createBindingStore({ storePath, createUserClient, storage = fs, now = () => new Date() }) {
  const cache = new Map();
  let observedStore = false;

  function readSnapshot() {
    try {
      let raw;
      try { raw = storage.readFileSync(storePath, 'utf8'); }
      catch (err) {
        if (err.code !== 'ENOENT' || observedStore
          || ['.tmp', '.backup', '.backup.tmp'].some(suffix => storage.existsSync(`${storePath}${suffix}`))) throw err;
        return { records: {}, raw: null };
      }
      observedStore = true;
      return { records: validate(JSON.parse(raw)), raw };
    } catch {
      // 不回显 JSON 解析片段，避免错误信息包含用户原始密码。
      throw new Error(READ_ERROR);
    }
  }

  function assertUnchanged(snapshot) {
    let raw;
    try { raw = storage.readFileSync(storePath, 'utf8'); }
    catch (err) {
      if (err.code !== 'ENOENT') throw new Error(READ_ERROR);
      raw = null;
    }
    if (raw !== snapshot.raw) throw new Error(CONFLICT_ERROR);
  }

  function writeTemporary(file, content) {
    const fd = storage.openSync(file, 'w', 0o600);
    try {
      storage.writeFileSync(fd, content, 'utf8');
      storage.fsyncSync(fd);
    } finally { storage.closeSync(fd); }
  }

  function commit(snapshot, records) {
    try {
      assertUnchanged(snapshot);
      storage.mkdirSync(path.dirname(storePath), { recursive: true });
      writeTemporary(`${storePath}.tmp`, JSON.stringify(records, null, 2));
      if (snapshot.raw !== null) {
        // 备份上一版已验证的原始字节，不把新内容或损坏文件当成有效备份。
        writeTemporary(`${storePath}.backup.tmp`, snapshot.raw);
        storage.renameSync(`${storePath}.backup.tmp`, `${storePath}.backup`);
      }
      assertUnchanged(snapshot);
      storage.renameSync(`${storePath}.tmp`, storePath);
      observedStore = true;
    } catch (err) {
      if (err.message === CONFLICT_ERROR || err.message === READ_ERROR) throw err;
      throw new Error(WRITE_ERROR);
    }
  }

  function getBinding(qq) {
    const key = qqKey(qq);
    const binding = readSnapshot().records[key];
    if (!binding) return null;
    // 兼容旧记录缺少派生字段；只返回新对象，不改动磁盘中的其它绑定。
    return { ...binding, userId: binding.userId ?? null, emailMasked: binding.emailMasked ?? maskEmail(binding.email) };
  }

  function bind(qq, email, password, userId) {
    const key = qqKey(qq);
    const snapshot = readSnapshot();
    const record = { email, password, userId: userId ?? null, emailMasked: maskEmail(email), boundAt: now().toISOString() };
    if (!validRecord(record)) throw new Error('绑定信息不完整或格式异常，本次未更新绑定。');
    commit(snapshot, { ...snapshot.records, [key]: record });
    // 只有持久化成功后才失效该 QQ 的客户端，其它 QQ 不受影响。
    cache.delete(key);
  }

  function unbind(qq) {
    const key = qqKey(qq);
    const snapshot = readSnapshot();
    if (!snapshot.records[key]) {
      cache.delete(key);
      return false;
    }
    const records = { ...snapshot.records };
    delete records[key];
    commit(snapshot, records);
    cache.delete(key);
    return true;
  }

  function getClient(qq) {
    const key = qqKey(qq);
    const binding = getBinding(key);
    if (!binding) {
      cache.delete(key);
      return null;
    }
    const userId = binding.userId === null ? null : String(binding.userId);
    const cached = cache.get(key);
    if (cached && cached.email === binding.email && cached.password === binding.password && cached.userId === userId) return cached.client;
    const client = createUserClient(binding.email, binding.password);
    cache.set(key, { email: binding.email, password: binding.password, userId, client });
    return client;
  }

  function removeClient(qq) {
    cache.delete(qqKey(qq));
  }

  return { getBinding, bind, unbind, getClient, removeClient };
}
