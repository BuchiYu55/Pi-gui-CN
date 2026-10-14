/**
 * 取消轮 chip + 工具耗时 durationMs 验证（2026-10-08 Q1/Q2/Q7/Q8，1.1.0 事件新字段）
 * 流程：① 真实工具回合（bash echo）→ 工具卡「完成 · Xs」（官方 durationMs）；
 *      ② reload 回放 → 卡片「历史 · Xs」（toolResult 落盘 durationMs 回填，旧会话则无后缀）；
 *      ③ 新一轮立即点停止 → agent_settled(aborted=true) → 轮末 chip 灰化 + 「已取消 ·」前缀。
 * 成本：两条百 token 级消息（第③条在首 token 前即停）。
 * 用法：node tests/verify-abortdur.mjs（自带实例 9230，独立 userData + TEST_CWD）
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9230;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const userData = path.join(os.tmpdir(), "pi-gui-abortdur-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null, logs = [];
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));

  let ok = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) { ok = true; break; } } } catch {}
    await sleep(500);
  }
  check("实例启动", ok, ok ? "" : logs.join("").slice(-300));
  if (!ok) throw new Error("CDP 未就绪");

  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let n = 1;
  const call = (expr, awaitPromise = false) => new Promise((res, rej) => {
    const id = n++;
    const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener("message", onMsg); res(d.result?.result?.value); } } catch {} };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 20000);
  });

  // ① 真实工具回合（先等 welcome：新会话 startSession 异步重建会清输入，早到即吞——AGENTS 坑）
  for (let i = 0; i < 15; i++) {
    const w = await call(`!!document.getElementById('welcome')`).catch(() => false);
    if (w) break;
    await sleep(1000);
  }
  await sleep(800);
  await call(`(() => { const i = document.getElementById('input'); i.value = '请用 bash 工具运行 echo verify-dur，然后只回复 ok'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  let liveStatus = "";
  for (let i = 0; i < 50; i++) {
    await sleep(1500);
    const v = await call(`(() => { const els = [...document.querySelectorAll('.tool-card.done .tool-status')]; return els.length ? els[els.length-1].textContent : ''; })()`).catch(() => "");
    if (v.includes("·")) { liveStatus = v; break; }
  }
  check("①工具卡实时耗时（官方 durationMs）", /完成.* · [\d.]+m?s$/.test(liveStatus), JSON.stringify(liveStatus));

  // ② reload 回放
  await call(`location.reload(); true`).catch(() => {});
  await sleep(4000);
  let replayStatus = "";
  for (let i = 0; i < 10; i++) {
    const v = await call(`(() => { const els = [...document.querySelectorAll('.tool-card.done .tool-status')]; return els.length ? els[els.length-1].textContent : ''; })()`).catch(() => "");
    if (v) { replayStatus = v; break; }
    await sleep(1500);
  }
  check("②回放卡片耗时回填", /历史.* · [\d.]+m?s$/.test(replayStatus), JSON.stringify(replayStatus));

  // ③ 取消轮：发长任务立即停止（reload 后同样先等会话就绪）
  for (let i = 0; i < 10; i++) {
    const noW = await call(`!document.getElementById('welcome') && !!document.getElementById('input')`).catch(() => false);
    if (noW) break;
    await sleep(1000);
  }
  await sleep(800);
  await call(`(() => { const i = document.getElementById('input'); i.value = '请仔细写一篇 800 字的散文'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  // 等 assistant 开始输出（curMsg 建立）再停：首 token 前取消无 assistant 内容，chip 本就不出（既有语义）；
  // 回放后 .msg-assist ant已有第①轮历史，先取基数等增量，别拿历史当新输出
  const baseMsgs = Number(await call(`document.querySelectorAll('.msg-assistant').length`).catch(() => 0)) || 0;
  let speaking = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const v = await call(`document.querySelectorAll('.msg-assistant').length`).catch(() => 0);
    if (Number(v) > baseMsgs) { speaking = true; break; }
  }
  check("③前置：assistant 已开始输出", speaking);
  await call(`document.getElementById('btn-abort').click(); true`);
  let chip = null;
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const v = await call(`(() => { const c = document.querySelector('.turn-chip.aborted'); return c ? JSON.stringify({ cls: c.className, text: c.textContent }) : null; })()`).catch(() => null);
    if (v) { chip = JSON.parse(v); break; }
  }
  check("③取消轮 chip 灰化 + 前缀", !!chip && chip.text.includes("已取消"), chip ? JSON.stringify(chip) : "未见 chip");
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
