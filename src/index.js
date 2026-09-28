import WebSocket from 'ws';
import { config } from './config.js';
import { handleCommand } from './commands.js';

let ws = null;
let reconnectDelay = 3000;
let closedByUs = false;

// OneBot v11 action 调用（通过 forward WebSocket）
let echoSeq = 0;
const pendingCalls = new Map();

function callAction(action, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('OneBot 连接未就绪'));
    }
    const echo = `call_${Date.now()}_${++echoSeq}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(echo);
      reject(new Error(`OneBot 调用超时：${action}`));
    }, timeoutMs);

    pendingCalls.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function messageSegments(reply) {
  if (reply && typeof reply === 'object' && reply.type === 'image') {
    return [{ type: 'image', data: reply.data }];
  }
  return [{ type: 'text', data: { text: String(reply) } }];
}

async function sendReply(action, target, reply) {
  try {
    await callAction(action, { ...target, message: messageSegments(reply) });
  } catch (err) {
    if (!reply || typeof reply !== 'object' || !reply.fallbackText) throw err;
    console.error('[onebot] 图片发送失败，回退文本：', err.message);
    await callAction(action, { ...target, message: messageSegments(reply.fallbackText) });
  }
}

async function sendGroupMessage(groupId, reply) {
  await sendReply('send_group_msg', { group_id: groupId }, reply);
}

async function sendPrivateMessage(userId, reply) {
  await sendReply('send_private_msg', { user_id: userId }, reply);
}
// 处理 OneBot 事件
async function handleEvent(event) {
  if (event.post_type !== 'message') return;
  if (event.message_type === 'group' && !config.bot.respondGroup) return;
  if (event.message_type === 'private' && !config.bot.respondPrivate) return;

  // 提取纯文本（忽略图片、@ 等段以外的内容）
  const text = (event.message || [])
    .filter((seg) => seg.type === 'text')
    .map((seg) => seg.data?.text || '')
    .join('');

  if (!text.trim()) return;

  const reply = await handleCommand(
    text,
    event.sender?.user_id,
    { isPrivate: event.message_type === 'private' },
  );
  if (!reply) return;

  if (event.message_type === 'group') {
    await sendGroupMessage(event.group_id, reply);
  } else {
    await sendPrivateMessage(event.user_id, reply);
  }
}

function connect() {
  closedByUs = false;
  const headers = {};
  if (config.onebot.accessToken) {
    headers.Authorization = `Bearer ${config.onebot.accessToken}`;
  }

  ws = new WebSocket(config.onebot.wsUrl, { headers });

  ws.on('open', () => {
    console.log(`[onebot] 已连接 ${config.onebot.wsUrl}`);
    reconnectDelay = 3000;
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // action 调用结果
    if (data.echo && pendingCalls.has(data.echo)) {
      const pending = pendingCalls.get(data.echo);
      pendingCalls.delete(data.echo);
      clearTimeout(pending.timer);
      if (data.status === 'failed') {
        pending.reject(new Error(data.message || `调用失败（retcode=${data.retcode}）`));
      } else {
        pending.resolve(data.data);
      }
      return;
    }
    handleEvent(data).catch((err) => console.error('[event]', err));
  });

  ws.on('error', (err) => console.error('[onebot] 连接错误：', err.message));

  ws.on('close', () => {
    if (closedByUs) return;
    console.log(`[onebot] 连接断开，${reconnectDelay / 1000}s 后重连`);
    for (const pending of pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OneBot 连接已断开'));
    }
    pendingCalls.clear();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });
}

connect();

console.log(`sub2api-qq-bot 已启动（指令前缀：${config.bot.prefix}）`);
