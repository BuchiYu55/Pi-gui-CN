/**
 * 三档权限验证（2026-10-08 zcode 套用批次1）：composer 左下 perm-pill
 * ① 胶囊存在/初始默认档；② 点击弹菜单四项；③ 切计划/切回默认（DOM 态 + 主进程 [perm] 日志）；
 * ④ perm:probe 纯函数判定矩阵（plan 拦四类写工具、read/MCP 不拦、default/full 不拦）；
 * ⑤ state.permSidOk 归属钥匙捕获；⑥ permSetDefault(full) → 新会话继承完全档。
 * 零模型 token：全部走 UI/IPC/日志断言，不发 prompt。
 * 用法：node tests/verify-perm.mjs（自带实例，端口 9227）
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

async function launch(port, userData, extraEnv = {}) {
  fs.mkdirSync(userData, { recursive: true });
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_GUI_CDP_PORT: String(port),
      PI_GUI_USER_DATA: userData,
      PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const pushLog = (d) => logs.push(String(d));
  app.stdout.on("data", pushLog);
  app.stderr.on("data", pushLog);
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

/** 胶囊探针（一次性短表达式） */
const PILL_EXPR = `(() => {
  const p = document.getElementById('perm-pill');
  if (!p) return null;
  return JSON.stringify({
    cls: p.className,
    text: document.getElementById('perm-pill-text')?.textContent ?? '',
    icon: document.getElementById('perm-pill-icon')?.getAttribute('href') ?? '',
    title: p.title ?? '',
  });
})()`;

/** 等胶囊到达预期档（轮询在 node 侧——坑账纪律：页面端不长驻轮询） */
async function waitPill(s, want, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await s.call(PILL_EXPR).catch(() => null);
    const o = v ? JSON.parse(v) : null;
    if (o && o.cls.includes(want)) return o;
    await sleep(500);
  }
  return null;
}

const port = 9227;
const ud = path.join(os.tmpdir(), "pi-gui-perm-" + Date.now());
let s = null;
try {
  s = await launch(port, ud);
  check("实例启动（端口 " + port + "）", true);

  /* ① 初始默认档 */
  let pill = await waitPill(s, "default");
  check("①胶囊存在且初始为默认档", !!pill, pill ? `${pill.cls}|${pill.text}` : "null");
  if (pill) {
    check("①盾形图标+文案", pill.icon === "#i-shield" && pill.text === "默认", `${pill.icon}|${pill.text}`);
    check("①title 含档位说明", pill.title.includes("默认") && pill.title.includes("权限档位"), pill.title);
  }

  /* ② 点击弹菜单 */
  await s.call(`document.getElementById('perm-pill').click(); true`);
  await sleep(400);
  const menu = await s.call(`(() => {
    const m = document.getElementById('ctx-menu');
    if (!m || m.classList.contains('hidden')) return null;
    return JSON.stringify([...m.querySelectorAll('.ctx-item')].map(b => b.textContent));
  })()`).catch(() => null);
  const items = menu ? JSON.parse(menu) : null;
  check("②点击弹出菜单", !!items, menu ?? "null");
  if (items) {
    check("②菜单含三档+默认档入口（4 项）", items.length === 4 && items.some(t => t.includes("计划")) && items.some(t => t.includes("默认")) && items.some(t => t.includes("完全")) && items.some(t => t.includes("新会话默认档")), JSON.stringify(items));
    check("②当前档打勾标记", items.find(t => t.includes("默认"))?.startsWith("✓"), JSON.stringify(items));
  }

  /* ③ 切计划档（点菜单第一项） */
  await s.call(`(() => {
    const m = document.getElementById('ctx-menu');
    [...m.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('计划')).click();
    return true;
  })()`);
  pill = await waitPill(s, "plan");
  check("③切计划档：胶囊更新", !!pill && pill.text === "计划" && pill.icon === "#i-plan", pill ? `${pill.cls}|${pill.text}` : "null");
  await sleep(300);
  check("③主进程 [perm] 日志（IPC 真到达）", s.logs.join("").includes("[perm]"), s.logs.join("").split("\n").filter(l => l.includes("[perm]")).pop() ?? "无");

  /* ④ probe 判定矩阵（纯函数，与 __piGuardGate 内核同源） */
  const probe = async (mode, tool) => {
    const v = await s.call(`window.pi.permProbe(${JSON.stringify(mode)}, ${JSON.stringify(tool)}).then(r => JSON.stringify(r ?? null))`, true).catch(() => "ERR");
    return v === "ERR" ? null : JSON.parse(v);
  };
  check("④plan+write 拦截", (await probe("plan", "write"))?.block === true);
  check("④plan+edit 拦截", (await probe("plan", "edit"))?.block === true);
  check("④plan+bash 拦截", (await probe("plan", "bash"))?.block === true);
  check("④plan+powershell 拦截", (await probe("plan", "powershell"))?.block === true);
  check("④plan 拦截话术含切档指引", String((await probe("plan", "write"))?.reason ?? "").includes("计划模式"));
  check("④plan+read 放行", (await probe("plan", "read")) === null);
  check("④plan+grep 放行", (await probe("plan", "grep")) === null);
  check("④plan+MCP 工具放行", (await probe("plan", "mcp__web_search__search")) === null);
  check("④default+write 交回路径守卫", (await probe("default", "write")) === null);
  check("④full+write 不拦", (await probe("full", "write")) === null);
  check("④非法档位容错", (await probe("hacker", "write")) === null);

  /* ⑤ 归属钥匙捕获 */
  const st = await s.call(`window.pi.getState().then(r => JSON.stringify({ mode: r.permMode, sidOk: r.permSidOk }))`, true).catch(() => null);
  const stO = st ? JSON.parse(st) : null;
  check("⑤state.permMode 同步主进程档位", stO?.mode === "plan", st ?? "null");
  check("⑤piSessionId 归属钥匙捕获成功", stO?.sidOk === true, st ?? "null");

  /* ⑥ 默认档继承：设 full → 新会话 → 胶囊显示完全 */
  await s.call(`window.pi.permSetDefault('full').then(r => JSON.stringify(r))`, true);
  const defBack = await s.call(`window.pi.permGetDefault().then(r => String(r))`, true).catch(() => null);
  check("⑥默认档写入并可读回", defBack === "full", String(defBack));
  // 新会话：点侧栏「新会话」按钮，等 #welcome 就绪（坑账：点新会话后等视图重建完成信号）
  await s.call(`document.getElementById('btn-new-session').click(); true`);
  let welcomed = false;
  for (let i = 0; i < 20; i++) {
    const w = await s.call(`!!document.getElementById('welcome')`).catch(() => false);
    if (w) { welcomed = true; break; }
    await sleep(500);
  }
  check("⑥新会话视图就绪", welcomed);
  pill = await waitPill(s, "full");
  check("⑥新会话继承默认档=完全", !!pill && pill.text === "完全" && pill.icon === "#i-bolt", pill ? `${pill.cls}|${pill.text}` : "null");

  /* 切回默认档收尾（菜单第三项），证明往返切换 */
  await s.call(`document.getElementById('perm-pill').click(); true`);
  await sleep(300);
  await s.call(`(() => {
    const m = document.getElementById('ctx-menu');
    [...m.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('默认') && !b.textContent.includes('新会话')).click();
    return true;
  })()`);
  pill = await waitPill(s, "default");
  check("⑦切回默认档", !!pill && pill.text === "默认", pill ? `${pill.cls}|${pill.text}` : "null");
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 300));
} finally {
  await stop(s?.app, port, ud);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
