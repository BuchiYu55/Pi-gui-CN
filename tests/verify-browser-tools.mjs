/**
 * 浏览器 agent 操作套件验证（2026-10-08 计划书阶段二 3b，自闭环）：
 * spawn 自带 PI_GUI_TEST_BROWSER=1 的无头实例 + http fixture，经 web:testTool 直调工具 execute
 * （与真实注册同一函数体，零 token）：open → snapshot → click → type → press → scroll → read → tabs → screenshot。
 * 用法：node tests/verify-browser-tools.mjs（自带起实例 9261 + 杀清场）
 */
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9261;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const PAGE1 = `<!DOCTYPE html><html><head><title>PIGUI 测试页</title></head>
<body style="height:5000px;font-family:sans-serif">
<h1>PIGUI 测试页</h1>
<p id="status">初始状态</p>
<button id="btn1">已点击 0 次</button>
<input id="inp1" placeholder="输入框">
<p><a href="/page2">去第二页</a></p>
<script>
let n = 0;
document.getElementById('btn1').addEventListener('click', () => { n++; document.getElementById('btn1').textContent = '已点击 ' + n + ' 次'; });
document.getElementById('inp1').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('status').textContent = '已提交：' + document.getElementById('inp1').value; });
</script></body></html>`;
const PAGE2 = `<!DOCTYPE html><html><head><title>PIGUI 第二页</title></head><body><h1>这是第二页</h1></body></html>`;

async function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/page2") ? PAGE2 : PAGE1);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

const userData = path.join(os.tmpdir(), "pi-gui-browsertools-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null, logs = [];

async function main() {
  const { server, port } = await startFixture();
  const base = `http://127.0.0.1:${port}`;
  try {
    app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
      cwd: ROOT,
      env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd"), PI_GUI_TEST_BROWSER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    app.stdout.on("data", (d) => logs.push(String(d)));
    app.stderr.on("data", (d) => logs.push(String(d)));
    let ok = false;
    for (let i = 0; i < 30; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) { ok = true; break; } } } catch {}
      await sleep(500);
    }
    check("实例启动（无头+TEST_BROWSER）", ok, ok ? "" : logs.join("").slice(-300));
    if (!ok) throw new Error("CDP 未就绪");

    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
    let n = 1;
    const call = (expr, ap = false) => new Promise((res, rej) => {
      const id = n++;
      const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener("message", onMsg); d.result?.exceptionDetails ? rej(new Error(String(d.result.exceptionDetails.text ?? "page error"))) : res(d.result?.result?.value); } } catch {} };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: ap } }));
      setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 30000);
    });
    // 工具直调（web:testTool → WEB_TOOL_EXECS 同一 execute）
    const tool = (name, params) => call(`window.pi.testBrowserTool(${JSON.stringify(name)}, ${JSON.stringify(params ?? {})}).then((r) => JSON.stringify(r)).catch((e) => JSON.stringify({ isError: true, content: [{ text: "ERR:" + e.message }] }))`, true).then((s) => JSON.parse(s));
    const toolText = (r) => r?.content?.[0]?.text ?? "";

    // 会话就绪（工具注册发生在 createSession 工厂，需先有会话）
    for (let i = 0; i < 30; i++) {
      const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
      if (st === true) break;
      await sleep(1000);
    }
    await sleep(1500); // 工厂注册落地 grace

    // ① browser_open
    const r1 = await tool("browser_open", { url: base + "/" });
    check("①browser_open 打开+提取", !r1.isError && toolText(r1).includes("已打开") && toolText(r1).includes("PIGUI 测试页"), toolText(r1).slice(0, 80));

    // ② browser_snapshot
    const r2 = await tool("browser_snapshot", {});
    const snapText = toolText(r2);
    const btnRef = (snapText.match(/\[(e\d+)\] <button>/) ?? [])[1];
    const inpRef = (snapText.match(/\[(e\d+)\] <input>/) ?? [])[1];
    check("②snapshot 列元素", !r2.isError && !!btnRef && !!inpRef && snapText.includes("已点击 0 次"), `btn=${btnRef} inp=${inpRef}`);

    // ③ browser_click
    const r3 = await tool("browser_click", { ref: btnRef });
    check("③click 执行", !r3.isError && toolText(r3).includes("已点击"), toolText(r3).slice(0, 60));
    const r3b = await tool("browser_snapshot", {});
    check("③点击生效（按钮计数 1）", toolText(r3b).includes("已点击 1 次"), "");

    // ④ browser_type + press
    const r4 = await tool("browser_type", { ref: inpRef, text: "你好浏览器" });
    check("④type 执行", !r4.isError && toolText(r4).includes("已输入"), toolText(r4).slice(0, 60));
    const r4b = await tool("browser_press", { key: "Enter" });
    const r4c = await tool("browser_read", {});
    check("④press 回车提交（页面监听生效）", !r4b.isError && toolText(r4c).includes("已提交：你好浏览器"), toolText(r4c).slice(0, 120));

    // ⑤ browser_scroll
    const r5 = await tool("browser_scroll", { dy: 300 });
    const m5 = toolText(r5).match(/scrollY=(\d+)/);
    check("⑤scroll 执行", !r5.isError && m5 && Number(m5[1]) >= 250, toolText(r5));

    // ⑥ browser_tabs list/new/select/close
    const r6 = await tool("browser_tabs", { action: "new", url: base + "/page2" });
    check("⑥tabs new", !r6.isError && toolText(r6).includes("已新开"), toolText(r6).slice(0, 60));
    const r6b = await tool("browser_tabs", { action: "list" });
    check("⑥tabs list 两个", toolText(r6b).includes("w1") && toolText(r6b).includes("w2"), toolText(r6b).slice(0, 100));
    const r6c = await tool("browser_read", {}); // 读的是 agent 目标 tab（w2 第二页）
    check("⑥agent 目标已切新 tab", toolText(r6c).includes("PIGUI 第二页"), toolText(r6c).slice(0, 60));
    const r6d = await tool("browser_tabs", { action: "close", tabId: "w2" });
    check("⑥tabs close", !r6d.isError && toolText(r6d).includes("已关闭"), toolText(r6d));

    // ⑦ browser_screenshot
    const r7 = await tool("browser_screenshot", {});
    const shotPath = (toolText(r7).match(/已保存：(.+)$/) ?? [])[1];
    check("⑦screenshot 落盘", !r7.isError && !!shotPath && fs.existsSync(shotPath), toolText(r7).slice(0, 80));

    // ⑧ 容器底线：坏 ref 文本化报错
    const r8 = await tool("browser_click", { ref: "e999" });
    check("⑧ref 失效文本化报错", r8.isError === true && toolText(r8).includes("不存在"), toolText(r8).slice(0, 60));
  } finally {
    server.close();
  }
}

try {
  await main();
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 250));
} finally {
  try { app?.kill(); } catch {}
  await sleep(400);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
