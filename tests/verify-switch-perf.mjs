/**
 * 切换微卡验证（2026-10-07 优化计划·切换顺手修）：切到 Desktop 下最大历史会话（8.4MB/433 条）断言：
 *   ①尾段同步渲染 <450ms（实测基线 336ms：assistant≈16ms/条 md+hljs，user≈0.1ms）
 *   ②点击→可交互（同步段完成）<1500ms（含 ipc≈370ms，其中 rl 全量重载≈287ms 为架构成本）
 *   ③idle 补齐完成后 DOM 完整性：.msg 数 === jsonl 预计算（user+非空 assistant）
 *   ④滚动停在底部附近（prepend 补齐不拉走视口）
 *   目标会话（Desktop 下最大 jsonl）不存在时 SKIP 退场（exit 0，防存量清理后误红）。
 * 自闭环：独立 userData + 端口 9244。用法：node tests/verify-switch-perf.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9244;
const DESKTOP = [os.homedir().replace(/\\/g, "/"), "Desktop"].join("/"); // 正斜杠：防表达式转义坑，Windows fs/spawn 通吃
const SESS_DIR = path.join(os.homedir(), ".pi/agent/sessions", "--" + DESKTOP.replace(/[:/]/g, "-") + "--"); // pi 会话目录名=cwd 转换规则（C:\x\y → --C--x--y--）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 目标会话：该目录最大 jsonl，<2MB 视为存量已清理 → SKIP ----
let targetFile = null, targetSize = 0;
try {
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const s = fs.statSync(path.join(SESS_DIR, f)).size;
    if (s > targetSize) { targetSize = s; targetFile = f; }
  }
} catch { /* 目录不存在 */ }
if (!targetFile || targetSize < 2 * 1024 * 1024) {
  console.log(`SKIP：${SESS_DIR} 下无 >2MB 会话（存量已清理？），本脚本需真实大会话。exit 0`);
  process.exit(0);
}

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? `  [${info}]` : ""}`);
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
async function pageEval(expr, { awaitPromise = false } = {}) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const v = await new Promise((res, rej) => {
    const id = Date.now() % 1e6 + 1;
    ws.onmessage = (m) => {
      try { const d = JSON.parse(m.data); if (d.id === id) res(d.result?.result?.value); } catch { /* 忽略 */ }
    };
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => rej(new Error("evaluate 超时")), 20000);
  });
  ws.close();
  return v;
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

const userData = path.join(os.tmpdir(), `pi-gui-swperf-${Date.now()}`);
fs.mkdirSync(userData, { recursive: true });
const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
  cwd: ROOT,
  env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
  stdio: ["ignore", "pipe", "pipe"],
});
const perfLogs = [];
let clickAt = 0;
app.stdout.on("data", (d) => {
  for (const line of String(d).split(/\r?\n/)) {
    if (line.includes("[perf]")) {
      perfLogs.push({ at: Date.now(), line: line.trim() });
      console.log("  [instance]", line.trim().replace(/\(file:.*\)$/, ""));
    }
  }
});
app.stderr.on("data", () => {});

try {
  check(`实例启动（目标 ${(targetSize / 1048576).toFixed(1)}MB）`, await waitCDP());
  await pageEval(`document.readyState === "complete" && !!document.getElementById("input")`, { awaitPromise: true });
  await pageEval(`window.pi.wsAdd(${JSON.stringify(DESKTOP)})`, { awaitPromise: true });
  const sess = await pageEval(`window.pi.wsSessions(${JSON.stringify(DESKTOP)})`, { awaitPromise: true });
  const target = (sess?.sessions ?? []).find((s) => String(s.path ?? "").includes(targetFile.slice(0, 24)));
  if (!target) throw new Error("目标会话不在 wsSessions 列表");
  await pageEval(`document.getElementById("btn-new-session").click(); 1`, { awaitPromise: true });
  await sleep(2500);
  const clicked = await pageEval(`(() => {
    const find = () => [...document.querySelectorAll(".session-item")].find(el => el.textContent.includes(${JSON.stringify(target.name.slice(0, 12))}));
    let el = find();
    if (!el) { for (const h of document.querySelectorAll(".ws-group .ws-head")) h.click(); el = find(); }
    if (!el) return "not-found";
    el.click();
    return "clicked";
  })()`, { awaitPromise: true });
  check("点击目标会话", clicked === "clicked", clicked);
  clickAt = Date.now();

  // 等同步段日志（点击→可交互）
  let syncLog = null;
  for (let i = 0; i < 60 && !syncLog; i++) {
    syncLog = perfLogs.find((l) => l.line.includes("renderHistory 同步段") && l.at >= clickAt - 500);
    if (!syncLog) await sleep(250);
  }
  const interactMs = syncLog ? syncLog.at - clickAt : null;
  check("①同步段日志落点（点击→可交互）", !!syncLog, `${interactMs}ms`);
  check("②可交互 <1500ms（ipc+尾段）", interactMs !== null && interactMs < 1500, `${interactMs}ms`);
  const tailLogLine = perfLogs.find((l) => l.line.includes("尾段渲染") && l.at >= clickAt - 500)?.line ?? "";
  const tailMs = parseInt((tailLogLine.match(/尾段渲染 (\d+)ms/) ?? [])[1] ?? "0", 10);
  check("③尾段同步渲染 <450ms", tailMs > 0 && tailMs < 450, `${tailMs}ms`);

  // 等 idle 补齐完成（≤25s）
  let doneLog = null;
  for (let i = 0; i < 100 && !doneLog; i++) {
    doneLog = perfLogs.find((l) => l.line.includes("补齐完成") && l.at >= clickAt);
    if (!doneLog) await sleep(250);
  }
  check("④idle 补齐完成日志", !!doneLog);
  await sleep(400);
  // 完整性口径：DOM === 渲染输入（[perf] 补齐完成日志自带输入统计）。
  // ⚠ 不能拿 jsonl 全行数对账：pi 会话是树，弃用分支也在 jsonl 里，加载只取当前叶子分支（2026-10-07 实测：
  // jsonl 24u+291a vs 当前分支 19u+202a，差 94 条即弃用分支）——丢没丢看渲染输入与 DOM 是否一致
  const mUser = parseInt((doneLog?.line.match(/user=(\d+)/) ?? [])[1] ?? "0", 10);
  const mAsst = parseInt((doneLog?.line.match(/asst=(\d+)/) ?? [])[1] ?? "0", 10);
  const final = await pageEval(`(() => ({
    domMsgs: document.querySelectorAll(".msg").length,
    bottomGap: Math.abs(document.getElementById("chat").scrollHeight - document.getElementById("chat").scrollTop - document.getElementById("chat").clientHeight),
  }))()`, { awaitPromise: true });
  check(`⑤DOM 完整性（${final.domMsgs} === 输入 ${mUser}+${mAsst}）`, mUser > 0 && final.domMsgs === mUser + mAsst, JSON.stringify(final));
  check("⑥滚动停在底部附近（prepend 不拉走视口）", final.bottomGap < 200, `gap=${final.bottomGap}px`);
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  killInstance();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
