import fs from 'node:fs';
import path from 'node:path';

const AMOUNT_TIERS = [
  { amount: 0.05, weight: 35 }, { amount: 0.1, weight: 30 },
  { amount: 0.3, weight: 20 }, { amount: 0.5, weight: 10 },
  { amount: 1, weight: 4 }, { amount: 2, weight: 0.8 }, { amount: 5, weight: 0.2 },
];
const STORE_ERROR = '签到记录无法读取或格式损坏，已暂停发放，请联系管理员检查；请勿删除记录后重领。';
const PENDING_ERROR = '上次签到结果待确认，未再次发放奖励。请稍后重试查询，或联系管理员核对余额流水。';

export function getShanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function randomAmount(random = Math.random) {
  let roll = random() * AMOUNT_TIERS.reduce((sum, tier) => sum + tier.weight, 0);
  for (const tier of AMOUNT_TIERS) {
    roll -= tier.weight;
    if (roll < 0) return tier.amount;
  }
  return AMOUNT_TIERS[0].amount;
}

function userIdString(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(STORE_ERROR);
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) throw new Error('无法确定你的用户 ID，请联系管理员重新绑定。');
  return id;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(parsed.getTime()) && getShanghaiDate(parsed) === value;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function requestKey(userId, date) {
  return `qq-checkin:${userId}:${date}`;
}

function requestNotes(qq, key) {
  return `QQ 签到奖励（QQ:${qq}） [${key}]`;
}

function decodeLedger(raw) {
  if (!object(raw)) throw new Error(STORE_ERROR);
  if (raw.version !== undefined) {
    if (raw.version !== 2 || !object(raw.accounts) || !object(raw.legacyQQ)) throw new Error(STORE_ERROR);
    for (const [id, record] of Object.entries(raw.accounts)) {
      if (!object(record) || userIdString(id) !== id || String(record.userId) !== id
        || !validDate(record.date) || !validAmount(record.amount)
        || !['pending', 'retryable', 'succeeded'].includes(record.status)) throw new Error(STORE_ERROR);
      if (record.status !== 'succeeded' && (!/^\d+$/.test(record.qq)
        || record.idempotencyKey !== requestKey(id, record.date)
        || record.notes !== requestNotes(record.qq, record.idempotencyKey))) throw new Error(STORE_ERROR);
    }
    for (const [qq, record] of Object.entries(raw.legacyQQ)) {
      if (!/^\d+$/.test(qq) || !object(record) || !validDate(record.date)
        || (record.amount !== null && !validAmount(record.amount))) throw new Error(STORE_ERROR);
    }
    return { ledger: raw, legacy: false };
  }

  const ledger = { version: 2, accounts: {}, legacyQQ: {} };
  for (const [qq, old] of Object.entries(raw)) {
    if (!/^\d+$/.test(qq)) throw new Error(STORE_ERROR);
    const record = typeof old === 'string' ? { date: old, amount: null } : old;
    if (!object(record) || !validDate(record.date)
      || (record.amount !== null && record.amount !== undefined && !validAmount(record.amount))) throw new Error(STORE_ERROR);
    if (record.userId === null || record.userId === undefined) {
      ledger.legacyQQ[qq] = { date: record.date, amount: record.amount ?? null };
      continue;
    }
    const id = userIdString(record.userId);
    if (!validAmount(record.amount)) throw new Error(STORE_ERROR);
    if (!ledger.accounts[id] || ledger.accounts[id].date < record.date) {
      ledger.accounts[id] = { userId: id, date: record.date, amount: record.amount, status: 'succeeded', balance: null };
    }
  }
  return { ledger, legacy: Object.keys(raw).length > 0 };
}

