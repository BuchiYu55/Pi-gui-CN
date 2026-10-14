import { readFileSync } from 'node:fs';
const expr = readFileSync(new URL("./verify-zai-footer-page.js", import.meta.url), "utf8"); // 随脚本同目录（tests/），不再硬编码仓库根路径
const ws = new WebSocket('ws://127.0.0.1:9223/json/version'.length ? (await (await fetch('http://127.0.0.1:9223/json/version')).json()).webSocketDebuggerUrl : null);
let id = 1;
function send(method, params) { return new Promise((res) => { const i = id++; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); res(m.result); } }); ws.send(JSON.stringify({ id: i, method, params })); }); }
await new Promise(r => ws.addEventListener('open', r));
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
const ws2 = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws2.addEventListener('open', r));
let id2 = 1;
const evalRes = await new Promise((res) => {
  const i = id2++;
  ws2.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === i) { ws2.removeEventListener('message', h); res(m.result); } });
  ws2.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(evalRes.result.value, null, 1));
ws.close(); ws2.close();
