import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../seed-config.mjs', import.meta.url));
function fixture(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-wslc-seed-test-'));
  try {
    const input = path.join(temp, 'seed'); const config = path.join(temp, 'config');
    fs.mkdirSync(input); fs.mkdirSync(config);
    const seed = { account: '12345', webui: {host:'0.0.0.0',port:6099,token:'test-webui'},
      server: {name:'qq-bot-wslc',enable:true,host:'0.0.0.0',port:3001,token:'test-onebot'} };
    const writeSeed = () => fs.writeFileSync(path.join(input,'config-seed.json'),JSON.stringify(seed));
    const exec = () => {writeSeed(); return spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,WSLC_SEED_DIRECTORY:input,WSLC_CONFIG_DIRECTORY:config}});};
    run({config,seed,exec});
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved),/^qq-bot-wslc-seed-test-/);
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

test('首次准备全局、账号 OneBot 配置且不输出 token', () => fixture(({config,exec}) => {
  const result=exec(); assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes('test-webui') && !result.stdout.includes('test-onebot'));
  for(const name of ['onebot11.json','onebot11_12345.json']) {
    const cfg=JSON.parse(fs.readFileSync(path.join(config,name)));
    assert.equal(cfg.network.websocketServers[0].token,'test-onebot');
  }
}));
test('重复准备不改现有 WebUI/用户配置，不制造重复 WS 或备份', () => fixture(({config,exec}) => {
  const webui=path.join(config,'webui.json'); fs.writeFileSync(webui,'{"token":"user-token","custom":true}');
  const file=path.join(config,'onebot11.json');
  fs.writeFileSync(file,JSON.stringify({custom:'keep',network:{httpServers:[{port:1234}],websocketServers:[]}}));
  assert.equal(exec().status,0); const first=fs.readFileSync(file,'utf8'); const names=fs.readdirSync(config);
  assert.equal(exec().status,0); assert.equal(fs.readFileSync(file,'utf8'),first);
  assert.deepEqual(fs.readdirSync(config),names);
  assert.equal(JSON.parse(fs.readFileSync(file)).custom,'keep');
  assert.equal(JSON.parse(fs.readFileSync(webui)).token,'user-token');
}));
test('token 变化只更新自有 WS 条目，旧配置保留备份', () => fixture(({config,seed,exec}) => {
  assert.equal(exec().status,0); seed.server.token='changed'; assert.equal(exec().status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config,'onebot11.json'))).network.websocketServers[0].token,'changed');
  assert.ok(fs.readdirSync(config).some(name=>name.startsWith('onebot11.json.backup-')));
}));
test('发现其它 WS 占用 3001 时拒绝覆盖', () => fixture(({config,exec}) => {
  const file=path.join(config,'onebot11.json');
  const old=JSON.stringify({network:{websocketServers:[{name:'user',enable:true,port:3001}]}});
  fs.writeFileSync(file,old); assert.notEqual(exec().status,0); assert.equal(fs.readFileSync(file,'utf8'),old);
}));
