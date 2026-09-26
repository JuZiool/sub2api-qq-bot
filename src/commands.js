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

function fmtCost(n) {
  return `$${Number(n ?? 0).toFixed(4)}`;
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
        '/状态 - 查看系统运行概况（管理员）',
      ].join('\n'),
  },

  {
    match: (name) => name === '状态' || name === 'status',
    adminOnly: true,
    run: async () => {
      const res = await getDashboardStats();
      // 兼容两种响应结构：新版包裹在 stats 里，旧版直接平铺在 data 中
      const s = res?.stats ?? res ?? {};
      return [
        '📊 系统状态',
        '—— 用户 ——',
        `总用户：${fmtNumber(s.total_users)}（今日新增 ${fmtNumber(s.today_new_users)}）`,
        `今日活跃：${fmtNumber(s.active_users)}`,
        '—— 账号 ——',
        `总账号：${fmtNumber(s.total_accounts)}｜正常 ${fmtNumber(s.normal_accounts)}｜限流 ${fmtNumber(s.ratelimit_accounts)}｜异常 ${fmtNumber(s.error_accounts)}`,
        '—— 今日用量 ——',
        `请求：${fmtNumber(s.today_requests)}｜RPM ${fmtNumber(s.rpm)}｜TPM ${fmtNumber(s.tpm)}`,
        `Token：${fmtTokens(s.today_tokens)}（输入 ${fmtTokens(s.today_input_tokens)} / 输出 ${fmtTokens(s.today_output_tokens)}）`,
        `费用：${fmtCost(s.today_actual_cost)}（实际扣除）`,
        '—— 累计 ——',
        `请求：${fmtNumber(s.total_requests)}｜Token：${fmtTokens(s.total_tokens)}｜费用：${fmtCost(s.total_actual_cost)}`,
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
