import 'dotenv/config';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  onebot: {
    wsUrl: process.env.ONEBOT_WS_URL || 'ws://napcat:3001',
    accessToken: process.env.ONEBOT_ACCESS_TOKEN || '',
  },
  sub2api: {
    baseUrl: (process.env.SUB2API_BASE_URL || 'http://host.docker.internal:8080').replace(/\/+$/, ''),
    email: process.env.SUB2API_ADMIN_EMAIL || '',
    password: process.env.SUB2API_ADMIN_PASSWORD || '',
  },
  bot: {
    prefix: process.env.BOT_COMMAND_PREFIX || '/',
    adminQQList: (process.env.ADMIN_QQ_LIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    respondGroup: bool(process.env.RESPOND_GROUP, true),
    respondPrivate: bool(process.env.RESPOND_PRIVATE, true),
    commands: {
      help: bool(process.env.COMMAND_HELP_ENABLED, true),
      bind: bool(process.env.COMMAND_BIND_ENABLED, true),
      unbind: bool(process.env.COMMAND_UNBIND_ENABLED, true),
      checkin: bool(process.env.COMMAND_CHECKIN_ENABLED, false),
      usage: bool(process.env.COMMAND_USAGE_ENABLED, true),
      siteUsage: bool(process.env.COMMAND_SITE_USAGE_ENABLED, true),
      modelStatus: bool(process.env.COMMAND_MODEL_STATUS_ENABLED, true),
    },
  },
};
