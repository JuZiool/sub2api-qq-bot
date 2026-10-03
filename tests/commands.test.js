import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const switches = [
  { flag: 'COMMAND_HELP_ENABLED', key: 'help', commands: ['/帮助', '/help'], help: '帮助 -' },
  { flag: 'COMMAND_BIND_ENABLED', key: 'bind', commands: ['/绑定'], help: '绑定 <邮箱>' },
  { flag: 'COMMAND_UNBIND_ENABLED', key: 'unbind', commands: ['/解绑'], help: '解绑 -' },
  { flag: 'COMMAND_CHECKIN_ENABLED', key: 'checkin', commands: ['/签到', '/checkin'], help: '签到 -' },
  { flag: 'COMMAND_USAGE_ENABLED', key: 'usage', commands: ['/今日用量', '/用量'], help: '今日用量 -' },
  { flag: 'COMMAND_SITE_USAGE_ENABLED', key: 'siteUsage', commands: ['/全站用量', '/状态', '/status'], help: '全站用量 -' },
  { flag: 'COMMAND_MODEL_STATUS_ENABLED', key: 'modelStatus', commands: ['/模型状态', '/渠道状态', '/channel'], help: '模型状态 -' },
];

const allEnabled = Object.fromEntries(switches.map(({ flag }) => [flag, 'true']));

function run(command, overrides = {}, options = {}) {
  const env = { ...process.env };
  for (const { flag } of switches) delete env[flag];
  Object.assign(env, options.useDefaults ? {} : allEnabled, overrides, {
    TEST_COMMAND: command,
    DOTENV_CONFIG_PATH: options.useDefaults ? path.join(repo, 'tests', '.missing.env') : path.join(repo, 'tests', '.missing.env'),
  });
  const script = `
    const { config } = await import('./src/config.js');
    const { handleCommand } = await import('./src/commands.js');
    const reply = process.env.TEST_COMMAND
      ? await handleCommand(process.env.TEST_COMMAND, '10000', { isPrivate: false })
      : null;
    process.stdout.write(JSON.stringify({ reply, commands: config.bot.commands }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo, env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('每个关闭的命令及兼容别名均在业务处理前拦截', () => {
  for (const item of switches) {
    for (const command of item.commands) {
      const { reply } = run(command, { [item.flag]: 'false' });
      assert.equal(reply, '该指令暂未开放。', `${command} 应被 ${item.flag} 关闭`);
    }
  }
});

test('帮助菜单只展示开启命令并使用配置前缀', () => {
  const { reply } = run('!帮助', {
    BOT_COMMAND_PREFIX: '!',
    COMMAND_CHECKIN_ENABLED: '0',
  });
  assert.match(reply, /!帮助 -/);
  assert.match(reply, /!绑定 <邮箱>/);
  assert.doesNotMatch(reply, /签到 -/);
  assert.doesNotMatch(reply, /^\//m);
});

test('命令开关默认值和 1/0 解析正确', () => {
  const defaults = run('', {}, { useDefaults: true }).commands;
  assert.deepEqual(defaults, {
    help: true, bind: true, unbind: true, checkin: false,
    usage: true, siteUsage: true, modelStatus: true,
  });
  const parsed = run('', Object.fromEntries(switches.map(({ flag }, index) => [flag, index % 2 ? '0' : '1']))).commands;
  switches.forEach(({ key }, index) => assert.equal(parsed[key], index % 2 === 0));
});

test('WSLC 部署脚本透传全部命令开关', () => {
  const deploy = fs.readFileSync(path.join(repo, 'deploy', 'wslc-deploy.ps1'), 'utf8');
  switches.forEach(({ flag }) => assert.match(deploy, new RegExp(`'${flag}'`)));
});
