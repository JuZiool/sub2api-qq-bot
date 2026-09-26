import { config } from './config.js';
import { getDashboardStats } from './sub2api.js';
import { getBinding, bind, unbind, getClient, removeClient, maskEmail } from './bindings.js';

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

// 与 orange 前端口径一致：cache_read / (input + cache_read + cache_creation)
function cacheHitRate(input, cacheRead, cacheCreation) {
  const promptTotal = input + cacheRead + cacheCreation;
  return promptTotal > 0 ? ((cacheRead / promptTotal) * 100).toFixed(1) : '0.0';
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
        '/绑定 <邮箱> <密码> - 绑定账号（仅私聊）',
        '/解绑 - 解除绑定（仅私聊）',
        '/我的 - 查看绑定状态',
        '/用量 - 查询我的今日用量（需绑定）',
        '/状态 - 系统概况（管理员）',
      ].join('\n'),
  },

  {
    // 绑定：/绑定 邮箱 密码（仅私聊，密码不回显不落日志）
    match: (name) => name === '绑定',
    adminOnly: false,
    privateOnly: true,
    run: async ({ args, senderQQ }) => {
      const [email, password] = args;
      if (!email || !password) {
        return '用法：/绑定 邮箱 密码';
      }
      try {
        const client = createUserClient(email, password);
        const profile = await client.verify();
        bind(senderQQ, email, password, profile?.id ?? profile?.user?.id ?? null);
        return `✅ 绑定成功：${maskEmail(email)}`;
      } catch (err) {
        return `绑定失败：${err.message}`;
      }
    },
  },

  {
    match: (name) => name === '解绑',
    adminOnly: false,
    privateOnly: true,
    run: ({ senderQQ }) => {
      if (!getBinding(senderQQ)) {
        return '你还没有绑定账号。';
      }
      unbind(senderQQ);
      removeClient(senderQQ);
      return '✅ 已解除绑定';
    },
  },

  {
    match: (name) => name === '我的',
    adminOnly: false,
    run: ({ senderQQ }) => {
      const b = getBinding(senderQQ);
      if (!b) return '未绑定账号，请私聊我发送：/绑定 邮箱 密码';
      return `已绑定：${b.emailMasked}（${b.boundAt.slice(0, 10)} 起）`;
    },
  },

  {
    match: (name) => name === '用量',
    adminOnly: false,
    run: async ({ senderQQ }) => {
      const client = getClient(senderQQ);
      if (!client) return '未绑定账号，请私聊我发送：/绑定 邮箱 密码';
      const res = await client.request('/api/v1/usage/dashboard/stats');
      // 兼容新旧结构：stats 包裹或直接平铺
      const s = res?.stats ?? res ?? {};
      const input = Number(s.today_input_tokens ?? 0);
      const output = Number(s.today_output_tokens ?? 0);
      const cacheCreation = Number(s.today_cache_creation_tokens ?? 0);
      const cacheRead = Number(s.today_cache_read_tokens ?? 0);
      return [
        '📈 我的今日用量',
        `请求：${fmtNumber(s.today_requests ?? 0)}`,
        `输入：${fmtTokens(input)} ｜ 输出：${fmtTokens(output)}`,
        `缓存：${fmtTokens(cacheCreation + cacheRead)}（创建 ${fmtTokens(cacheCreation)} / 命中 ${fmtTokens(cacheRead)}）`,
        `缓存命中率：${cacheHitRate(input, cacheRead, cacheCreation)}%`,
        `今日费用：$${Number(s.today_actual_cost ?? 0).toFixed(4)}`,
        `累计费用：$${Number(s.total_actual_cost ?? 0).toFixed(4)}`,
      ].join('\n');
    },
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
      return [
        '📊 今日状态',
        `活跃用户：${fmtNumber(s.active_users)}`,
        `输入：${fmtTokens(input)} ｜ 输出：${fmtTokens(output)}`,
        `缓存：${fmtTokens(cacheCreation + cacheRead)}（创建 ${fmtTokens(cacheCreation)} / 命中 ${fmtTokens(cacheRead)}）`,
        `缓存命中率：${cacheHitRate(input, cacheRead, cacheCreation)}%`,
      ].join('\n');
    },
  },
];

export async function handleCommand(text, senderQQ, ctx = {}) {
  const { prefix } = config.bot;
  const trimmed = text.trim();
  if (prefix && !trimmed.startsWith(prefix)) return null;

  const withoutPrefix = prefix ? trimmed.slice(prefix.length).trim() : trimmed;
  if (!withoutPrefix) return null;
  const [name, ...rest] = withoutPrefix.split(/\s+/);
  const args = rest.map((a) => a.trim()).filter(Boolean);

  const cmd = commands.find((c) => c.match(name.toLowerCase()));
  if (!cmd) return null;
  if (cmd.adminOnly && !isAdmin(senderQQ)) {
    return '该指令仅管理员可用。';
  }
  // 绑定/解绑等涉及凭证的指令仅限私聊，防止密码进群聊记录
  if (cmd.privateOnly && !ctx.isPrivate) {
    return '该指令请在私聊中使用。';
  }

  try {
    return await cmd.run({ args, senderQQ, ...ctx });
  } catch (err) {
    console.error(`[command:${name}]`, err.message);
    return `查询失败：${err.message}`;
  }
}
