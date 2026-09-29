import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { adminClient } from './sub2api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'data', 'checkins.json');

// 签到状态：QQ号 → 最近一次签到的上海日期（YYYY-MM-DD）
// 仅用于每日一次去重，余额发放走管理员接口，后台可凭 notes 对账
let checkins = {};

function load() {
  try {
    checkins = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    checkins = {};
  }
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checkins, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

load();

export function getShanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// 今日是否已签到；已签到时返回记录（含金额）
export function getTodayCheckin(qq) {
  const record = checkins[String(qq)];
  return record && record.date === getShanghaiDate() ? record : null;
}

// 奖励金额：对数均匀分布 10^(-2u)，u~U[0,1)
// 金额每翻 10 倍概率衰减一个数量级（≥0.5 约 15%，≥0.9 约 2.2%）
export function randomAmount() {
  const u = Math.random();
  const amount = Math.round(10 ** (-2 * u) * 100) / 100;
  return Math.max(amount, 0.01);
}

// 兜底：绑定记录缺失 userId 时用管理员接口按邮箱查询
async function findUserIdByEmail(email) {
  const params = new URLSearchParams({ search: email, page_size: '1' });
  const data = await adminClient.request(`/api/v1/admin/users?${params.toString()}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  const hit = items.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  return hit?.id ?? null;
}

// 签到并发放奖励：返回 { amount, balance, userId }
export async function checkin(qq, binding) {
  let userId = binding.userId ?? (await findUserIdByEmail(binding.email));
  if (!userId) {
    throw new Error('无法确定你的用户 ID，请联系管理员重新绑定（/解绑 后 /绑定）');
  }

  const amount = randomAmount();
  // notes 记录 QQ 号便于后台对账；后端对该操作有短期幂等保护
  const data = await adminClient.request(`/api/v1/admin/users/${userId}/balance`, {
    method: 'POST',
    body: { balance: amount, operation: 'add', notes: `QQ 签到奖励（QQ:${qq}）` },
  });

  checkins[String(qq)] = { date: getShanghaiDate(), amount, userId };
  save();
  const rawBalance = data?.balance;
  return {
    amount,
    balance: rawBalance === undefined || rawBalance === null ? null : Number(rawBalance),
    userId,
  };
}
