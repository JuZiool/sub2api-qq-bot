import WebSocket from 'ws';

const result = { api: false, onebot: false, qqLoggedIn: false };
try {
  const url = process.env.SUB2API_BASE_URL.replace(/\/+$/, '') + '/health';
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  result.api = response.ok && (await response.json()).status === 'ok';
} catch {}
await new Promise(resolve => {
  const headers = process.env.ONEBOT_ACCESS_TOKEN
    ? { Authorization: 'Bearer ' + process.env.ONEBOT_ACCESS_TOKEN } : {};
  const ws = new WebSocket(process.env.ONEBOT_WS_URL, { headers, handshakeTimeout: 5000 });
  const timer = setTimeout(done, 6000);
  function done() {
    clearTimeout(timer);
    ws.terminate();
    resolve();
  }
  ws.on('error', done);
  ws.on('open', () => {
    result.onebot = true;
    ws.send(JSON.stringify({ action: 'get_login_info', echo: 'wslc-probe' }));
  });
  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      if (data.echo === 'wslc-probe') {
        result.qqLoggedIn = data.status === 'ok' && !!data.data?.user_id;
        done();
      }
    } catch {}
  });
});
console.log(JSON.stringify(result));