// 单进程单实例账本：临时文件、fsync、rename；异常记录不能当成空账本。
export function createCheckinService({ storePath, request, now = () => new Date(), drawAmount = randomAmount, storage = fs }) {
  let ledger = null;
  let legacy = false;
  const locks = new Map();

  function load() {
    if (ledger) return;
    try {
      let raw;
      try { raw = storage.readFileSync(storePath, 'utf8'); }
      catch (err) {
        if (err.code !== 'ENOENT' || storage.existsSync(`${storePath}.tmp`)) throw err;
        ledger = { version: 2, accounts: {}, legacyQQ: {} };
        return;
      }
      ({ ledger, legacy } = decodeLedger(JSON.parse(raw)));
    } catch {
      throw new Error(STORE_ERROR);
    }
  }

  function save() {
    storage.mkdirSync(path.dirname(storePath), { recursive: true });
    if (legacy) {
      try { storage.copyFileSync(storePath, `${storePath}.legacy-backup`, fs.constants.COPYFILE_EXCL); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
      legacy = false;
    }
    const tmp = `${storePath}.tmp`;
    const fd = storage.openSync(tmp, 'w', 0o600);
    try {
      storage.writeFileSync(fd, JSON.stringify(ledger, null, 2), 'utf8');
      storage.fsyncSync(fd);
    } finally { storage.closeSync(fd); }
    storage.renameSync(tmp, storePath);
  }

  function succeed(record, balance) {
    record.status = 'succeeded';
    record.balance = balance;
    // 收到成功响应后，即使落盘失败，内存也必须保持成功，防止当前进程再次加款。
    try { save(); }
    catch { throw new Error('签到奖励已到账，但记录保存失败。请联系管理员修复存储；请勿删除记录后重领。'); }
  }

  async function reconcile(record) {
    // 流水是尽力写入；只接受正向到账证明，绝不把“没有流水”当成未到账。
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ page: String(page), page_size: '100', type: 'admin_balance' });
      let data;
      try { data = await request(`/api/v1/admin/users/${record.userId}/balance-history?${params}`); }
      catch { throw new Error(PENDING_ERROR); }
      if (!Array.isArray(data?.items)) throw new Error(PENDING_ERROR);
      const hit = data.items.find(item => object(item) && item.notes === record.notes && item.type === 'admin_balance'
        && item.status === 'used' && String(item.used_by) === record.userId
        && validAmount(item.value) && Math.abs(item.value - record.amount) < 1e-7);
      if (hit) {
        let balance = null;
        try {
          const user = await request(`/api/v1/admin/users/${record.userId}`);
          if (user?.balance !== null && user?.balance !== undefined && Number.isFinite(Number(user.balance))) balance = Number(user.balance);
        } catch { /* 到账证明已确认，余额展示失败不影响领奖去重。 */ }
        succeed(record, balance);
        return;
      }
      if (data.items.length < 100 || (Number.isInteger(data.pages) && page >= data.pages)) break;
    }
    throw new Error(PENDING_ERROR);
  }

  async function perform(qq, userId) {
    load();
    const today = getShanghaiDate(now());
    if (Object.values(ledger.legacyQQ).some(record => record.date >= today)) {
      throw new Error('存在当日无法归属账号的旧签到记录，已暂停发放，请联系管理员核对；请勿删除记录后重领。');
    }
    let record = ledger.accounts[userId];
    if (record?.date > today) throw new Error('签到记录日期晚于当前日期，已暂停发放，请联系管理员检查系统时间。');
    let recovered = false;
    if (record?.status === 'pending') {
      await reconcile(record);
      recovered = true;
    }
    if (record?.date === today && record.status === 'succeeded') {
      // 修复上次“到账成功但落盘失败”的记录，不重新 POST。
      succeed(record, record.balance ?? null);
      return { ...record, alreadyCheckedIn: true, recovered };
    }
    if (!record || record.date !== today) {
      const amount = drawAmount();
      if (!validAmount(amount) || !AMOUNT_TIERS.some(tier => tier.amount === amount)) throw new Error('签到奖励配置异常，已暂停发放。');
      const idempotencyKey = requestKey(userId, today);
      record = { userId, qq, date: today, amount, idempotencyKey, notes: requestNotes(qq, idempotencyKey), status: 'pending', balance: null };
    } else {
      record = { ...record, status: 'pending' };
    }
    const previous = ledger.accounts[userId];
    ledger.accounts[userId] = record;
    try { save(); }
    catch {
      if (previous) ledger.accounts[userId] = previous;
      else delete ledger.accounts[userId];
      throw new Error('无法保存签到发放记录，本次未发送余额请求，请联系管理员修复存储。');
    }

    let data;
    try {
      data = await request(`/api/v1/admin/users/${userId}/balance`, {
        method: 'POST', idempotencyKey: record.idempotencyKey,
        body: { balance: record.amount, operation: 'add', notes: record.notes },
      });
      if (data?.balance === null || data?.balance === undefined || !Number.isFinite(Number(data.balance))) {
        throw new Error('余额接口未返回有效结果');
      }
    } catch (err) {
      if (err.requestNotSent === true || [401, 403, 429].includes(err.status)) {
        // 登录尚未完成或请求在余额操作前被拒绝，允许用原金额、原 key 和原 payload 重试。
        record.status = 'retryable';
        try { save(); } catch { /* 重启后看到 pending 会保守暂停，不能盲目重发。 */ }
        throw new Error('签到请求尚未发出，或被身份、权限、限流检查拒绝，本次未发放；请稍后重试或联系管理员。');
      }
      throw new Error(PENDING_ERROR);
    }
    succeed(record, Number(data.balance));
    return { ...record, alreadyCheckedIn: false, recovered: false };
  }

  async function checkin(qq, binding) {
    qq = String(qq);
    if (!/^\d+$/.test(qq)) throw new Error('无法确定你的 QQ 号，请重新发送签到指令。');
    let id = binding.userId;
    if (id === null || id === undefined) {
      const params = new URLSearchParams({ search: binding.email, page_size: '100' });
      const users = await request(`/api/v1/admin/users?${params}`);
      id = users?.items?.find(user => String(user.email).toLowerCase() === String(binding.email).toLowerCase())?.id;
    }
    const userId = userIdString(id);
    const previous = locks.get(userId) || Promise.resolve();
    const task = previous.then(() => perform(qq, userId));
    const tail = task.catch(() => {});
    locks.set(userId, tail);
    try { return await task; }
    finally { if (locks.get(userId) === tail) locks.delete(userId); }
  }

  return { checkin };
}
