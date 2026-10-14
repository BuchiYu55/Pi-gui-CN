/**
 * A1 bundle 新鲜度守卫验证（2026-10-07）：
 *  ①bundle 新鲜 → 无警告条；②touch app.js 晚于 bundle → ⚠ 警告条出现；
 *  ③bundle 缺失 → 警告条出现且文案指认缺失。
 * 自闭环：自起测试实例（独立 userData + CDP 9228，避开 9223-9227 常用段），每个用例全新实例，结束自杀清场。
 * 杀进程按端口 OwningProcess 定位（不猜父子链）；stdout 管道保持开放（关闭会 EPIPE 杀死无头实例）；
 * DOM 探针全部 node 侧一次性 Runtime.evaluate（隐藏窗口页面端长轮询永不 resolve，见 AGENTS 账）。
 * 用法：node verify-bundleguard.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // tests/ 的上一级 = 仓库根
const PORT = 9228;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? "  [" + info + "]" : ""}`);
};

let proc = null;
let procLogs = [];
const APP_JS = path.join(ROOT, "renderer", "app.js");
let origAppMtime = null; // touch 前的 mtime，finally 复位——否则每次跑完都把源弄脏，owner 下次启动误报（2026-10-07 两次实咬）

async function startInstance(label) {
  const userData = path.join(os.tmpdir(), "pi-gui-bundleguard-" + Date.now());
  fs.mkdirSync(userData, { recursive: true });
  procLogs = [];
  proc = spawn(process.execPath, [
    path.join(ROOT, "node_modules", "electron", "cli.js"), ".",
  ], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"], // 管道保持开放：spawner stdout 关闭会 EPIPE 杀死无头实例
  });
  proc.stdout.on("data", (d) => procLogs.push(String(d)));
  proc.stderr.on("data", (d) => procLogs.push(String(d)));
  proc.on("error", (e) => procLogs.push("[spawn-error] " + e.message));
  return userData;
}

async function killInstance() {
  if (!proc) return;
  try { proc.kill(); } catch { /* 端口法兜底 */ }
  // 按端口归属 PID 强杀兜底（不按进程名，绝不误伤 owner 主实例）
  await sleep(300);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction Stop).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 端口已释放即目标态 */ }
  proc = null;
  await sleep(300);
}

async function cdpEval(expr, { awaitPromise = false } = {}) {
  const listRes = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page CDP target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
  const result = await new Promise((res, rej) => {
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; /* CDP 回包必为 JSON，非 JSON 忽略等待下一条 */ }
      if (msg.id === 1) {
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result?.result?.value); // evaluate 结果在 result.result.value 两层
      }
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
  });
  ws.close();
  return result;
}

async function waitCDP(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return; }
    } catch { /* 未起 */ }
    await sleep(300);
  }
  throw new Error("CDP 端口等待超时");
}

/** node 侧轮询 DOM 探针（一次性 evaluate，禁页面端长驻轮询） */
async function waitFor(fn, desc, timeoutMs = 30000) {
  const t0 = Date.now();
  let last = undefined;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await cdpEval(`(${fn.toString()})()`);
      if (last) return last;
    } catch { /* 页面未就绪 */ }
    await sleep(400);
  }
  throw new Error(`轮询超时：${desc}（last=${JSON.stringify(last)}）`);
}

const barProbe = () => {
  const el = document.getElementById("bundle-stale-bar");
  return el ? el.textContent : null;
};

try {
  // ---- 前置：确保 bundle 存在且新鲜（改动 app.js 必须 build 的铁律之外，守卫测试需要干净基线）----
  execFileSync("node", [path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
    "renderer/app.js", "--bundle", "--format=iife", "--outfile=renderer/app.bundle.js"],
    { cwd: ROOT, stdio: "pipe" });
  check("esbuild 重建 bundle", fs.existsSync(path.join(ROOT, "renderer", "app.bundle.js")));

  // ---- 用例①：新鲜 bundle → 无警告条 ----
  await startInstance("fresh");
  await waitCDP();
  await waitFor(() => document.readyState === "complete" && !!document.body, "页面就绪");
  await sleep(1200); // did-finish-load 注入窗口期
  const noBar = await cdpEval(`(() => { const el = document.getElementById("bundle-stale-bar"); return el ? el.textContent : null; })()`);
  check("①新鲜 bundle 无警告条", noBar === null, String(noBar).slice(0, 60));

  // ---- 用例②：app.js 比 bundle 新 → 警告条出现 ----
  await killInstance();
  const bundleM = fs.statSync(path.join(ROOT, "renderer", "app.bundle.js")).mtimeMs;
  const future = new Date(bundleM + 10000);
  origAppMtime = fs.statSync(APP_JS).mtime; // 先存原值
  fs.utimesSync(APP_JS, future, future); // touch：源比 bundle 新 10s
  await startInstance("stale");
  await waitCDP();
  const barText = await waitFor(barProbe, "警告条出现");
  check("②源新 bundle 旧 → 警告条出现", /不是最新|新/.test(barText), barText.slice(0, 80));

  // ---- 用例③：bundle 缺失 → 警告条指认缺失 ----
  await killInstance();
  fs.renameSync(path.join(ROOT, "renderer", "app.bundle.js"), path.join(ROOT, "renderer", "app.bundle.js.bak-guard"));
  await startInstance("missing");
  await waitCDP();
  const missText = await waitFor(barProbe, "缺失警告条");
  check("③bundle 缺失 → 警告条指认不存在", /不存在/.test(missText), missText.slice(0, 80));

  // logFatal 落盘验证（用例②③实例的 userData 各有 run.err.log）
  // userData 路径在 startInstance 内部生成，这里从最近一次实例的日志找 bundle-stale 痕迹
  const logged = procLogs.join("").includes("bundle-stale");
  check("logFatal 落痕（主进程 stdout 含 bundle-stale）", logged);
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 300));
} finally {
  await killInstance();
  try { fs.renameSync(path.join(ROOT, "renderer", "app.bundle.js.bak-guard"), path.join(ROOT, "renderer", "app.bundle.js")); } catch { /* 未改名过 */ }
  // 现场复位：还原 app.js mtime（不还原则守卫误报——源被 touch 到未来）
  try {
    if (origAppMtime) fs.utimesSync(APP_JS, origAppMtime, origAppMtime);
    const clean = fs.statSync(APP_JS).mtimeMs <= fs.statSync(path.join(ROOT, "renderer", "app.bundle.js")).mtimeMs;
    check("⑥现场复位（app.js mtime 还原，不留误报源）", clean);
  } catch (e) { check("⑥现场复位（app.js mtime 还原，不留误报源）", false, String(e?.message ?? e)); }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
