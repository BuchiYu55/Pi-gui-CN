import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
const ROOT = "E:/pi-gui";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitCDP(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; } } catch {}
    await sleep(400);
  }
  return false;
}
const port = 9271;
const ud = path.join(os.tmpdir(), "pi-gui-sb-" + Date.now());
fs.mkdirSync(ud, { recursive: true });
const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
  cwd: ROOT,
  env: { ...process.env, PI_GUI_CDP_PORT: String(port), PI_GUI_USER_DATA: ud, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
  stdio: ["ignore", "pipe", "pipe"],
});
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); ok ? pass++ : fail++; };
if (!(await waitCDP(port))) { console.log("CDP 未就绪"); process.exit(1); }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let n = 1;
const call = (expr, awaitPromise = false) => new Promise((res) => {
  const id = n++;
  const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id !== id) return; ws.removeEventListener("message", onMsg); res(d.result?.result?.value); } catch {} };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
  setTimeout(() => { ws.removeEventListener("message", onMsg); res("<timeout>"); }, 20000);
});
await sleep(3000); // init 完成（含初始 renderSidebarTree 数次）
const base = await call(`window.__sideRenders ?? 0`);
await call(`(() => { window.__renderSidebarTreeSoon(); window.__renderSidebarTreeSoon(); window.__renderSidebarTreeSoon(); window.__renderSidebarTreeSoon(); window.__renderSidebarTreeSoon(); return true; })()`);
await sleep(120);
const mid = await call(`window.__sideRenders ?? 0`);
await sleep(400);
const done = await call(`window.__sideRenders ?? 0`);
check("①防抖窗口内零执行（150ms 未到）", Number(mid) === Number(base), `base=${base} mid=${mid}`);
check("②尾沿只执行一次（5 次调用合并 1 次重建）", Number(done) === Number(base) + 1, `base=${base} done=${done}`);
try { app.kill(); } catch {}
await sleep(400);
try {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) { const pid = parseInt(line.trim(), 10); if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
} catch {}
try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
