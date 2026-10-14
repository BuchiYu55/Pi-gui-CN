/**
 * ask_user 提问卡验证（2026-10-08 批次2；同日晚改对话内卡片）：
 * ① PI_GUI_TEST_ASK=1 + ask:testDispatch 模拟工具派发（零 token，走同一 dispatchAskUser 全链路）；
 * ② 卡出现在 #chat 对话流内（非模态、无 .ask-overlay 弹窗）、文案/选项/推荐项排首+徽标；
 * ③ 点推荐项回传 + 卡转已答态（已选留痕、ask-bar 收起）；④ Other 自由作答（按钮+Enter 两路）；
 * ⑤ 坏参数兜底；⑥ 页面 reload 经 ask:pendingList 找回待答卡；⑦ ask-bar 点击滚动定位+闪烁；
 * ⑧ abort 语义靠代码审查（signal 路径不进 UI）。
 * 用法：node tests/verify-ask.mjs（自带实例，端口 9229）
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

/** 最近一张待答卡的状态快照（null=无待答卡） */
const CARD_EXPR = `(() => {
  const pend = [...document.querySelectorAll('#chat .ask-card.pending')];
  const c = pend[pend.length - 1];
  if (!c) return null;
  const opts = [...c.querySelectorAll('.ask-opt')].map(b => ({
    label: b.querySelector('.ask-opt-label')?.textContent ?? '',
    rec: !!b.querySelector('.ask-rec-badge'),
  }));
  return JSON.stringify({
    inChat: !!c.closest('#chat'),
    noOverlay: !document.querySelector('.ask-overlay'),
    question: c.querySelector('.ask-question')?.textContent ?? '',
    context: !!c.querySelector('.ask-context'),
    opts,
    bar: !document.getElementById('ask-bar')?.classList.contains('hidden'),
  });
})()`;

async function waitCard(s, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await s.call(CARD_EXPR).catch(() => null);
    if (v) return JSON.parse(v);
    await sleep(500);
  }
  return null;
}

/** 轮询最近一张卡直到满足 pred（作答链路 IPC 回程与 dispatch promise 解析顺序不保证，终态断言必须轮询） */
async function waitState(s, pred, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const v = JSON.parse((await s.call(LAST_EXPR).catch(() => null)) ?? "null");
    if (v && pred(v)) return v;
    await sleep(300);
  }
  return null;
}

/** 最近一张卡（任意状态）的终态快照 */
const LAST_EXPR = `(() => {
  const cs = [...document.querySelectorAll('#chat .ask-card')];
  const c = cs[cs.length - 1];
  if (!c) return null;
  return JSON.stringify({
    pending: c.classList.contains('pending'),
    answered: c.classList.contains('answered'),
    flash: c.classList.contains('flash'),
    done: c.querySelector('.ask-done')?.textContent ?? '',
    state: c.querySelector('.ask-state')?.textContent ?? '',
    barHidden: document.getElementById('ask-bar')?.classList.contains('hidden'),
  });
})()`;

/** 派发一次提问（不 await），返回 promise 便于与 DOM 操作交错 */
function dispatch(s, params) {
  return s.call(
    `window.pi.askTestDispatch(${JSON.stringify(params)}).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`,
    true,
  );
}

