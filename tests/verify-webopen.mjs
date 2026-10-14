import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitCDP(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; } } catch {}
    await sleep(400);
  }
  return false;
}
const port = 9270;
const ud = path.join(os.tmpdir(), "pi-gui-wo-" + Date.now());
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
await sleep(2500);
const s0 = JSON.parse(await call(`(() => {
  const b = document.getElementById("btn-web-open");
  const v = document.getElementById("viewer");
  const r = b.getBoundingClientRect();
  return JSON.stringify({ exists: !!b, visible: r.width > 0 && r.height > 0, viewerHidden: v.classList.contains("hidden") });
})()`));
check("①侧栏浏览器入口常显（查看器关着也可见）", s0.exists && s0.visible && s0.viewerHidden, JSON.stringify(s0));
await call(`document.getElementById("btn-web-open").click(); true`);
await sleep(800);
const s1 = JSON.parse(await call(`(() => {
  const v = document.getElementById("viewer");
  const i = document.getElementById("web-new-input");
  return JSON.stringify({ viewerOpen: !v.classList.contains("hidden"), inputVisible: i && !i.classList.contains("hidden"), focused: document.activeElement === i });
})()`));
check("②点击开查看器壳+弹地址条", s1.viewerOpen && s1.inputVisible, JSON.stringify(s1));
check("③地址条聚焦（输入直达）", s1.focused === true, String(s1.focused));
// Esc 收起再关壳回归
await call(`(() => { const i = document.getElementById("web-new-input"); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
await sleep(300);
const s2 = await call(`!document.getElementById("web-new-input").classList.contains("hidden")`);
check("④Esc 收地址条", s2 === false, String(s2));
try { app.kill(); } catch {}
await sleep(400);
try {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) { const pid = parseInt(line.trim(), 10); if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
} catch {}
try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
