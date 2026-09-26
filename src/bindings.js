import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createUserClient } from './sub2api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'data', 'bindings.json');

// QQ号 → 绑定信息 { email, password, userId, emailMasked, boundAt }
// 凭证仅保存在本地 data/bindings.json，不进 git、不打日志
let bindings = {};

function load() {
  try {
    bindings = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    bindings = {};
  }
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  // 先写临时文件再替换，避免写一半损坏
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

load();

export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  const head = name.slice(0, 1);
  return `${head}***@${domain}`;
}

export function getBinding(qq) {
  return bindings[String(qq)] || null;
}

export function bind(qq, email, password, userId) {
  bindings[String(qq)] = {
    email,
    password,
    userId: userId ?? null,
    emailMasked: maskEmail(email),
    boundAt: new Date().toISOString(),
  };
  save();
}

export function unbind(qq) {
  if (!bindings[String(qq)]) return false;
  delete bindings[String(qq)];
  save();
  return true;
}

// 取绑定用户的 API 客户端（含短时 token 缓存）
const clientCache = new Map();

export function getClient(qq) {
  const b = getBinding(qq);
  if (!b) return null;
  const key = String(qq);
  if (!clientCache.has(key)) {
    clientCache.set(key, createUserClient(b.email, b.password));
  }
  return clientCache.get(key);
}

export function removeClient(qq) {
  clientCache.delete(String(qq));
}
