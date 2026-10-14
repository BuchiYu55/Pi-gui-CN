/**
 * 自由浏览器 web tab 验证（2026-10-08 计划书阶段二 3a）：
 * ① UI 路径开 tab（__openWebTab 钩子 → openWebTab 真实链路）+ 标题事件回填；
 * ② 地址栏回车导航 → tab 标题/URL 跟随（web_event）；③ 双 web tab 保活切换；
 * ④ vw-x 关 tab → webList 收缩；⑤ 全关 → 查看器收起 + webList 空。
 * 自带 http fixture（临时端口），零外网依赖。
 * 用法：PI_GUI_CDP_PORT=9223 起无头实例后 node tests/verify-webtab.mjs 9223
 */
import http from "node:http";

const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE1 = `<!DOCTYPE html><html><head><title>PIGUI 测试页</title></head>
<body style="height:2000px;font-family:sans-serif">
<h1>PIGUI 测试页</h1>
<p id="status">初始状态</p>
<button id="btn1">已点击 0 次</button>
<input id="inp1" placeholder="输入框">
<p><a id="lnk2" href="/page2">去第二页</a></p>
<script>
let n = 0;
document.getElementById('btn1').addEventListener('click', () => { n++; document.getElementById('btn1').textContent = '已点击 ' + n + ' 次'; });
document.getElementById('inp1').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('status').textContent = '已提交：' + document.getElementById('inp1').value; });
</script></body></html>`;
const PAGE2 = `<!DOCTYPE html><html><head><title>PIGUI 第二页</title></head><body><h1>这是第二页</h1><a href="/">回第一页</a></body></html>`;

async function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/page2") ? PAGE2 : PAGE1);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

const nextId = { n: 1 };
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const { server, port } = await startFixture();
  const base = `http://127.0.0.1:${port}`;
  try {
    const target = await findTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    const call = (expression, ap = false) =>
      new Promise((resolve, reject) => {
        const id = nextId.n++;
        const onMsg = (ev) => {
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg?.id !== id) return;
          ws.removeEventListener("message", onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result?.result?.value);
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: ap } }));
      });

    for (let i = 0; i < 30; i++) {
      const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
      if (st === true) break;
      await sleep(1000);
    }

    // ① UI 路径开 tab + 标题回填
    await call(`window.__openWebTab(${JSON.stringify(base + "/")}); true`);
    let tabName = "";
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      tabName = String(await call(`(() => { const t = [...document.querySelectorAll('.vw-tab')]; return t.length ? t[0].textContent.replace(/×$/, "") : ""; })()`));
      if (tabName.includes("PIGUI")) break;
    }
    check("①web tab 打开 + 标题事件回填", tabName.includes("PIGUI 测试页"), tabName);
    const urlVal = await call(`document.getElementById('vw-web-url')?.value ?? ""`);
    check("①地址栏显示 URL", urlVal.includes(String(port)), urlVal);
    const list1 = JSON.parse(await call(`window.pi.webList().then((l) => JSON.stringify(l)).catch(() => "[]")`, true));
    check("①webList 有记录", list1.length === 1 && list1[0].title === "PIGUI 测试页", JSON.stringify(list1));

    // ② 地址栏回车导航到 /page2
    await call(`(() => {
      const i = document.getElementById('vw-web-url');
      i.value = ${JSON.stringify(base + "/page2")};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    let tabName2 = "";
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      tabName2 = String(await call(`(() => { const t = [...document.querySelectorAll('.vw-tab')]; return t.length ? t[0].textContent.replace(/×$/, "") : ""; })()`));
      if (tabName2.includes("第二页")) break;
    }
    check("②回车导航 + 标题跟随", tabName2.includes("PIGUI 第二页"), tabName2);

    // ③ 双 web tab + 保活切换
    await call(`window.__openWebTab(${JSON.stringify(base + "/")}); true`);
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const n = Number(await call(`document.querySelectorAll('.vw-tab').length`));
      if (n >= 2) break;
    }
    const tabs3 = Number(await call(`document.querySelectorAll('.vw-tab').length`));
    check("③双 web tab", tabs3 === 2, String(tabs3));
    // 切到 tab1（page2），再切回 tab2（page1），地址栏应各自保持（保活）
    await call(`document.querySelectorAll('.vw-tab')[0].click(); true`);
    await sleep(400);
    const urlA = await call(`document.getElementById('vw-web-url')?.value ?? ""`);
    await call(`document.querySelectorAll('.vw-tab')[1].click(); true`);
    await sleep(400);
    const urlB = await call(`document.getElementById('vw-web-url')?.value ?? ""`);
    await call(`document.querySelectorAll('.vw-tab')[0].click(); true`);
    await sleep(400);
    const urlA2 = await call(`document.getElementById('vw-web-url')?.value ?? ""`);
    check("③切换保活（URL 各自保持）", urlA.includes("/page2") && !urlB.includes("/page2") && urlA2.includes("/page2"), `${urlA} | ${urlB} | ${urlA2}`);

    // ④ 关一个 tab（vw-x）
    await call(`(() => { const x = document.querySelectorAll('.vw-tab')[1].querySelector('.vw-x'); x.click(); return true; })()`);
    await sleep(600);
    const list4 = JSON.parse(await call(`window.pi.webList().then((l) => JSON.stringify(l)).catch(() => "[]")`, true));
    check("④关 tab 后 webList 收缩", list4.length === 1, JSON.stringify(list4.map((t) => t.id)));

    // ⑤ 全关 → 查看器收起 + webList 空
    await call(`(() => { const x = document.querySelectorAll('.vw-tab')[0].querySelector('.vw-x'); x.click(); return true; })()`);
    await sleep(600);
    const list5 = JSON.parse(await call(`window.pi.webList().then((l) => JSON.stringify(l)).catch(() => "[]")`, true));
    const viewerHidden = await call(`document.getElementById('viewer').classList.contains('hidden')`);
    check("⑤全关后查看器收起 + webList 空", list5.length === 0 && viewerHidden === true, `list=${list5.length} hidden=${viewerHidden}`);
  } finally {
    server.close();
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 250));
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
run();
