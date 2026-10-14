/**
 * B1 disposeEntry 超时预算验证（2026-10-07 优化计划 B 批次）：
 *   PI_GUI_TEST_HANG_DISPOSE=1 起 GUI 测试实例（主进程测试钩子：dispose 永挂）→
 *   CDP Browser.close 触发优雅退出 → 断言：
 *   ① 总退出耗时 < 2.5s（800ms 预算生效，弃 entry 继续）；
 *   ② run.err.log 有 [dispose-timeout] 指认 entry（会话 id/耗时/文件）。
 * 自闭环：独立 userData + 端口 9240，结束自杀清场（按端口归属杀）。
 * 用法：node tests/verify-b1.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9240;
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
function procAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const userData = path.join(os.tmpdir(), "pi-gui-b1-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null;
let logs = [];
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_TEST_SHOW: "1", PI_GUI_USER_DATA: userData, PI_GUI_TEST_HANG_DISPOSE: "1", PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));
  check("实例启动（钩子：dispose 永挂）", await waitCDP());

  // --- CDP 工具 ---
  const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
  let page = (await list()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const call = (expr) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e6) | 1;
    const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener("message", onMsg); res(d.result?.result?.value); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 15000);
  });
  const ps = (args, opts = {}) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(ROOT, "tests", "verify-trayclose-winctl.ps1"), ...args],
    { encoding: "utf8", ...opts }).trim();

  // --- 真任务（短消息）→ 确认框 → 点「仍然退出」（Browser.close 会被 close 拦截器吃掉驻留托盘，走不通）---
  await call(`(() => { window.__b1 = { start: false }; const off = window.pi.onEvent((e) => { if (e && e.type === "agent_start") window.__b1.start = true; }); return "hooked"; })()`);
  await call(`window.pi.prompt(${JSON.stringify("只回复两个字母：ok")}).catch(() => {}); "sent"`);
  let running = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if ((await call("window.__b1.start")) === true) { running = true; break; }
  }
  check("任务进入运行态（真实模型回合）", running);

  // 主进程 pid 用 CDP 端口 OwningProcess 定位（app.pid 是 node 包装层，不猜父子链，AGENTS 纪律）
  let mainPid = 0;
  for (let i = 0; i < 10; i++) {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1`],
        { encoding: "utf8" }).trim();
      const p = parseInt(out, 10);
      if (p > 0) { mainPid = p; break; }
    } catch { /* 未起 */ }
    await sleep(400);
  }
  check("electron 主进程 pid 就位（端口归属）", mainPid > 0, String(mainPid));

  let hwnd = 0;
  for (let i = 0; i < 10; i++) {
    const h = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${mainPid}).MainWindowHandle`], { encoding: "utf8" }).trim();
    if (h && h !== "0") { hwnd = Number(h); break; }
    await sleep(300);
  }
  check("主窗口 hwnd 就位", hwnd > 0, String(hwnd));

  ps(["close", String(hwnd)]);
  await sleep(1200);
  const dlg = ps(["dialogs", "", String(mainPid)], { maxBuffer: 1 << 20 });
  const dlgLines = dlg ? dlg.split(/\r?\n/).filter(Boolean) : [];
  check("× 弹出确认框（任务运行中）", dlgLines.length > 0, dlgLines[0] ?? "无对话框");

  let buttons = [];
  if (dlgLines.length > 0) {
    const h = Number(dlgLines[0].split("|")[0]);
    const btn = ps(["buttons", String(h)], { maxBuffer: 1 << 20 });
    buttons = btn ? btn.split(/\r?\n/).filter(Boolean).map((l) => {
      const [bh, ...rest] = l.split("|");
      return { hwnd: Number(bh), text: rest.join("|") };
    }) : [];
  }
  const quitBtn = buttons.find((b) => b.text.includes("退出"));
  check("找到「仍然退出」按钮", !!quitBtn, buttons.map((b) => b.text).join(" / "));

  const quitAt = Date.now();
  if (quitBtn) ps(["clickbtn", String(quitBtn.hwnd)]);

  // 轮询进程退出（node 侧），测真实耗时（从点「仍然退出」起算）
  let exitedAt = null;
  for (let i = 0; i < 20; i++) {
    if (!procAlive(app.pid)) { exitedAt = Date.now(); break; }
    await sleep(250);
  }
  const elapsed = exitedAt ? exitedAt - quitAt : null;
  check("①钩子下进程仍能退出（弃 entry 继续）", exitedAt !== null);
  check("②总退出耗时 < 2.5s（800ms 预算生效）", elapsed !== null && elapsed < 2500, elapsed + "ms");

  // 等日志落盘稳定后读 run.err.log
  await sleep(600);
  const errLogPath = path.join(userData, "run.err.log");
  let errText = "";
  try { errText = fs.readFileSync(errLogPath, "utf8"); } catch { /* 无文件 */ }
  const m = errText.match(/\[dispose-timeout\][^\n]*/);
  check("③run.err.log 指认凶手 entry", !!m && /entry=s\d/.test(m[0]), (m ? m[0] : "无记录").slice(0, 120));

  const lifecycle = logs.join("").includes("entries disposed, quitting");
  check("④优雅链路走完（allSettled 后 quit）", lifecycle);
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app?.kill(); } catch { /* 端口法兜底 */ }
  await sleep(300);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 端口已释放即目标态 */ }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
