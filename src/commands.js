import { config } from './config.js';
import { getDashboardStats } from './sub2api.js';

function fmtNumber(n) {
  return Number(n ?? 0).toLocaleString('zh-CN');
}

function fmtTokens(n) {
  n = Number(n ?? 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function isAdmin(qq) {
  const { adminQQList } = config.bot;
  if (adminQQList.length === 0) return true;
  return adminQQList.includes(String(qq));
}

// 指令处理器：run 返回纯文本回复；整体返回 null 表示忽略该消息
const commands = [
  {
    match: (name) => name === '帮助' || name === 'help',
    adminOnly: false,
    run: () =>
      [
        'sub2api 查询机器人',
        '指令列表：',
        '/状态 - 查看今日用量概况（管理员）',
      ].join('\n'),
  },

  {
    match: (name) => name === '状态' || name === 'status',
    adminOnly: true,
    run: async () => {
      const res = await getDashboardStats();
      // 兼容两种响应结构：新版包裹在 stats 里，旧版直接平铺在 data 中
      const s = res?.stats ?? res ?? {};
      const input = Number(s.today_input_tokens ?? 0);
      const output = Number(s.today_output_tokens ?? 0);
      const cacheCreation = Number(s.today_cache_creation_tokens ?? 0);
      const cacheRead = Number(s.today_cache_read_tokens ?? 0);
      // 与 orange 前端口径一致：cache_read / (input + cache_read + cache_creation)
      const promptTotal = input + cacheRead + cacheCreation;
      const hitRate = promptTotal > 0 ? ((cacheRead / promptTotal) * 100).toFixed(1) : '0.0';
      return [
        '📊 今日状态',
        `活跃用户：${fmtNumber(s.active_users)}`,
        `输入：${fmtTokens(input)} ｜ 输出：${fmtTokens(output)}`,
        `缓存：${fmtTokens(cacheCreation + cacheRead)}（创建 ${fmtTokens(cacheCreation)} / 命中 ${fmtTokens(cacheRead)}）`,
        `缓存命中率：${hitRate}%`,
      ].join('\n');
    },
  },
];

export async function handleCommand(text, senderQQ) {
  const { prefix } = config.bot;
  const trimmed = text.trim();
  if (prefix && !trimmed.startsWith(prefix)) return null;

  const withoutPrefix = prefix ? trimmed.slice(prefix.length).trim() : trimmed;
  if (!withoutPrefix) return null;
  const [name] = withoutPrefix.split(/\s+/);

  const cmd = commands.find((c) => c.match(name.toLowerCase()));
  if (!cmd) return null;
  if (cmd.adminOnly && !isAdmin(senderQQ)) {
    return '该指令仅管理员可用。';
  }

  try {
    return await cmd.run();
  } catch (err) {
    console.error(`[command:${name}]`, err);
    return `查询失败：${err.message}`;
  }
}
