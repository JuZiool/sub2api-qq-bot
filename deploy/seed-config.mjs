import fs from 'node:fs';
import path from 'node:path';

// 只管理初次部署配置及本脚本创建的 WS 服务，不覆盖用户的其它配置。
const seedRoot = process.env.WSLC_SEED_DIRECTORY || '/seed';
const seed = JSON.parse(fs.readFileSync(path.join(seedRoot, 'config-seed.json'), 'utf8'));
const root = process.env.WSLC_CONFIG_DIRECTORY || '/config';
fs.mkdirSync(root, { recursive: true });
function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const webui = path.join(root, 'webui.json');
if (!fs.existsSync(webui)) writeJson(webui, seed.webui);
const names = ['onebot11.json'];
if (seed.account) names.push(`onebot11_${seed.account}.json`);
for (const name of names) {
  const file = path.join(root, name);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const cfg = previous ? JSON.parse(previous) : { network: {} };
  cfg.network ??= {};
  cfg.network.websocketServers ??= [];
  const servers = cfg.network.websocketServers;
  const owned = servers.find(server => server.name === 'qq-bot-wslc');
  if (servers.some(server => server !== owned && server.enable && Number(server.port) === 3001)) {
    throw new Error('OneBot 3001 已由其它配置占用，请先在 WebUI 检查；未覆盖该配置。');
  }
  const desired = { ...owned, ...seed.server };
  if (owned) Object.assign(owned, desired);
  else servers.push(desired);
  const next = JSON.stringify(cfg, null, 2);
  if (previous !== next) {
    if (previous) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
    writeJson(file, cfg);
  }
}
console.log('NapCat 配置已准备，原配置已保留或备份；未输出 token。');
