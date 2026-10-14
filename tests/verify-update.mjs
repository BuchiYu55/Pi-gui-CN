/**
 * 更新提示胶囊验证（2026-10-08）：logo 右侧 update-pill
 * 阶段① PI_GUI_TEST_UPDATE=9.9.9 强制路径：胶囊出现 / 版本号 / title / 点击复制 / 1.6s 恢复；
 * 阶段② 真实路径（无钩子，全新 userData 真查 npm registry）：getUpdateState 返回 current=本机 pi 版本、
 *        无更新（latest=同版本或网络失败 null）时胶囊必须保持隐藏。
 * 用法：node tests/verify-update.mjs（自带两阶段实例，无需预先启动）
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

/** 起一个测试实例并返回 { app, page }，page 提供 CDP evaluate */
async function launch(port, userData, extraEnv) {
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

/** 胶囊状态探针（一次性短表达式，轮询在 node 侧——AGENTS 坑账纪律） */
const PILL_EXPR = `(() => {
  const p = document.getElementById('update-pill');
  if (!p) return null;
  return JSON.stringify({
    hidden: p.classList.contains('hidden'),
    ver: p.querySelector('.update-pill-ver')?.textContent ?? '',
    copied: p.classList.contains('copied'),
    cmd: p.dataset.cmd ?? '',
    title: p.title ?? '',
  });
})()`;

try {
  /* ---------- 阶段①：测试钩子 9.9.9 ---------- */
  const port1 = 9225;
  const ud1 = path.join(os.tmpdir(), "pi-gui-upd1-" + Date.now());
  let s1 = null;
  try {
    s1 = await launch(port1, ud1, { PI_GUI_TEST_UPDATE: "9.9.9" });
    check("①实例启动（钩子 9.9.9）", true);

    let shown = null;
    for (let i = 0; i < 25; i++) { // 主进程 4s 后才检测，轮询等胶囊出现
      const v = await s1.call(PILL_EXPR).catch(() => null);
      const o = v ? JSON.parse(v) : null;
      if (o && !o.hidden) { shown = o; break; }
      await sleep(1200);
    }
    check("①胶囊出现（.hidden 移除）", !!shown);
    if (shown) {
      check("①版本号 v9.9.9", shown.ver === "v9.9.9", shown.ver);
      check("①title 提示升级路径", shown.title.includes("9.9.9") && shown.title.includes("复制"), shown.title);
      check("①dataset.cmd 升级命令", shown.cmd === "npm install -g @earendil-works/pi-coding-agent@9.9.9", shown.cmd);
    }

    // 点击 → 已复制态 → 1.6s 后恢复
    await s1.call(`document.getElementById('update-pill').click(); true`);
    await sleep(600);
    const after = JSON.parse((await s1.call(PILL_EXPR)) || "null");
    check("①点击后显示已复制", !!after && after.copied && after.ver.includes("已复制"), after?.ver ?? "null");
    let restored = null;
    for (let i = 0; i < 6; i++) {
      await sleep(600);
      const o = JSON.parse((await s1.call(PILL_EXPR)) || "null");
      if (o && !o.copied && o.ver === "v9.9.9") { restored = o; break; }
    }
    check("①1.6s 后恢复版本号态", !!restored);
  } finally {
    await stop(s1?.app, port1, ud1);
  }

  /* ---------- 阶段②：真实 npm 路径（无钩子，全新 userData） ---------- */
  const port2 = 9226;
  const ud2 = path.join(os.tmpdir(), "pi-gui-upd2-" + Date.now());
  let s2 = null;
  try {
    s2 = await launch(port2, ud2, {});
    check("②实例启动（真实路径）", true);

    // 等主进程检测完成（4s 延迟 + npm 网络耗时），轮询 getUpdateState 直到 current 就位且 latest 检测已跑过
    let st = null;
    for (let i = 0; i < 25; i++) {
      const v = await s2.call(`window.pi.getUpdateState().then(s => JSON.stringify(s)).catch(e => 'ERR:' + e.message)`, true).catch(() => null);
      if (v && !v.startsWith("ERR")) {
        const o = JSON.parse(v);
        if (o && o.current) { st = o; if (o.latest !== null) break; } // current 是同步真值；latest null 可能是还没查完，拿到非 null 或轮询耗尽再断言
      }
      await sleep(1200);
    }
    check("②getUpdateState 返回 current", !!st && typeof st.current === "string", st ? `current=${st.current} latest=${st.latest}` : "null");
    if (st?.latest === null) console.log("⚠ latest=null（npm 出站未通或超时，胶囊按无更新处理——属预期容错路径）");
    else check("②latest 为真实 npm 值", /^[0-9]+\.[0-9]+\.[0-9]+$/.test(st?.latest ?? ""), st?.latest);

    // 无论 latest 真值如何：与 current 同版（或 null）时胶囊必须隐藏
    await sleep(1500);
    const pill = JSON.parse((await s2.call(PILL_EXPR)) || "null");
    check("②胶囊保持隐藏（当前已是最新）", !!pill && pill.hidden === true);
  } finally {
    await stop(s2?.app, port2, ud2);
  }
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 300));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