async function waitSessionReady(s) {
  for (let i = 0; i < 30; i++) {
    const st = await s.call(`window.pi.getState().then(s => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) return true;
    await sleep(1000);
  }
  return false;
}

const port = 9229;
const ud = path.join(os.tmpdir(), "pi-gui-ask-" + Date.now());
let s = null;
try {
  s = await launch(port, ud, { PI_GUI_TEST_ASK: "1" });
  check("实例启动（PI_GUI_TEST_ASK=1，端口 " + port + "）", true);

  const ready1 = await waitSessionReady(s);
  check("①前置：主进程会话就绪", ready1);

  const noCard0 = await s.call(CARD_EXPR).catch(() => null);
  const bar0 = await s.call(`document.getElementById('ask-bar').classList.contains('hidden')`);
  check("①初始无待答卡且提醒条隐藏", noCard0 === null && bar0 === true);

  /* ② 卡出现在对话流内 + 推荐项排首 */
  const P2 = dispatch(s, {
    question: "选哪个方案推进？",
    options: [
      { label: "A 先做权限", description: "安全地基优先" },
      { label: "B 先做提问卡", description: "交互频次优先" },
    ],
    recommended: 1,
    context: "两条路线都要做，只是先后",
  });
  const card = await waitCard(s);
  check("②卡出现（pending）", !!card, card ? "" : "null");
  if (card) {
    check("②核心：卡片在 #chat 对话流内（非模态）", card.inChat === true);
    check("②核心：无 .ask-overlay 遮罩", card.noOverlay === true);
    check("②问题文案", card.question === "选哪个方案推进？", card.question);
    check("②背景说明可见", card.context === true);
    check("②两选项", card.opts.length === 2, JSON.stringify(card.opts));
    check("②推荐项排首+徽标", card.opts[0]?.label === "B 先做提问卡" && card.opts[0]?.rec === true, JSON.stringify(card.opts));
    check("②非推荐项无徽标", card.opts[1]?.rec === false);
    check("②待答期间 ask-bar 可见", card.bar === true);
  }

  /* ③ 点推荐项 → 回传 + 卡转已答态 */
  await s.call(`[...document.querySelectorAll('#chat .ask-card.pending .ask-opt')][0].click(); true`);
  const r3 = JSON.parse((await P2) ?? "null");
  check("③点选项回传文本", r3?.content?.[0]?.text === "B 先做提问卡", JSON.stringify(r3?.content?.[0]?.text));
  const st3 = await waitState(s, (v) => v.answered && (v.done ?? "").includes("B 先做提问卡"));
  check("③卡转已答态+留痕", !!st3, JSON.stringify(st3));
  check("③答后 ask-bar 收起", st3?.barHidden === true);

  /* ④ Other 自由作答（按钮路径） */
  const P4 = dispatch(s, { question: "Q4", options: [{ label: "x" }, { label: "y" }] });
  await waitCard(s);
  await s.call(`(() => { const c=[...document.querySelectorAll('#chat .ask-card.pending')].pop(); c.querySelector('.ask-other-input').value='都不选，走 C 方案'; c.querySelector('.ask-other .btn').click(); return true; })()`);
  const r4 = JSON.parse((await P4) ?? "null");
  check("④Other 作答（按钮）", r4?.content?.[0]?.text === "都不选，走 C 方案", JSON.stringify(r4?.content?.[0]?.text));

  /* ⑤ Other 自由作答（Enter 路径） */
  const P5 = dispatch(s, { question: "Q5", options: [{ label: "m" }, { label: "n" }] });
  const card5 = await waitCard(s);
  check("⑤卡再次出现", !!card5);
  await s.call(`(() => { const c=[...document.querySelectorAll('#chat .ask-card.pending')].pop(); const i=c.querySelector('.ask-other-input'); i.value='Enter 提交的答案'; i.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); return true; })()`);
  const r5 = JSON.parse((await P5) ?? "null");
  check("⑤Enter 作答回传", r5?.content?.[0]?.text === "Enter 提交的答案", JSON.stringify(r5?.content?.[0]?.text));

  /* ⑥ 坏参数兜底：options 少于 2 → 兜底选项 */
  const P6 = dispatch(s, { question: "Q6", options: [{ label: "solo" }] });
  const card6 = await waitCard(s);
  check("⑥坏参数兜底两选项", !!card6 && card6.opts.length === 2, card6 ? JSON.stringify(card6.opts) : "null");
  await s.call(`[...document.querySelectorAll('#chat .ask-card.pending .ask-opt')][0].click(); true`);
  const r6 = JSON.parse((await P6) ?? "null");
  check("⑥兜底卡可答", r6?.content?.[0]?.text === "继续", JSON.stringify(r6?.content?.[0]?.text));

  /* ⑦ 页面 reload：ask:pendingList 找回待答卡（ask:request 不重放） */
  const P7 = dispatch(s, { question: "Q7 重载找回", options: [{ label: "p" }, { label: "q" }] });
  P7.catch(() => {}); // reload 销毁 evaluate 上下文，防未处理拒绝
  const card7 = await waitCard(s);
  check("⑦重载前卡在位", !!card7);
  await s.call(`location.reload(); true`).catch(() => {});
  await sleep(1500);
  const ready7 = await waitSessionReady(s);
  check("⑦重载后主进程会话就绪", ready7);
  const card7b = await waitCard(s);
  check("⑦重载后待答卡经 pendingList 找回", !!card7b && card7b.question === "Q7 重载找回", card7b ? card7b.question : "null");
  if (card7b) {
    await s.call(`[...document.querySelectorAll('#chat .ask-card.pending .ask-opt')][0].click(); true`);
    const st7 = await waitState(s, (v) => v.answered && (v.done ?? "").includes("p"));
    check("⑦找回卡可作答（UI 终态）", !!st7, JSON.stringify(st7));
  }

  /* ⑧ ask-bar 点击：滚动定位 + 闪烁 */
  const P8 = dispatch(s, { question: "Q8 定位闪烁", options: [{ label: "u" }, { label: "v" }] });
  await waitCard(s);
  await s.call(`document.getElementById('chat').scrollTop = 0; true`); // 模拟上翻阅读分析
  await s.call(`document.getElementById('ask-bar').click(); true`);
  const st8 = JSON.parse((await s.call(LAST_EXPR).catch(() => null)) ?? "null");
  check("⑧ask-bar 点击定位+闪烁", st8?.flash === true && st8?.pending === true, JSON.stringify(st8));
  await s.call(`[...document.querySelectorAll('#chat .ask-card.pending .ask-opt')][0].click(); true`);
  const r8 = JSON.parse((await P8) ?? "null");
  check("⑧定位卡作答收尾", r8?.content?.[0]?.text === "u", JSON.stringify(r8?.content?.[0]?.text));
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 300));
} finally {
  await stop(s?.app, port, ud);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
