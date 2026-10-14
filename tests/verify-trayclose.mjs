/**
 * 后台常驻 + 关闭确认验证（2026-10-06）：
 *  ①托盘就绪 ②无任务点×→最小化到托盘、进程驻留 ③second-instance（点桌面图标）唤回隐藏窗口
 *  ④有任务点×→原生确认框拦截、任务不中断 ⑤确认框三按钮文案 ⑥点「取消」窗口恢复
 *  ⑦任务在驻留取消后正常跑完（.msg-assistant 出现 + running 转 false）
 * 自闭环：自起测试实例（独立 userData + CDP 9225，避开常用 9223/9224），结束自杀清场；
 * 主进程 pid 用 CDP 端口 OwningProcess 定位（不猜父子链，符合「杀 electron 前验归属」纪律）。
 * 窗口关闭用真 WM_CLOSE、确认框按钮用真 BM_CLICK（verify-trayclose-winctl.ps1）。
 * 用法：node verify-trayclose.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = "9225";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), ".."); // tests/ 上一级 = 仓库根（electron cwd）；ps1 与本脚本同目录
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = path.join(os.tmpdir(), "pi-gui-trayclose-" + Date.now());
fs.mkdirSync(userData, { recursive: true });

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? "  [" + info + "]" : ""}`);
};

const logChunks = [];
let app = null;
let mainPid = null;
let hwnd = 0;

const logHas = (s) => logChunks.join("\n").includes(s);

function ps(args, opts = {}) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^[\/]([A-Za-z]:)/, "$1"), "verify-trayclose-winctl.ps1"), ...args],
    { encoding: "utf8", ...opts }
  ).trim();
}
function psCmd(cmd) {
  return execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/i.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

async function main() {
  // ---- 起测试实例 ----
  app = spawn("cmd", ["/c", "node_modules\\.bin\\electron.cmd", "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: PORT, PI_GUI_TEST_SHOW: "1", PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => logChunks.push(d));
  app.stderr.on("data", (d) => logChunks.push(d));
  console.log("测试实例 cmd pid:", app.pid, "userData:", userData);

  const target = await findTarget();
  console.log("CDP target:", target.title);

  // CDP evaluate 封装
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  for (let i = 0; i < 30; i++) {
    if (await call("window.pi ? 'ready' : 'no'") === "ready") break;
    await sleep(1000);
  }
  await sleep(1500);

  // 主进程 pid：CDP 端口归属（不猜父子链）
  for (let i = 0; i < 10; i++) {
    const pid = psCmd(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -First 1).OwningProcess`);
    if (pid) { mainPid = Number(pid); break; }
    await sleep(500);
  }
  if (!mainPid) throw new Error("未定位到主进程 pid（CDP 端口无 listener）");
  const alive = () => psCmd(`if (Get-Process -Id ${mainPid} -ErrorAction SilentlyContinue) { '1' } else { '0' }`) === "1";
  console.log("electron 主进程 pid:", mainPid);

  // ---- ① 托盘就绪 ----
  check("① 托盘创建就绪（日志）", logHas("[tray] 托盘就绪"));

  // ---- ② 无任务点 × → 驻留 ----
  for (let i = 0; i < 10; i++) {
    const h = psCmd(`(Get-Process -Id ${mainPid}).MainWindowHandle`);
    if (h && h !== "0") { hwnd = Number(h); break; }
    await sleep(500);
  }
  if (!hwnd) throw new Error("未取到主窗口句柄");
  ps(["close", String(hwnd)]);
  await sleep(1500);
  const hidden = ps(["visible", String(hwnd)]) === "0";
  check("② 无任务×：窗口隐藏", hidden);
  check("② 无任务×：进程驻留不退出", alive());
  check("② 无任务×：走驻留日志分支", logHas("最小化到托盘"));

  // ---- ③ second-instance 唤回（模拟点桌面图标）----
  const _second = spawn("cmd", ["/c", "node_modules\\.bin\\electron.cmd", "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_USER_DATA: userData }, // 同 userData 才触发单实例锁；无 CDP 端口
    stdio: "ignore",
  });
  // 二实例 electron 启动到送达 second-instance 需数秒，轮询等唤回
  let restored = false;
  for (let i = 0; i < 30 && !restored; i++) {
    await sleep(500);
    restored = ps(["visible", String(hwnd)]) === "1";
  }
  check("③ 二次启动：隐藏窗口被唤回", restored);
  check("③ 二次启动：原实例存活（焦点切换非重启）", alive());

  // ---- ④ 有任务点 × → 确认框拦截 ----
  // 事件探针：agent_start/settled 必发（CDP awaitPromise 会把 prompt 等到回合结束，状态轮询抓不到窗口）
  await call(`(() => { window.__tc = { seenStart: false, seenSettled: false };
    window.pi.onEvent(e => { if (e.type === "agent_start") window.__tc.seenStart = true; if (e.type === "agent_settled") window.__tc.seenSettled = true; });
    return "hooked"; })()`);
  await call(`window.pi.prompt(${JSON.stringify("只回复两个字母：ok")}).catch(() => {}); "sent"`); // fire-and-forget
  let running = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    running = (await call("window.__tc.seenStart")) === true;
    if (running) break;
  }
  check("④ 任务进入运行态（真实模型回合）", running);
  ps(["close", String(hwnd)]);
  await sleep(1200);
  const dlg = ps(["dialogs", "", String(mainPid)], { maxBuffer: 1 << 20 });
  const dlgLines = dlg ? dlg.split(/\r?\n/).filter(Boolean) : [];
  check("④ 有任务×：原生确认框弹出", dlgLines.length > 0, dlgLines[0] ?? "no dialog");
  check("④ 有任务×：主窗口未被关闭（拦截生效）", ps(["visible", String(hwnd)]) === "1");
  const stillRunning = (await call("(await window.pi.getState()).running || window.__tc.seenStart && !window.__tc.seenSettled")) === true;
  check("④ 有任务×：任务未被打断", stillRunning);

  // ---- ⑤ 确认框按钮文案 ----
  let buttons = [];
  if (dlgLines.length > 0) {
    const h = Number(dlgLines[0].split("|")[0]);
    const btn = ps(["buttons", String(h)], { maxBuffer: 1 << 20 });
    buttons = btn ? btn.split(/\r?\n/).filter(Boolean).map((l) => {
      const [bh, ...rest] = l.split("|");
      return { hwnd: Number(bh), text: rest.join("|") };
    }) : [];
  }
  check("⑤ 确认框三按钮（驻留/退出/取消）", buttons.length === 3, buttons.map((b) => b.text).join(" / "));

  // ---- ⑥ 点「取消」→ 框关窗留 ----
  const cancelBtn = buttons.find((b) => b.text.includes("取消")) ?? buttons[buttons.length - 1];
  if (cancelBtn) ps(["clickbtn", String(cancelBtn.hwnd)]);
  await sleep(1000);
  const dlgGone = ps(["dialogs", "", String(mainPid)], { maxBuffer: 1 << 20 }) === "";
  check("⑥ 取消：确认框关闭", dlgGone);
  check("⑥ 取消：主窗口保持可见", ps(["visible", String(hwnd)]) === "1");

  // ---- ⑦ 任务在「取消」后正常跑完 ----
  let done = false, assistantText = "";
  for (let i = 0; i < 90 && !done; i++) {
    await sleep(1000);
    assistantText = (await call("document.querySelector('.msg-assistant')?.textContent ?? ''")) ?? "";
    if (assistantText.trim() && (await call("window.__tc.seenSettled")) === true) done = true;
  }
  check("⑦ 任务跑完未中断（assistant 消息落盘渲染 + settled）", done, JSON.stringify(assistantText.trim().slice(0, 30)));

  ws.close();
  const pass = checks.every((c) => c.pass);
  console.log(pass ? `\n✅ 全部 ${checks.length} 项通过` : `\n❌ ${checks.filter((c) => !c.pass).length} 项未通过`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error("验证失败:", e.message);
  console.error("---- 实例日志尾部 ----\n" + logChunks.join("").slice(-2000));
  process.exitCode = 1;
}).finally(() => {
  if (mainPid) {
    try { execFileSync("taskkill", ["/PID", String(mainPid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
  } else if (app && app.pid) {
    try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
  }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 占用残留，留给系统临时目录 */ }
});
