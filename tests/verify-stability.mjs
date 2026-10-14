/**
 * B2 渲染进程崩溃自愈验证（2026-10-07 优化计划 B 批次）：
 *   CDP Page.crash() 真崩渲染进程 → 断言：
 *   ①自动 reload（welcome/输入框回归）②crash-recover-bar 出现且文案正确
 *   ③侧栏骨架完整（#free-sessions/#ws-groups 在）④点 × 可关 ⑤再 reload 不复现（一次性）。
 * 自闭环：独立 userData + 端口 9241；崩溃后 CDP 会断连，全部轮询在 node 侧重连探测。
 * 用法：node tests/verify-stability.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9241;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? "  [" + info + "]" : ""}`);
};

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
async function waitCDP(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await targets();
    if (t.some((x) => x.type === "page" && x.webSocketDebuggerUrl)) return true;
    await sleep(300);
  }
  return false;
}
function cdpWs() {
  return new Promise(async (res) => {
    const t = await targets();
    const page = t.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
    if (!page) return res(null);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onopen = () => res(ws);
    ws.onerror = () => res(null);
  });
}
function evalOn(ws, expr, { awaitPromise = false } = {}) {
  return new Promise((res, rej) => {
    const id = Date.now() % 1e6 + 1;
    const onMsg = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.id === id) { ws.removeEventListener("message", onMsg); res(d.result?.result?.value); }
      } catch { /* 忽略 */ }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 10000);
  });
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

const userData = path.join(os.tmpdir(), "pi-gui-b2-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null;
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", () => {});
  app.stderr.on("data", () => {});
  check("实例启动", await waitCDP());

  let ws = await cdpWs();
  check("初始就绪（welcome/输入框）", (await evalOn(ws, `!!document.getElementById("welcome") && !!document.getElementById("input")`)) === true);

  // 真崩：Page.crash() —— 渲染进程终止，ws 断开，主进程 render-process-gone → reload
  await new Promise((res) => {
    ws.onclose = () => res();
    ws.send(JSON.stringify({ id: 999, method: "Page.crash" }));
    setTimeout(res, 4000);
  });
  check("Page.crash 已发出（ws 断开）", true);

  // reload 后重连探测（node 侧轮询）
  let bar = null, ready = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const w2 = await cdpWs();
    if (w2) {
      try {
        const r = await evalOn(w2, `(() => ({ ready: !!document.getElementById("input"), bar: document.getElementById("crash-recover-bar")?.textContent ?? null, free: !!document.querySelector("#free-sessions"), groups: !!document.getElementById("ws-groups") }))()`);
        if (r && r.ready) {
          ready = true;
          bar = r;
          w2.close();
          break;
        }
      } catch { /* 页面尚在恢复 */ }
      w2.close();
    }
    await sleep(500);
  }
  check("①崩溃后自动 reload（输入区回归）", ready);
  check("②恢复提示条出现", !!bar?.bar && /自动恢复/.test(bar.bar), String(bar?.bar ?? "").slice(0, 50));
  check("③侧栏骨架完整（free/ws-groups）", !!bar?.free && !!bar?.groups);

  // ④点 × 关闭；⑤无崩溃再 reload 不复现
  const w3 = await cdpWs();
  await evalOn(w3, `document.querySelector("#crash-recover-bar span").click(); "clicked"`);
  const closed = await evalOn(w3, `!document.getElementById("crash-recover-bar")`);
  check("④提示条可手动关闭", closed === true);
  await evalOn(w3, `location.reload(); "reloading"`);
  await sleep(2500);
  const w4 = await cdpWs();
  const reappear = await evalOn(w4, `!!document.getElementById("crash-recover-bar")`);
  check("⑤无崩溃的 reload 不复现（一次性）", reappear === false);
  w4.close();
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app?.kill(); } catch { /* 兜底 */ }
  await sleep(300);
  killInstance();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
