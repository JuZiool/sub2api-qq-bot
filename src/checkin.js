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

// 签到奖励档位（美元）：额度越大权重越低，权重合计 100
// 均值约 $0.22/天，$2 约 0.8%、$5 约 0.2% 保底稀有感
const AMOUNT_TIERS = [
  { amount: 0.05, weight: 35 },
  { amount: 0.1, weight: 30 },
  { amount: 0.3, weight: 20 },
  { amount: 0.5, weight: 10 },
  { amount: 1, weight: 4 },
  { amount: 2, weight: 0.8 },
  { amount: 5, weight: 0.2 },
];

// 按权重随机抽取一个档位金额
export function randomAmount() {
  const total = AMOUNT_TIERS.reduce((sum, tier) => sum + tier.weight, 0);
  let roll = Math.random() * total;
  for (const tier of AMOUNT_TIERS) {
    roll -= tier.weight;
    if (roll < 0) return tier.amount;
  }
  return AMOUNT_TIERS[0].amount;
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
