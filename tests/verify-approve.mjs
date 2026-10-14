/**
 * E2.1 /approve 计划审批验证（2026-10-11 计划书 A 案）：
 * ① slash 菜单含 /approve 条目；② 计划档下输入 /approve 回车 → 切回默认档 + 自动首条被截流记录
 * （__approveTestHook 替身，零 token——真实链路里 doSend(follow) 与手打发送同路）；
 * ③ 非计划档调用零动作只提示（不切档不发首条）；④ 直输 /approve 走本地拦截不烧 token
 * （doSend 拦截分支消费输入，不进 prompt 通道——对齐 /compact /rename 家族）。
 * 用法：node tests/verify-approve.mjs [端口]（默认 9253，smoke 传独立端口）
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function waitCDP(port, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; }
    } catch { /* 未起 */ }
    await sleep(400);
  }
  return false;
}

async function launch(port, userData) {
  fs.mkdirSync(userData, { recursive: true });
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(port), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));
  if (!(await waitCDP(port))) throw new Error("CDP 未就绪：" + logs.join("").slice(-400));
  const list = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const page = (await list()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open 失败")); });
  let n = 1;
  const call = (expr, awaitPromise = false) => new Promise((res, rej) => {
    const id = n++;
    const onMsg = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.id !== id) return;
        ws.removeEventListener("message", onMsg);
        res(d.result?.result?.value);
      } catch { /* 忽略坏帧 */ }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 20000);
  });
  return { app, call, logs };
}

async function stop(app, port, userData) {
  try { app?.kill(); } catch { /* 端口法兜底 */ }
  await sleep(400);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 端口已释放即目标态 */ }
  await sleep(300);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const PILL_CLS = `document.getElementById('perm-pill')?.className ?? ""`;

/** 等胶囊到达预期档（轮询在 node 侧——坑账纪律：页面端不长驻轮询） */
async function waitPill(s, want, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const cls = (await s.call(PILL_CLS).catch(() => "")) ?? "";
    if (cls.includes(want)) return cls;
    await sleep(500);
  }
  return null;
}

const port = parseInt(process.argv[2] ?? "9253", 10);
const ud = path.join(os.tmpdir(), "pi-gui-approve-" + Date.now());
let s = null;
try {
  s = await launch(port, ud);
  check("实例启动（端口 " + port + "）", true);

  // ① slash 菜单含 /approve 条目（等 loadCommands 就绪：先等 state 首推，再等菜单渲染出动作项）
  const pill0 = await waitPill(s, "default"); // state 就绪（pickPerm 需要 sessionId）
  check("①胶囊初始默认档（state 就绪）", !!pill0, pill0 ?? "null");
  // 派发输入事件（IIFE 隔离作用域：Runtime.evaluate 顶层 const 持久进全局，重声明会静默 SyntaxError）
  const typeSlash = (v) => s.call(`(() => { const el = document.getElementById('input'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await typeSlash("/");
  let menuOk = false;
  for (let i = 0; i < 20 && !menuOk; i++) {
    await sleep(500);
    menuOk = await s.call(`(() => {
      const items = [...document.querySelectorAll('#slash-menu .slash-item .slash-label')].map(x => x.textContent);
      return items.includes('/approve');
    })()`) === true;
    if (!menuOk) await typeSlash("/"); // loadCommands 未就绪时菜单空——重派发 input 让其重渲
  }
  check("①slash 菜单含 /approve", menuOk === true);
  // 清空必须派发 input 事件让 updateSlashMenu 收菜单（只改 value 不派发=菜单残留，后续 Enter 会被 pickSlash 吃掉）
  await typeSlash("");
  await sleep(300);

  // ② 计划档：经 perm-pill 菜单切到计划档（复用 verify-perm 的 UI 路径）
  await s.call(`document.getElementById('perm-pill').click(); true`);
  await sleep(400);
  await s.call(`(() => {
    const m = document.getElementById('ctx-menu');
    const item = [...m.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('计划'));
    if (item) item.click();
    return !!item;
  })()`);
  const pill = await waitPill(s, "plan");
  check("②已切到计划档", !!pill, pill ?? "null");

  // ③ 挂截流钩子 → 输入 /approve 回车 → 切回默认档 + 自动首条被记录
  await s.call(`window.__approveSent = null; window.__approveTestHook = (t) => { window.__approveSent = t; }; true`);
  await s.call(`(() => { const el = document.getElementById('input'); el.value = '/approve'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  const pillBack = await waitPill(s, "default");
  check("③/approve 切回默认档", !!pillBack, pillBack ?? "null");
  let sent = await s.call(`window.__approveSent`);
  check("③自动首条内容正确", sent === "按计划执行，从步骤 1 开始。", String(sent));

  // ④ 非计划档再调：零动作（档位保持、首条不变）
  await s.call(`document.getElementById('input').value = '/approve'; document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(800);
  const cls = await s.call(PILL_CLS);
  sent = await s.call(`window.__approveSent`);
  check("④非计划档零动作（档位不变）", typeof cls === "string" && cls.includes("default"), cls);
  check("④非计划档不发首条", sent === "按计划执行，从步骤 1 开始。", String(sent));

  // ⑤ 输入已被拦截消费（不残留 /approve 文本进模型通道）
  const inputVal = await s.call(`document.getElementById('input').value`);
  check("⑤/approve 输入被本地拦截消费", inputVal === "", JSON.stringify(inputVal));
} catch (err) {
  check("脚本执行", false, String(err?.message ?? err));
} finally {
  await stop(s?.app, port, ud);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
