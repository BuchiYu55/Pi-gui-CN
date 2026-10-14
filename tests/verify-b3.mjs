/**
 * B3 启动自检报告验证（2026-10-07 优化计划 B 批次）：
 *   预写假 fatal 到测试 userData/run.err.log → 起实例 → 断言：
 *   ①fatal 提示条出现（含 kind）②preload 暴露 openFatalLog/ackFatalLog
 *   ③点 × → bar 消失且 run.err.log 重命名 .acked（确认语义）
 *   ④同 userData 二次启动 → 不再提示。
 *   不点「查看日志」——shell.openPath 会真弹记事本打扰 owner（打开功能由代码路径保证+人工验收）。
 * 自闭环：独立 userData + 端口 9242。用法：node tests/verify-b3.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9242;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? "  [" + info + "]" : ""}`);
};

async function waitCDP(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; }
    } catch { /* 未起 */ }
    await sleep(300);
  }
  return false;
}
async function pageEval(expr, { awaitPromise = false } = {}) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const v = await new Promise((res, rej) => {
    const id = Date.now() % 1e6 + 1;
    ws.onmessage = (m) => {
      try { const d = JSON.parse(m.data); if (d.id === id) res(d.result?.result?.value); } catch { /* 忽略 */ }
    };
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => rej(new Error("evaluate 超时")), 10000);
  });
  ws.close();
  return v;
}
function killInstance() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 已释放 */ }
}
async function startInstance(userData) {
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", () => {});
  app.stderr.on("data", () => {});
  return app;
}

const userData = path.join(os.tmpdir(), "pi-gui-b3-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "run.err.log"),
  `[2026-10-07T10:00:00.000Z] [uncaughtException] Error: 假 fatal 供验证\n    at fake\n[2026-10-07T10:05:00.000Z] [dispose-timeout] entry=s99 budget=800ms\n`);
let app = null;
try {
  // ---- 第一次启动：应提示 ----
  app = await startInstance(userData);
  check("实例启动（预置 2 条假 fatal）", await waitCDP());
  let barText = null;
  for (let i = 0; i < 20; i++) {
    barText = await pageEval(`document.getElementById("fatal-notice-bar")?.textContent ?? null`).catch(() => null);
    if (barText) break;
    await sleep(500);
  }
  check("①提示条出现且指认最后一条 fatal", !!barText && /dispose-timeout/.test(barText), String(barText).slice(0, 80));
  const exposed = await pageEval(`typeof window.pi?.openFatalLog === "function" && typeof window.pi?.ackFatalLog === "function"`);
  check("②preload 白名单暴露（open/ack）", exposed === true);

  // ②.5 点「查看日志」真链路（⚠ 会真弹一次日志窗口，测试后请手关）：
  // 注：window.pi 是 contextBridge 只读代理，无法 monkey-patch 捕获返回值（上轮 spy 实测静默无效）——
  // 改验链路完成态：点击 → bar 移除 + run.err.log 改名 .acked（handler 跑完的副作用）；
  // 打开成功与否由 owner 人工确认（修“先 ack 改名再 openPath 旧路径=静默失败”的顺序坑）
  await pageEval(`(() => { [...document.getElementById("fatal-notice-bar").querySelectorAll("span")].find(s => s.textContent.includes("查看")).click(); return 1; })()`);
  await sleep(800);
  const barGone = await pageEval(`!document.getElementById("fatal-notice-bar")`);
  check("②.5 查看日志链路执行（bar 移除）", barGone === true);
  const acked = fs.existsSync(path.join(userData, "run.err.log.acked")) && !fs.existsSync(path.join(userData, "run.err.log"));
  check("③确认语义：run.err.log → .acked（现场保留）", acked);

  // ---- 第二次启动（同 userData）：不应再提示 ----
  try { app.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  killInstance();
  await sleep(600);
  app = await startInstance(userData);
  check("二次启动", await waitCDP());
  await sleep(2000); // 注入窗口期
  const again = await pageEval(`document.getElementById("fatal-notice-bar")?.textContent ?? null`).catch(() => null);
  check("④已确认不再提示", again === null, String(again).slice(0, 40));
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app?.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  killInstance();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
